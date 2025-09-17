// server.js
const express = require("express");
const twilio = require("twilio");
const http = require("http");
const WebSocket = require("ws");

const app = express();

app.use(express.urlencoded({ extended: false })); // Twilio form POSTs
app.use(express.json()); // für Status-Callbacks

function buildTwiml(callSid) {
  const twiml = new twilio.twiml.VoiceResponse();

  // Kurze Ansage + 1 Sek. Pause, damit Render (Free/Hobby) aufwacht
  twiml.say(
    { voice: "Polly.Marlene", language: "de-DE" },
    "Einen Moment, ich verbinde Sie."
  );
  twiml.pause({ length: 1 });

  const connect = twiml.connect();
  connect.stream({
    // WICHTIG: WSS und korrekte Domain
    url: "wss://croque-bot.onrender.com/media",
    track: "inbound_track",
    // Absolute URL für Status-Events
    statusCallback: "https://croque-bot.onrender.com/ms-status",
    statusCallbackMethod: "POST",
  });

  return twiml.toString();
}

// Healthcheck
app.get("/", (_req, res) => res.send("OK - Croque Bot läuft (Media Streams)"));

// GET zum Sicht-Test des TwiML
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

// Status-Callback des <Stream>
app.post("/ms-status", (req, res) => {
  console.log("MS Status:", req.body);
  res.sendStatus(204);
});

// HTTP-Server (gemeinsam für HTTP + WS)
const server = http.createServer(app);

// Logge jede Upgrade-Anfrage (WS-Handshakes)
server.on("upgrade", (req, _socket, _head) => {
  console.log("HTTP upgrade requested:", req.url);
});

// WebSocket-Server unter /media
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
        // const chunkB64 = data.media?.payload; // <- später an STT
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

const PORT = process.env.PORT || 3000; // Render setzt PORT automatisch
server.listen(PORT, () => console.log(`Bot läuft auf Port ${PORT}`));
