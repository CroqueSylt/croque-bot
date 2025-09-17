const express = require("express");
const twilio = require("twilio");
const http = require("http");
const WebSocket = require("ws");

const app = express();

// Body-Parser für Twilio POSTs
app.use(express.urlencoded({ extended: false }));

// TwiML mit Media Stream
function buildTwiml(callSid) {
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say(
    { voice: "Polly.Marlene", language: "de-DE" },
    "Einen Moment, ich verbinde Sie."
  );

  const connect = twiml.connect();
  connect.stream({
    url: "wss://croque-bot.onrender.com/media",
    track: "inbound",
    statusCallback: "/ms-status",
    statusCallbackMethod: "POST",
  });

  return twiml.toString();
}

// Haupt-Webhook: Twilio ruft hier an
app.post("/incoming-call", (req, res) => {
  const callSid = req.body?.CallSid;
  res.type("text/xml").send(buildTwiml(callSid));
});

// Status-Callback von Media Streams
app.post("/ms-status", (req, res) => {
  console.log("MediaStreams Status:", req.body);
  res.sendStatus(204);
});

// Healthcheck
app.get("/", (req, res) => {
  res.send("OK - Croque Bot läuft (mit Media Streams)");
});

// WS-Server für Audio
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/media" });

wss.on("connection", (ws, req) => {
  console.log("Media Stream verbunden");

  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString());

      if (data.event === "connected") {
        console.log("WS connected");
      }
      if (data.event === "start") {
        console.log("Stream start:", data.start?.callSid, data.start?.streamSid);
      }
      if (data.event === "media") {
        // 20ms Audio-Chunks als base64
        const chunkB64 = data.media?.payload;
        // später an Speech-to-Text weiterreichen
      }
      if (data.event === "stop") {
        console.log("Stream stop");
      }
    } catch (e) {
      console.error("WS parse error:", e);
    }
  });

  ws.on("close", () => console.log("Media Stream getrennt"));
});

// Server starten
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Bot läuft auf Port ${PORT}`));
