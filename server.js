// server.js
// Twilio Voice Webhook + Media Streams + WAV + OpenAI Whisper
// Stabileres Turn-Taking: echte Stille-Erkennung (RMS), kaum erzwungene Turns, Call-übergreifender Zustand

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

// Per-Call Zustand über Streams hinweg
// callStates: CallSid -> { turnIndex, hasInitialAcked, speakCooldownUntil }
const callStates = new Map();

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

// Einfache Energie/VAD: Rahmen als Stimme, wenn RMS > THRESH
function frameIsVoice(pcm, thresh = 700) { // 0..32767
  if (!pcm || pcm.length < 2) return false;
  let sumSq = 0;
  let count = 0;
  for (let i = 0; i < pcm.length; i += 2) {
    const s = pcm.readInt16LE(i);
    sumSq += s * s;
    count++;
  }
  const rms = Math.sqrt(sumSq / Math.max(1, count));
  return rms > thresh;
}

// XML-Escape
function escapeXml(s = "") {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function estimateSayMs(text) {
  const cps = 12;
  const t = Math.max(800, Math.round((text.length / cps) * 1000));
  return t + 400;
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
// Großzügige Schwellen => weniger Unterbrechungen
const SILENCE_MS     = 1200;   // 1,2 s echte Stille -> Turn-Ende
const MIN_AUDIO_MS   = 1500;   // min. 1,5 s Audio, bevor Turn gültig
const MAX_LISTEN_MS  = 30000;  // 30 s Fallback (praktisch selten)
const INITIAL_ACK_ON_FIRST_TURN = false; // standardmäßig AUS (nicht unterbrechen)
const SPEAK_COOLDOWN_PAD_MS = 700;       // kleine Zusatzpause nach <Say>

wss.on("connection", (ws, req) => {
  console.log("WS connection attempt:", req.url, "headers:", req.headers);
  console.log("Media Stream verbunden");

  // Pro-Stream-Zustand
  let callSid = null;
  let pcmChunks = [];
  let mediaCount = 0;
  let firstPacketAt = 0;
  let lastSpeechAt = 0; // Zeitstempel letzter als "Voice" erkannter Frame
  let voiceAccumMs = 0; // akkumulierte "Voice"-Zeit in diesem Turn

  let silenceTimer = null;
  let maxListenTimer = null;
  let processing = false;
  let closed = false;

  function clearTimer(t) { if (t) clearTimeout(t); }
  function clearAllTimers() { clearTimer(silenceTimer); clearTimer(maxListenTimer); silenceTimer = maxListenTimer = null; }

  function resetSilenceTimer() {
    clearTimer(silenceTimer);
    silenceTimer = setTimeout(onSilenceTimeout, SILENCE_MS);
  }
  function armMaxListenTimer() {
    clearTimer(maxListenTimer);
    maxListenTimer = setTimeout(onForcedTurn, MAX_LISTEN_MS);
  }

  async function onSilenceTimeout() {
    if (processing || closed) return;
    const dur = lastSpeechAt && firstPacketAt ? (lastSpeechAt - firstPacketAt) : 0;
    if (dur < MIN_AUDIO_MS || pcmChunks.length === 0) return;
    console.log("[VAD] silence timeout -> processTurn");
    await processTurn("silence");
  }
  async function onForcedTurn() {
    if (processing || closed) return;
    const dur = Date.now() - (firstPacketAt || Date.now());
    if (dur < MIN_AUDIO_MS || pcmChunks.length === 0) return;
    console.log("[VAD] forced turn -> processTurn");
    await processTurn("forced");
  }

  async function processTurn(reason) {
    processing = true;

    // Per-Call-State holen/erzeugen
    const state = callStates.get(callSid) || { turnIndex: 0, hasInitialAcked: false, speakCooldownUntil: 0 };
    console.log(`[VAD] processTurn start (${reason}) callTurn=${state.turnIndex}`);

    try {
      // 1) Optional: initiale Kurzbestätigung nur EINMAL im ganzen Call
      if (INITIAL_ACK_ON_FIRST_TURN && !state.hasInitialAcked && callSid) {
        const ackText = "Einen Moment, ich verarbeite das.";
        try {
          const ok = await sayToCaller(callSid, ackText);
          if (ok) {
            state.hasInitialAcked = true;
            state.speakCooldownUntil = Date.now() + estimateSayMs(ackText) + SPEAK_COOLDOWN_PAD_MS;
          }
        } catch (err) {
          if (err?.code === 21220) console.warn("Call nicht aktiv (21220) – initiale Bestätigung übersprungen.");
          else console.error("Fehler bei Bestätigungsansage:", err);
        }
      }

      // 2) Audio zu WAV & STT
      const wavPath = path.join("/tmp", `turn_${Date.now()}_${reason}.wav`);
      await writeWav(wavPath, Buffer.concat(pcmChunks), SAMPLE_RATE);
      console.log(`TURN (${reason}) WAV: ${wavPath} (voice ~${Math.round(voiceAccumMs)}ms)`);

      const transcript = await transcribeWithOpenAI(wavPath);
      console.log("TURN Transkript:", transcript);

      // 3) Inhaltliche Antwort
      if (callSid) {
        const reply = transcript
          ? `Ich habe verstanden: ${transcript}. Was möchten Sie genau bestellen?`
          : `Ich habe Sie nicht gut verstanden. Was möchten Sie bestellen?`;
        try {
          const ok = await sayToCaller(callSid, reply);
          if (ok) state.speakCooldownUntil = Date.now() + estimateSayMs(reply) + SPEAK_COOLDOWN_PAD_MS;
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
      mediaCount = 0;
      firstPacketAt = 0;
      lastSpeechAt = 0;
      voiceAccumMs = 0;

      processing = false;
      clearAllTimers();

      state.turnIndex += 1;
      callStates.set(callSid, state);
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

      case "start": {
        callSid = data.start?.callSid || callSid || "unknown";
        console.log("Stream start:", callSid, data.start?.streamSid);

        // Per-Call-State anlegen, falls neu
        if (!callStates.has(callSid)) {
          callStates.set(callSid, { turnIndex: 0, hasInitialAcked: false, speakCooldownUntil: 0 });
        }
        break;
      }

      case "media": {
        const state = callStates.get(callSid) || { turnIndex: 0, hasInitialAcked: false, speakCooldownUntil: 0 };
        const now = Date.now();

        // Während wir sprechen -> Kundenaudio ignorieren, damit kein Barge-In/Unterbrechen
        if (now < state.speakCooldownUntil) {
          mediaCount++;
          if (mediaCount % 100 === 0) {
            console.log(`[VAD] ignoring media during speakCooldown (until ${state.speakCooldownUntil})`);
          }
          break;
        }

        // Normaler Empfang
        mediaCount++;
        const mu = Buffer.from(data.media?.payload || "", "base64");
        const pcm = decodeMuLawBuffer(mu);
        if (!firstPacketAt) {
          firstPacketAt = now;
          armMaxListenTimer();
        }

        // Stimme ja/nein?
        const isVoice = frameIsVoice(pcm, 700);
        if (isVoice) {
          // Nur bei Stimme zählen und Stille-Timer zurücksetzen
          pcmChunks.push(pcm);
          lastSpeechAt = now;
          resetSilenceTimer();
          voiceAccumMs += 20; // Twilio packt ~20ms pro Mediapaket
        } else {
          // Stille: Timer NICHT resetten, keine PCM-Append
        }

        if (mediaCount % 200 === 0) console.log(`media packets: ${mediaCount} (voice ~${voiceAccumMs}ms)`);
        break;
      }

      case "stop":
        console.log("Stream stop. Total media packets:", mediaCount);
        clearAllTimers();

        // Falls wir noch nicht verarbeitet haben und genug Stimme gesammelt wurde
        const dur = lastSpeechAt && firstPacketAt ? (lastSpeechAt - firstPacketAt) : 0;
        if (!processing && pcmChunks.length > 0 && dur >= MIN_AUDIO_MS) {
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
