// server.js
// Twilio Voice Webhook + Media Streams + WAV + OpenAI Whisper + Turn-Taking

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

// Twilio-Client lazy initialisieren (App crasht nicht, wenn ENV fehlt)
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

// ---------- Middleware ----------
app.use(express.urlencoded({ extended: false })); // Twilio form POSTs
app.use(express.json());                          // für Status-Callbacks / JSON

// Begrüßung per Env steuerbar
const GREETING =
  process.env.GREETING ||
  "Willkommen bei Croque Sylt. Einen Moment, ich verbinde Sie.";

// ---------- TwiML erzeugen: kurze Ansage + 1s Pause + MediaStream ----------
function buildTwiml() {
  const twiml = new twilio.twiml.VoiceResponse();

  twiml.say({ voice: "Polly.Marlene", language: "de-DE" }, GREETING);
  twiml.pause({ length: 1 }); // Hobby/Free-Pläne brauchen manchmal 1s zum Aufwachen

  const connect = twiml.connect();
  connect.stream({
    // >>> HIER ggf. deine Render-URL einsetzen <<<
    url: "wss://croque-bot.onrender.com/media",
    track: "inbound_track",
    // absolute URL!
    statusCallback: "https://croque-bot.onrender.com/ms-status",
    statusCallbackMethod: "POST",
  });

  return twiml.toString();
}

// ---------- Healthcheck ----------
app.get("/", (_req, res) => res.send("OK - Croque Bot läuft (Media Streams)"));

// TwiML Sichttest (GET)
app.get("/incoming-call", (_req, res) => {
  res.type("text/xml").send(buildTwiml());
});

// Twilio-Haupthook (POST)
app.post("/incoming-call", (req, res) => {
  const callSid = req.body?.CallSid;
  console.log("Incoming call:", callSid);
  const twiml = buildTwiml();
  console.log("TwiML sent:\n", twiml);
  res.type("text/xml").send(twiml);
});

// Status-Callback vom <Stream>
app.post("/ms-status", (req, res) => {
  console.log("MS Status:", req.body);
  res.sendStatus(204);
});

// ---------- HTTP-Server (gemeinsam für HTTP + WS) ----------
const server = http.createServer(app);

// Upgrade-Logging (zeigt WS-Handshakes)
server.on("upgrade", (req, _socket, _head) => {
  console.log("HTTP upgrade requested:", req.url);
});

// ---------- WebSocket-Server unter /media ----------
const wss = new WebSocket.Server({ server, path: "/media" });

// µ-law → PCM16 (G.711)
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
  const out = Buffer.alloc(buf.length * 2); // 16-bit LE
  for (let i = 0; i < buf.length; i++) {
    const s = muLawToPcm16(buf[i]);
    out.writeInt16LE(s, i * 2);
  }
  return out;
}

const SAMPLE_RATE = 8000; // Twilio Media Streams = 8kHz µ-law

// XML-Escapes (für <Say>)
function escapeXml(s = "") {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Während des Calls etwas sagen + Stream wieder starten
async function sayToCaller(callSid, text) {
  const client = getTwilioClient();
  if (!client) {
    console.warn("Kein Twilio-Client -> überspringe sayToCaller()");
    return;
  }
  const replyTwiml =
    `<?xml version="1.0" encoding="UTF-8"?>
     <Response>
       <Say voice="Polly.Marlene" language="de-DE">${escapeXml(text)}</Say>
       <Pause length="0.5"/>
       <Connect>
         <!-- >>> HIER ggf. deine Render-URL einsetzen <<< -->
         <Stream url="wss://croque-bot.onrender.com/media" track="inbound_track"
                 statusCallback="https://croque-bot.onrender.com/ms-status"
                 statusCallbackMethod="POST"/>
       </Connect>
     </Response>`;

  console.log(`[sayToCaller] update call ${callSid} with:`, text);
  await client.calls(callSid).update({ twiml: replyTwiml });
  console.log("[sayToCaller] OK (calls.update)");
}

// WAV-Datei aus PCM16 LE @ 8kHz erzeugen
function writeWav(filepath, pcmBuffer, sampleRate) {
  return new Promise((resolve, reject) => {
    try {
      const writer = new FileWriter(filepath, {
        channels: 1,
        sampleRate,
        bitDepth: 16,
      });
      writer.on("finish", resolve);
      writer.on("error", reject);
      writer.write(pcmBuffer);
      writer.end();
    } catch (err) {
      reject(err);
    }
  });
}

// OpenAI Whisper – Transkription einer WAV
async function transcribeWithOpenAI(wavPath) {
  if (!process.env.OPENAI_API_KEY) {
    console.warn("Kein OPENAI_API_KEY gesetzt – überspringe Transkription.");
    return "";
  }
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

// ---------- Turn-Taking: Sprechpause + erzwungener Turn ----------
const SILENCE_MS     = 500;   // 0,5 s Pause reicht als Turn-Ende
const MIN_AUDIO_MS   = 600;   // min. 0,6 s Audio sammeln
const MAX_LISTEN_MS  = 3500;  // spätestens nach 3,5 s Turn erzwingen
const INITIAL_ACK_MS = 1500;  // 1,5 s nach erstem Audio: „Einen Moment …“

wss.on("connection", (ws, req) => {
  console.log("WS connection attempt:", req.url, "headers:", req.headers);
  console.log("Media Stream verbunden");

  let pcmChunks = [];
  let mediaCount = 0;
  let currentCallSid = null;

  // Timing / Steuerung
  let firstPacketAt = 0;
  let lastPacketAt = 0;
  let silenceTimer = null;
  let maxListenTimer = null;
  let initialAckTimer = null;
  let processing = false;
  let closed = false;

  // Timer-Helpers
  function clearTimer(t) { if (t) clearTimeout(t); }
  function clearAllTimers() {
    clearTimer(silenceTimer);     silenceTimer = null;
    clearTimer(maxListenTimer);   maxListenTimer = null;
    clearTimer(initialAckTimer);  initialAckTimer = null;
  }
  function resetSilenceTimer() {
    clearTimer(silenceTimer);
    silenceTimer = setTimeout(onSilenceTimeout, SILENCE_MS);
  }
  function armMaxListenTimer() {
    clearTimer(maxListenTimer);
    maxListenTimer = setTimeout(onForcedTurn, MAX_LISTEN_MS);
  }
  function armInitialAckTimer() {
    clearTimer(initialAckTimer);
    initialAckTimer = setTimeout(onInitialAck, INITIAL_ACK_MS);
  }

  // Früheste Bestätigung (hält Call aktiv)
  async function onInitialAck() {
    if (processing || closed) return;
    if (!currentCallSid) return;
    console.log("[VAD] initial ACK fired");
    try {
      await sayToCaller(currentCallSid, "Einen Moment, ich verarbeite das.");
    } catch (err) {
      if (err?.code === 21220) console.warn("Call nicht aktiv (21220) – initiale Bestätigung übersprungen.");
      else console.error("Fehler initiale Bestätigung:", err);
    }
  }

  // Normales Turn-Ende: Pause erkannt
  async function onSilenceTimeout() {
    if (processing || closed) return;
    const durationMs = (lastPacketAt && firstPacketAt) ? (lastPacketAt - firstPacketAt) : 0;
    if (durationMs < MIN_AUDIO_MS || pcmChunks.length === 0) return;
    console.log("[VAD] silence timeout -> processTurn");
    await processTurn("silence");
  }

  // Erzwungenes Turn-Ende (keine Pause innerhalb MAX_LISTEN_MS)
  async function onForcedTurn() {
    if (processing || closed) return;
    const durationMs = (Date.now() - (firstPacketAt || Date.now()));
    if (durationMs < MIN_AUDIO_MS || pcmChunks.length === 0) return;
    console.log("[VAD] forced turn -> processTurn");
    await processTurn("forced");
  }

  // Turn-Verarbeitung: (a) sofort kurze Bestätigung, (b) WAV+STT, (c) inhaltliche Antwort
  async function processTurn(reason) {
    processing = true;
    console.log(`[VAD] processTurn start (${reason})`);
    try {
      if (currentCallSid) {
        try {
          await sayToCaller(currentCallSid, "Einen Moment, ich verarbeite das.");
        } catch (err) {
          if (err?.code === 21220) console.warn("Call nicht aktiv (21220) – Bestätigungsansage übersprungen.");
          else console.error("Fehler bei Bestätigungsansage:", err);
        }
      }

      const wavPath = path.join("/tmp", `turn_${Date.now()}_${reason}.wav`);
      await writeWav(wavPath, Buffer.concat(pcmChunks), SAMPLE_RATE);
      console.log(`TURN (${reason}) WAV:`, wavPath, `(${Math.round((lastPacketAt - firstPacketAt) || 0)}ms)`);

      const transcript = await transcribeWithOpenAI(wavPath);
      console.log("TURN Transkript:", transcript);

      if (currentCallSid && transcript) {
        try {
          const reply = `Ich habe verstanden: ${transcript}. Was möchten Sie genau bestellen?`;
          await sayToCaller(currentCallSid, reply);
        } catch (err) {
          if (err?.code === 21220) console.warn("Call nicht aktiv (21220) – inhaltliche Antwort übersprungen.");
          else console.error("Fehler bei inhaltlicher Antwort:", err);
        }
      }
    } catch (e) {
      console.error("Fehler im Turn-Handling:", e);
    } finally {
      // Reset für nächsten Turn
      pcmChunks = [];
      firstPacketAt = 0;
      lastPacketAt = 0;
      processing = false;

      // Timer aus – Twilio startet nach calls.update neuen <Stream>
      clearAllTimers();
      console.log("[VAD] processTurn done");
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
        currentCallSid = data.start?.callSid || "unknown";
        console.log("Stream start:", currentCallSid, data.start?.streamSid);
        break;

      case "media":
        mediaCount++;
        const mu = Buffer.from(data.media?.payload || "", "base64");
        const pcm = decodeMuLawBuffer(mu);
        pcmChunks.push(pcm);

        const now = Date.now();
        if (!firstPacketAt) {
          firstPacketAt = now;
          armInitialAckTimer();  // nach 1,5s erste kurze Bestätigung
          armMaxListenTimer();   // spätestens nach 3,5s Turn erzwingen
        }
        lastPacketAt = now;

        // Jede Media-Nachricht = Sprecher aktiv → Stille-Timer neu setzen
        resetSilenceTimer();

        if (mediaCount % 50 === 0) console.log(`media packets: ${mediaCount}`);
        break;

      case "stop":
        console.log("Stream stop. Total media packets:", mediaCount);
        clearAllTimers();
        // Letzten Rest evtl. noch verarbeiten
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
const PORT = process.env.PORT || 3000; // Render setzt PORT automatisch
server.listen(PORT, () => console.log(`Bot läuft auf Port ${PORT}`));
