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

// ---- ENV & Clients ----
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Twilio-Client lazy initialisieren (damit Start nicht crasht, wenn ENV fehlt)
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

// ---- Middleware ----
app.use(express.urlencoded({ extended: false })); // Twilio form POSTs
app.use(express.json()); // für Status-Callbacks / JSON

// Begrüßung per Env steuerbar
const GREETING =
  process.env.GREETING ||
  "Willkommen bei Croque Sylt. Einen Moment, ich verbinde Sie.";

// ---- TwiML erzeugen: kurze Ansage + 1s Pause + MediaStream ----
function buildTwiml() {
  const twiml = new twilio.twiml.VoiceResponse();

  twiml.say({ voice: "Polly.Marlene", language: "de-DE" }, GREETING);
  twiml.pause({ length: 1 }); // Hobby-Plan kann kurz aufwachen

  const connect = twiml.connect();
  connect.stream({
    // >>> Falls deine Render-URL anders ist: HIER anpassen
    url: "wss://croque-bot.onrender.com/media",
    track: "inbound_track",
    // absolute URL:
    statusCallback: "https://croque-bot.onrender.com/ms-status",
    statusCallbackMethod: "POST",
  });

  return twiml.toString();
}

// ---- Healthcheck ----
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

// ---- HTTP-Server (gemeinsam für HTTP + WS) ----
const server = http.createServer(app);

// Upgrade-Logging (zeigt WS-Handshakes)
server.on("upgrade", (req, _socket, _head) => {
  console.log("HTTP upgrade requested:", req.url);
});

// ---- WebSocket-Server unter /media ----
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

// einfache XML-Escapes
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
         <Stream url="wss://croque-bot.onrender.com/media" track="inbound_track"
                 statusCallback="https://croque-bot.onrender.com/ms-status"
                 statusCallbackMethod="POST"/>
       </Connect>
     </Response>`;
  await client.calls(callSid).update({ twiml: replyTwiml });
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

// ---- Turn-Taking mit einfacher Sprechpausenerkennung (VAD-light) ----
const SILENCE_MS = 800;   // Pause-Länge, die ein „Turn-Ende“ signalisiert
const MIN_AUDIO_MS = 800; // Mindestens ~0,8s Audio sammeln

wss.on("connection", (ws, req) => {
  console.log("WS connection attempt:", req.url, "headers:", req.headers);
  console.log("Media Stream verbunden");

  let pcmChunks = [];
  let mediaCount = 0;
  let currentCallSid = null;

  // Timing für VAD-light:
  let firstPacketAt = 0;
  let lastPacketAt = 0;
  let silenceTimer = null;
  let processing = false; // schützt vor paralleler Transkription
  let closed = false;

  function clearSilenceTimer() {
    if (silenceTimer) {
      clearTimeout(silenceTimer);
      silenceTimer = null;
    }
  }

  function scheduleSilenceTimer() {
    clearSilenceTimer();
    silenceTimer = setTimeout(onSilenceTimeout, SILENCE_MS);
  }

  async function onSilenceTimeout() {
    if (processing || closed) return;
    const durationMs = (lastPacketAt && firstPacketAt) ? (lastPacketAt - firstPacketAt) : 0;
    if (durationMs < MIN_AUDIO_MS || pcmChunks.length === 0) return;

    processing = true;
    try {
      // 1) Sofortige Bestätigung sagen, damit der Call aktiv bleibt
      if (currentCallSid) {
        try {
          await sayToCaller(currentCallSid, "Einen Moment, ich verarbeite das.");
          // Dieses calls.update beendet den aktuellen Stream
          // und startet direkt danach einen neuen <Stream>.
        } catch (err) {
          if (err?.code === 21220) {
            console.warn("Call nicht mehr aktiv (21220) – Bestätigungsansage übersprungen.");
          } else {
            console.error("Fehler bei Bestätigungsansage:", err);
          }
        }
      }

      // 2) Jetzt in Ruhe WAV schreiben + transkribieren
      const wavPath = path.join("/tmp", `turn_${Date.now()}.wav`);
      await writeWav(wavPath, Buffer.concat(pcmChunks), SAMPLE_RATE);
      console.log("TURN WAV geschrieben:", wavPath, `(${Math.round(durationMs)}ms)`);

      const transcript = await transcribeWithOpenAI(wavPath);
      console.log("TURN Transkript:", transcript);

      // 3) Optionale inhaltliche Antwort (zweite Ansage)
      if (currentCallSid && transcript) {
        try {
          const reply = `Ich habe verstanden: ${transcript}. Was möchten Sie genau bestellen?`;
          await sayToCaller(currentCallSid, reply);
        } catch (err) {
          if (err?.code === 21220) {
            console.warn("Call nicht mehr aktiv (21220) – inhaltliche Antwort übersprungen.");
          } else {
            console.error("Fehler bei inhaltlicher Antwort:", err);
          }
        }
      }
    } catch (e) {
      console.error("Fehler im Turn-Handling:", e);
    } finally {
      // Buffer für nächsten Turn zurücksetzen
      pcmChunks = [];
      firstPacketAt = 0;
      lastPacketAt = 0;
      processing = false;
    }
  }

  ws.on("message", async (msg) => {
    let data;
    try {
      data = JSON.parse(msg.toString());
    } catch (e) {
      console.error("WS parse error:", e);
      return;
    }

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
        if (!firstPacketAt) firstPacketAt = now;
        lastPacketAt = now;

        // Jede Media-Nachricht verlängert die „Sprechphase“ → Timer neu setzen
        scheduleSilenceTimer();

        if (mediaCount % 50 === 0) console.log(`media packets: ${mediaCount}`);
        break;

      case "stop":
        console.log("Stream stop. Total media packets:", mediaCount);
        clearSilenceTimer();

        // Letzten Rest (falls noch was im Buffer) versuchen
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
    clearSilenceTimer();
    console.log("Media Stream getrennt", code, reason?.toString?.());
  });

  ws.on("error", (err) => {
    closed = true;
    clearSilenceTimer();
    console.error("WS error:", err);
  });
});

// ---- Start ----
const PORT = process.env.PORT || 3000; // Render setzt PORT automatisch
server.listen(PORT, () => console.log(`Bot läuft auf Port ${PORT}`));
