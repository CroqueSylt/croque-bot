const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

async function sayToCaller(callSid, text) {
  // Spricht etwas und startet danach den Stream neu (damit wir weiter zuhören)
  const replyTwiml =
    `<?xml version="1.0" encoding="UTF-8"?>
     <Response>
       <Say voice="Polly.Marlene" language="de-DE">${text}</Say>
       <Pause length="0.5"/>
       <Connect>
         <Stream url="wss://croque-bot.onrender.com/media" track="inbound_track"
                 statusCallback="https://croque-bot.onrender.com/ms-status" statusCallbackMethod="POST"/>
       </Connect>
     </Response>`;

  await twilioClient.calls(callSid).update({ twiml: replyTwiml });
}

// server.js
// Twilio Voice Webhook + Media Streams (WebSocket) + WAV + Whisper

const express = require("express");
const twilio = require("twilio");
const http = require("http");
const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");
const { FileWriter } = require("wav");
const OpenAI = require("openai");

const app = express();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Middleware
app.use(express.urlencoded({ extended: false })); // Twilio form POSTs
app.use(express.json()); // für Status-Callbacks/JSON

// Optional: Begrüßung per Env steuerbar
const GREETING =
  process.env.GREETING ||
  "Willkommen bei Croque Sylt. Einen Moment, ich verbinde Sie.";

// TwiML erzeugen: kurze Ansage + 1s Pause + MediaStream
function buildTwiml(callSid) {
  const twiml = new twilio.twiml.VoiceResponse();

  twiml.say({ voice: "Polly.Marlene", language: "de-DE" }, GREETING);
  twiml.pause({ length: 1 }); // Free/Hobby-Plan kann kurz aufwachen

  const connect = twiml.connect();
  connect.stream({
    url: "wss://croque-bot.onrender.com/media", // <- WSS + deine Render-Domain
    track: "inbound_track", // wichtig! (statt "inbound")
    statusCallback: "https://croque-bot.onrender.com/ms-status", // absolute URL
    statusCallbackMethod: "POST",
  });

  return twiml.toString();
}

// Healthcheck
app.get("/", (_req, res) => res.send("OK - Croque Bot läuft (Media Streams)"));

// TwiML Sichttest (GET)
app.get("/incoming-call", (_req, res) => {
  res.type("text/xml").send(buildTwiml("TEST-BROWSER"));
});

// Twilio-Haupthook (POST)
app.post("/incoming-call", (req, res) => {
  const callSid = req.body?.CallSid;
  console.log("Incoming call:", callSid);
  const twiml = buildTwiml(callSid);
  console.log("TwiML sent:\n", twiml);
  res.type("text/xml").send(twiml);
});

// Status-Callback vom <Stream>
app.post("/ms-status", (req, res) => {
  console.log("MS Status:", req.body);
  res.sendStatus(204);
});

// HTTP-Server (gemeinsam für HTTP + WS)
const server = http.createServer(app);

// Upgrade-Logging (zeigt WS-Handshakes)
server.on("upgrade", (req, _socket, _head) => {
  console.log("HTTP upgrade requested:", req.url);
});

// ---------- WebSocket-Server (MUSS nach server.create kommen!) ----------

const wss = new WebSocket.Server({ server, path: "/media" });

// µ-law → PCM16 Decoder (G.711)
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

wss.on("connection", (ws, req) => {
  console.log("WS connection attempt:", req.url, "headers:", req.headers);
  console.log("Media Stream verbunden");

  let pcmChunks = [];
  let mediaCount = 0;
  let currentCallSid = null;

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
        const mu = Buffer.from(data.media?.payload || "", "base64"); // µ-law
        const pcm = decodeMuLawBuffer(mu); // → PCM16
        pcmChunks.push(pcm);
        if (mediaCount % 50 === 0) console.log(`media packets: ${mediaCount}`);
        break;

case "stop":
  console.log("Stream stop. Total media packets:", mediaCount);
  try {
    if (pcmChunks.length) {
      const wavPath = path.join("/tmp", `call_${Date.now()}.wav`);
      await writeWav(wavPath, Buffer.concat(pcmChunks), SAMPLE_RATE);
      console.log("WAV geschrieben:", wavPath);
      const text = await transcribeWithOpenAI(wavPath); // gib Text zurück (siehe unten)
      console.log("Transkript:", text);

      // *** einfache Demo-Antwort:
      if (currentCallSid) {
        await sayToCaller(currentCallSid, `Ich habe verstanden: ${text}. Was möchten Sie genau bestellen?`);
      }
    } else {
      console.log("Keine PCM-Daten gesammelt – nichts zu transkribieren.");
    }
  } catch (e) {
    console.error("Fehler beim Schreiben/Transkribieren:", e);
  }
  break;


  ws.on("close", (code, reason) =>
    console.log("Media Stream getrennt", code, reason?.toString?.())
  );
  ws.on("error", (err) => console.error("WS error:", err));
});

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

// OpenAI Whisper Transkription (Batch am Call-Ende)
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


// Start
const PORT = process.env.PORT || 3000; // Render setzt PORT automatisch
server.listen(PORT, () => console.log(`Bot läuft auf Port ${PORT}`));
