const express = require("express");
const twilio = require("twilio");
const app = express();

app.use(express.urlencoded({ extended: false }));

function buildTwiml() {
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say(
    { voice: "Polly.Marlene", language: "de-DE" },
    "Willkommen bei Croque Sylt. Ihre Bestellung wird gleich aufgenommen."
  );
  return twiml.toString();
}

// Healthcheck
app.get("/", (req, res) => res.send("OK - Croque Bot läuft"));

// Browser-Test (GET)
app.get("/incoming-call", (req, res) => {
  res.type("text/xml").send(buildTwiml());
});

// Twilio-Webhook (POST)
app.post("/incoming-call", (req, res) => {
  res.type("text/xml").send(buildTwiml());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot läuft auf Port ${PORT}`));
