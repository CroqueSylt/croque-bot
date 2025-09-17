const fs = require("fs");
const path = require("path");
const { FileWriter } = require("wav");
const OpenAI = require("openai");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- µ-law → PCM16 Decoder (G.711) ---
function muLawToPcm16(uVal) {
  // uVal: 0..255
  uVal = ~uVal & 0xff;
  const sign = (uVal & 0x80) ? -1 : 1;
  let exponent = (uVal >> 4) & 0x07;
  let mantissa = uVal & 0x0F;
  let magnitude = ((mantissa << 3) + 0x84) << exponent;
  magnitude -= 0x84;
  let sample = sign * magnitude;
  // clamp to 16-bit
  if (sample > 32767) sample = 32767;
  if (sample < -32768) sample = -32768;
  return sample;
}
function decodeMuLawBuffer(buf) {
  // buf: raw µ-law bytes
  const out = Buffer.alloc(buf.length * 2); // 16-bit LE
  for (let i = 0; i < buf.length; i++) {
    const s = muLawToPcm16(buf[i]);
    out.writeInt16LE(s, i * 2);
  }
  return out;
}

const SAMPLE_RATE = 8000; // Twilio Media Streams sind 8kHz µ-law

wss.on("connection", (ws, req) => {
  console.log("WS connection attempt:", req.url, "headers:", req.headers);
  console.log("Media Stream verbunden");

  // Buffer für PCM16-Daten eines Calls
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
        // Base64 µ-law → raw bytes
        const mu = Buffer.from(data.media?.payload || "", "base64");
        // µ-law → PCM16
        const pcm = decodeMuLawBuffer(mu);
        pcmChunks.push(pcm);

        if (mediaCount % 50 === 0) console.log(`media packets: ${mediaCount}`);
        break;

      case "stop":
        console.log("Stream stop. Total media packets:", mediaCount);
        // WAV schreiben und transkribieren
        try {
          if (pcmChunks.length) {
            const wavPath = path.join("/tmp", `call_${Date.now()}.wav`);
            await writeWav(wavPath, Buffer.concat(pcmChunks), SAMPLE_RATE);
            console.log("WAV geschrieben:", wavPath);
            await transcribeWithOpenAI(wavPath);
          } else {
            console.log("Keine PCM-Daten gesammelt – nichts zu transkribieren.");
          }
        } catch (e) {
          console.error("Fehler beim Schreiben/Transkribieren:", e);
        }
        break;

      default:
        console.log("WS event:", data.event);
    }
  });

  ws.on("close", (code, reason) =>
    console.log("Media Stream getrennt", code, reason?.toString?.())
  );
  ws.on("error", (err) => console.error("WS error:", err));
});

// WAV-Datei aus PCM16 LE @ 8kHz erzeugen
function writeWav(filepath, pcmBuffer, sampleRate) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(filepath);
    const writer = new FileWriter(file, {
      channels: 1,
      sampleRate,
      bitDepth: 16,
    });
    writer.on("finish", resolve);
    writer.on("error", reject);
    writer.write(pcmBuffer);
    writer.end();
  });
}

// OpenAI Whisper Transkription (Batch am Call-Ende)
async function transcribeWithOpenAI(wavPath) {
  if (!process.env.OPENAI_API_KEY) {
    console.warn("Kein OPENAI_API_KEY gesetzt – überspringe Transkription.");
    return;
  }
  console.log("Sende an OpenAI Whisper…");
  const resp = await openai.audio.transcriptions.create({
    file: fs.createReadStream(wavPath),
    model: "whisper-1",           // falls neueres Modell verfügbar, hier anpassen
    language: "de",               // deutsch
    response_format: "verbose_json",
    temperature: 0,
  });
  console.log("Transkript:", resp.text || resp?.results || resp);
}
