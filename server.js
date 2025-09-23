// server.js
// Twilio Voice Webhook + Media Streams + WAV + OpenAI Whisper + stabiles Turn-Taking

const express = require("express");
const twilio = require("twilio");
const http = require("http");
const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");
const { FileWriter } = require("wav");
const OpenAI = require("openai");

const app = express();

// ---------- ENV & Clients ----------
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

let twilioClient = null;
function getTwilioClient() {
  if (twilioClient) return twilioClient;
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) {
    console.warn("TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN nicht gesetzt – Antworten per Say sind deaktiviert.");
    return null;
  }
  twilioClient = twilio(sid, token);
  return twilioClient;
}

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Begrüßung per Env steuerbar
const GREETING = process.env.GREETING || "Willkommen bei Croque Sylt. Einen Moment, ich verbinde Sie.";

// ---------- TwiML ----------
function buildTwiml() {
  const vr = new twilio.twiml.VoiceResponse();
  vr.say({ voice: "Polly.Marlene", language: "de-DE" }, GREETING);
  vr.pause({ length: 1 });

  const c = vr.connect();
  c.stream({
    // >>> ggf. Render-URL anpassen:
    url: "wss://croque-bot.onrender.com/media",
    track: "inbound_track",
    statusCallback: "https://croque-bot.onrender.com/ms-status",
    statusCallbackMethod: "POST",
  });

  return vr.toString();
}

// ---------- HTTP ----------
app.get("/", (_req, res) => res.send("OK - Croque Bot läuft (Media Streams)"));
app.get("/incoming-call", (_req, res) => res.type("text/xml").send(buildTwiml()));
app.post("/incoming-call", (req, res) => {
  const callSid = req.body?.CallSid;
  console.log("Incoming call:", callSid);
  const twiml = buildTwiml();
  console.log("TwiML sent:\n", twiml);
  res.type("text/xml").send(twiml);
});
app.post("/ms-status", (req, res) => {
  console.log("MS Status:", req.body);
  res.sendStatus(204);
});

const server = http.createServer(app);
server.on("upgrade", (req) => console.log("HTTP upgrade requested:", req.url));

// ---------- WebSocket ----------
const wss = new WebSocket.Server({ server, path: "/media" });

// µ-law → PCM16
function muLawToPcm16(uVal) {
  uVal = ~uVal & 0xff;
  const sign = (uVal & 0x80) ? -1 : 1;
  const exponent = (uVal >> 4) & 0x07;
  const mantissa = uVal & 0x0F;
  let magnitude = ((mantissa << 3) + 0x84) << exponent;
  magnitude -= 0x84;
  let sample = sign * magnitude;
  if (sample > 32767) sample = 32767;
  if (sample < -32768) sample = -32768;
  return sample;
}
function decodeMuLawBuffer(buf) {
  const out = Buffer.alloc(buf.length * 2);
  for (let i = 0; i < buf.length; i++) out.writeInt16LE(muLawToPcm16(buf[i]), i * 2);
  return out;
}
const SAMPLE_RATE = 8000;

// XML-Escape
function escapeXml(s = "") {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Sprechdauer grob schätzen (für Cooldown)
function estimateSayMs(text) {
  const chars = (text || "").length;
  const cps = 12; // Zeichen pro Sekunde grob
  const speakMs = Math.max(800, Math.round((chars / cps) * 1000));
  return speakMs + 400; // kleine Pause
}

// Sprechen + Stream neu starten
async function sayToCaller(callSid, text) {
  const client = getTwilioClient();
  if (!client) { console.warn("Kein Twilio-Client -> sayToCaller übersprungen"); return false; }

  const replyTwiml =
`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Marlene" language="de-DE">${escapeXml(text)}</Say>
  <Pause length="0.5"/>
  <Connect>
    <!-- >>> ggf. Render-URL anpassen: -->
    <Stream url="wss://croque-bot.onrender.com/media" track="inbound_track"
            statusCallback="https://croque-bot.onrender.com/ms-status"
            statusCallbackMethod="POST"/>
  </Connect>
</Response>`;

  console.log(`[sayToCaller] update call ${callSid} with:`, text);
  await client.calls(callSid).update({ twiml: replyTwiml });
  console.log("[sayToCaller] OK (calls.update)");
  return true;
}

// WAV schreiben
function writeWav(filepath, pcmBuffer, sampleRate) {
  return new Promise((resolve, reject) => {
    try {
      const writer = new FileWriter(filepath, { channels: 1, sampleRate, bitDepth: 16 });
      writer.on("finish", resolve);
      writer.on("error", reject);
      writer.write(pcmBuffer);
      writer.end();
    } catch (err) { reject(err); }
  });
}

// Whisper
async function transcribeWithOpenAI(wavPath) {
  if (!process.env.OPENAI_API_KEY) { console.warn("Kein OPENAI_API_KEY – skip STT"); return ""; }
  try {
    console.log("Sende an OpenAI Whisper…");
    const resp = await openai.audio.transcriptions.create({
      file: fs.createReadStream(wavPath),
      model: "whisper-1",
      language: "de",
      response_format: "verbose_json",
      temperature: 0,
    });
    return resp.text || "";
  } catch (err) {
    console.error("OpenAI Whisper Fehler:", err?.response?.data || err);
    return "";
  }
}

// ---------- Ruhiges Turn-Taking ----------
// Schwellen großzügiger, damit nicht dauernd unterbrochen wird:
const SILENCE_MS     = 1200;  // 1,2 s Pause = Turn-Ende
const MIN_AUDIO_MS   = 1500;  // min. 1,5 s zusammenhängendes Audio
const MAX_LISTEN_MS  = 8000;  // spätestens nach 8 s erzwungener Turn
const INITIAL_ACK_ON_FIRST_TURN = true; // nur im ersten Turn des Calls
const SPEAK_COOLDOWN_PAD_MS = 700;      // kleine Zusatzpause nach <Say>

wss.on("connection", (ws, req) => {
  console.log("WS connection attempt:", req.url, "headers:", req.headers);
  console.log("Media Stream verbunden");

  // Pro-Call-Zustand
  let callSid = null;
  let turnIndex = 0;               // 0 = erster Turn
  let hasInitialAcked = false;     // initiale Bestätigung nur einmal pro Call

  // Pro-Stream/Turn-Zustand
  let pcmChunks = [];
  let mediaCount = 0;
  let firstPacketAt = 0;
  let lastPacketAt = 0;
  let silenceTimer = null;
  let maxListenTimer = null;
  let processing = false;
  let closed = false;

  // Cooldown nach unserer Ansage (wir ignorieren Kundenaudio, damit wir ihn nicht „bargen“)
  let speakCooldownUntil = 0;

  function clearTimer(t) { if (t) clearTimeout(t); }
  function clearAllTimers() { clearTimer(silenceTimer); clearTimer(maxListenTimer); silenceTimer = maxListenTimer = null; }
  function resetSilenceTimer() { clearTimer(silenceTimer); silenceTimer = setTimeout(onSilenceTimeout, SILENCE_MS); }
  function armMaxListenTimer() { clearTimer(maxListenTimer); maxListenTimer = setTimeout(onForcedTurn, MAX_LISTEN_MS); }

  async function onSilenceTimeout() {
    if (processing || closed) return;
    const dur = (lastPacketAt && firstPacketAt) ? (lastPacketAt - firstPacketAt) : 0;
    if (dur < MIN_AUDIO_MS || pcmChunks.length === 0) return;
    console.log("[VAD] silence timeout -> processTurn");
    await processTurn("silence");
  }
  async function onForcedTurn() {
    if (processing || closed) return;
    const dur = (Date.now() - (firstPacketAt || Date.now()));
    if (dur < MIN_AUDIO_MS || pcmChunks.length === 0) return;
    console.log("[VAD] forced turn -> processTurn");
    await processTurn("forced");
  }

  async function processTurn(reason) {
    processing = true;
    console.log(`[VAD] processTurn start (${reason}) turn=${turnIndex}`);

    try {
      // 1) Erst im allerersten Turn: kurze Bestätigung (einmal pro Call)
      if (INITIAL_ACK_ON_FIRST_TURN && !hasInitialAcked && callSid) {
        const ackText = "Einen Moment, ich verarbeite das.";
        try {
          const ok = await sayToCaller(callSid, ackText);
          if (ok) {
            hasInitialAcked = true;
            // Schätze Dauer, setze Cooldown
            speakCooldownUntil = Date.now() + estimateSayMs(ackText) + SPEAK_COOLDOWN_PAD_MS;
          }
        } catch (err) {
          if (err?.code === 21220) console.warn("Call nicht aktiv (21220) – initiale Bestätigung übersprungen.");
          else console.error("Fehler bei Bestätigungsansage:", err);
        }
      }

      // 2) Audio zu WAV & STT
      const wavPath = path.join("/tmp", `turn_${Date.now()}_${reason}.wav`);
      await writeWav(wavPath, Buffer.concat(pcmChunks), SAMPLE_RATE);
      console.log(`TURN (${reason}) WAV:`, wavPath, `(${Math.round((lastPacketAt - firstPacketAt) || 0)}ms)`);

      const transcript = await transcribeWithOpenAI(wavPath);
      console.log("TURN Transkript:", transcript);

      // 3) Inhaltliche Antwort
      if (callSid) {
        const reply = transcript
          ? `Ich habe verstanden: ${transcript}. Was möchten Sie genau bestellen?`
          : `Ich habe Sie nicht gut verstanden. Was möchten Sie bestellen?`;

        try {
          const ok = await sayToCaller(callSid, reply);
          if (ok) {
            speakCooldownUntil = Date.now() + estimateSayMs(reply) + SPEAK_COOLDOWN_PAD_MS;
          }
        } catch (err) {
          if (err?.code === 21220) console.warn("Call nicht aktiv (21220) – inhaltliche Antwort übersprungen.");
          else console.error("Fehler bei inhaltlicher Antwort:", err);
        }
      }
    } catch (e) {
      console.error("Fehler im Turn-Handling:", e);
    } finally {
      // Reset für nächsten Turn (neuer Stream folgt unmittelbar nach sayToCaller)
      pcmChunks = [];
      firstPacketAt = 0;
      lastPacketAt = 0;
      processing = false;
      clearAllTimers();
      turnIndex += 1;
      console.log("[VAD] processTurn done; await next stream");
    }
  }

  ws.on("message", async (msg) => {
    let data;
    try { data = JSON.parse(msg.toString()); } catch (e) { console.error("WS parse error:", e); return; }

    switch (data.event) {
      case "connected":
        console.log("WS connected");
        break;

      case "start":
        callSid = data.start?.callSid || callSid || "unknown";
        console.log("Stream start:", callSid, data.start?.streamSid);
        // Wenn wir gerade gesprochen haben, ignoriere Kundenaudio bis Cooldown abgelaufen
        break;

      case "media": {
        const now = Date.now();
        if (now < speakCooldownUntil) {
          // Wir haben gerade gesprochen → dieser Audio-Input wird ignoriert, um Barge-In zu verhindern
          if (mediaCount % 50 === 0) console.log(`[VAD] ignoring media during speakCooldown (until ${speakCooldownUntil})`);
          mediaCount++;
          break;
        }

        mediaCount++;
        const mu = Buffer.from(data.media?.payload || "", "base64");
        const pcm = decodeMuLawBuffer(mu);
        pcmChunks.push(pcm);

        if (!firstPacketAt) {
          firstPacketAt = now;
          armMaxListenTimer();
        }
        lastPacketAt = now;

        // Nur wenn wir nicht im Cooldown sind, wird Stille getrackt
        resetSilenceTimer();

        if (mediaCount % 100 === 0) console.log(`media packets: ${mediaCount}`);
        break;
      }

      case "stop":
        console.log("Stream stop. Total media packets:", mediaCount);
        clearAllTimers();

        // Falls noch etwas im Buffer liegt und wir nicht gerade transkribieren: einmal verarbeiten
        if (!processing && pcmChunks.length > 0) {
          await onSilenceTimeout();
        }
        break;

      default:
        console.log("WS event:", data.event);
    }
  });

  ws.on("close", (code, reason) => {
    closed = true;
    clearAllTimers();
    console.log("Media Stream getrennt", code, reason?.toString?.());
  });
  ws.on("error", (err) => {
    closed = true;
    clearAllTimers();
    console.error("WS error:", err);
  });
});

// ---------- Start ----------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Bot läuft auf Port ${PORT}`));
