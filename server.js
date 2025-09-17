// server.js
// Twilio Voice Webhook + Media Streams (WebSocket) – fertig verdrahtet

const express = require("express");
const twilio = require("twilio");
const http = require("http");
const WebSocket = require("ws");

const app = express();

// --- Middleware ---
app.use(express.urlencoded({ extended: false })); // Twilio POST form-encoded
app.use(express.json()); // für statusCallback JSON etc.

// --- TwiML erzeugen: kurze Ansage und Stream verbinden ---
function buildTwiml(callSid) {
  const twiml = new twilio.twiml.VoiceResponse();

  twiml.say(
    { voice: "Polly.Marlene", language: "de-DE" },
    "Einen Moment, ich verbinde Sie. Verdamt nochmal. Können Sie nicht woanders bestellen?"
  );

  const connect = twiml.connect();
  connect.stream({
    // >>> Falls deine Render-URL abweicht, HIER anpassen:
    url: "wss://croque-bot.onrender.com/media",
    track: "inbound",
    statusCallback: "/ms-status",
    statusCallbackMethod: "POST",
  });

  return twiml.toString();
}

// --- Healthcheck (Browser) ---
app.get("/", (_req, res) => {
  res.send("OK - Croque Bot läuft (mit Media Streams)");
});

// --- Test im Browser: TwiML ansehen (GET) ---
app.get("/incoming-call", (_req, res) => {
  res.type("text/xml").send(buildTwiml("TEST-BROWSER"));
});

// --- Twilio-Webhook (POST) ---
app.post("/incoming-call", (req, res) => {
  const callSid = req.body?.CallSid;
  console.log("Incoming call:", callSid);
  const twiml = buildTwiml(callSid);
  console.log("TwiML sent:\n", twiml);
  res.type("text/xml").send(twiml);
});

// --- Status-Callback vom <Stream> (optional aber super hilfreich) ---
app.post("/ms-status", (req, res) => {
  console.log("MS Status:", req.body);
  res.sendStatus(204);
});

// --- HTTP-Server erstellen (damit WS + HTTP denselben Port nutzen) ---
const server = http.createServer(app);

// --- Upgrade-Logging: zeigt eingehende WS-Upgrades (z. B. /media) ---
server.on("upgrade", (req, _socket, _head) => {
  console.log("HTTP upgrade requested:", req.url);
});

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
        mediaCount++;
        if (mediaCount % 50 === 0) {
          console.log(`media packets: ${mediaCount}`);
        }
        // Zugriff auf Audiodaten (Base64):
        // const chunkB64 = data.media?.payload;
        // -> Hier später an STT (Speech-to-Text) streamen
        break;

      case "stop":
        console.log("Stream stop. Total media packets:", mediaCount);
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

// --- Start ---
const PORT = process.env.PORT || 3000; // Render setzt PORT automatisch
server.listen(PORT, () => console.log(`Bot läuft auf Port ${PORT}`));
