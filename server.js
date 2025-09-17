// server.js
// Minimaler Twilio-Webhook + Media Streams (WS) mit ausführlichem Logging

const express = require("express");
const twilio = require("twilio");
const http = require("http");
const WebSocket = require("ws");

const app = express();

// --- Middleware (Twilio schickt Form-POSTs) ---
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// --- TwiML bauen: kurze Ansage + MediaStream verbinden ---
function buildTwiml(callSid) {
  const twiml = new twilio.twiml.VoiceResponse();

  // Kurze Ansage, dann Stream öffnen
  twiml.say(
    { voice: "Polly.Marlene", language: "de-DE" },
    "Einen Moment, ich verbinde Sie."
  );

  const connect = twiml.connect();
  connect.stream({
    // >>> Falls deine Render-URL anders ist, hier anpassen:
    url: "wss://croque-bot.onrender.com/media",
    track: "inbound", // wir hören den Anrufer
    statusCallback: "/ms-status",
    statusCallbackMethod: "POST",
  });

  return twiml.toString();
}

// --- Healthcheck (Browser) ---
app.get("/", (_req, res) => {
  res.send("OK - Croque Bot läuft (mit Media Streams)");
});

// --- Test im Browser: zeigt TwiML ---
app.get("/incoming-call", (_req, res) => {
  res.type("text/xml").send(buildTwiml("TEST-BROWSER"));
});

// --- Twilio-Webhook (POST): Haupteinstieg bei Anruf ---
app.post("/incoming-call", (req, res) => {
  const callSid = req.body?.CallSid;
  console.log("Incoming call:", callSid);
  const twiml = buildTwiml(callSid);
  console.log("TwiML sent:\n", twiml);
  res.type("text/xml").send(twiml);
});

// --- Status-Callback von <Stream> (optional, sehr hilfreich) ---
app.post("/ms-status", (req, res) => {
  console.log("MediaStreams Status:", req.body);
  res.sendStatus(204);
});

// --- HTTP-Server erstellen, damit WS & HTTP denselben Port teilen ---
const server = http.createServer(app);

// --- WebSocket-Server für Twilio Media Streams ---
const wss = new WebSocket.Server({ server, path: "/media" });

wss.on("connection", (ws, req) => {
  console.log("WS connection attempt:", req.url, "headers:", req.headers);
  console.log("Media Stream verbunden");
  let mediaCount = 0;

  ws.on("message", (msg) => {
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
        console.log("Stream start:", data.start?.callSid, data.start?.streamSid);
        break;

      case "media":
        // Alle 20ms kommt ein Base64-Audiochunk
        mediaCount++;
        if (mediaCount % 50 === 0) {
          console.log(`media packets: ${mediaCount}`);
        }
        // Beispiel: Zugriff auf den Audio-Chunk
        // const chunkB64 = data.media?.payload;
        // -> später an STT weiterreichen
        break;

      case "stop":
        console.log("Stream stop. Total media packets:", mediaCount);
        break;

      default:
        console.log("WS event:", data.event);
    }
  });

  ws.on("close", (code, reason) =>
    console.log("Media Stream getrennt", code, reason.toString())
  );
  ws.on("error", (err) => console.error("WS error:", err));
});

// --- Start ---
const PORT = process.env.PORT || 3000; // Render setzt PORT automatisch
server.listen(PORT, () => console.log(`Bot läuft auf Port ${PORT}`));
