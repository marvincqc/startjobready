/**
 * ResumeBot — Messenger Webhook Server
 * Handles verification + incoming messages from Meta Messenger Platform
 */

"use strict";

const express = require("express");
const bodyParser = require("body-parser");
const crypto = require("crypto");
const axios = require("axios");
require("dotenv").config();

const path = require("path");
const { handleMessage, startFlow } = require("./bot");
const { generateAndStorePDF } = require("./pdf");

const app = express();

// ─── Serve public folder (web wizard) ────────────────────────────────────────
app.use(express.static(path.join(__dirname, "../public")));

// ─── Raw body needed for SHA256 signature verification ───────────────────────
app.use(
  bodyParser.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

// ─── Middleware: verify every POST actually came from Meta ────────────────────
function verifySignature(req, res, next) {
  const signature = req.headers["x-hub-signature-256"];
  if (!signature) {
    console.warn("⚠️  No x-hub-signature-256 header — rejecting");
    return res.sendStatus(401);
  }
  const [, hash] = signature.split("=");
  const expected = crypto
    .createHmac("sha256", process.env.APP_SECRET)
    .update(req.rawBody)
    .digest("hex");

  if (hash !== expected) {
    console.warn("⚠️  Signature mismatch — possible spoofed request");
    return res.sendStatus(403);
  }
  next();
}

// ─── GET /webhook — Meta verification handshake ───────────────────────────────
app.get("/webhook", (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
    console.log("✅ Webhook verified by Meta");
    return res.status(200).send(challenge);
  }
  console.warn("❌ Webhook verification failed — token mismatch");
  res.sendStatus(403);
});

// ─── POST /webhook — incoming Messenger events ────────────────────────────────
app.post("/webhook", verifySignature, async (req, res) => {
  const body = req.body;

  if (body.object !== "page") {
    return res.sendStatus(404);
  }

  // Acknowledge immediately — Meta requires < 5s response
  res.status(200).send("EVENT_RECEIVED");

  // Process each entry asynchronously after responding
  for (const entry of body.entry ?? []) {
    for (const event of entry.messaging ?? []) {
      if (event.message && !event.message.is_echo) {
        // New user sends "hi" or any text — start the flow
        const txt = (event.message.text ?? "").trim().toLowerCase();
        if (txt === "hi" || txt === "hello" || txt === "start") {
          await startFlow(event.sender.id).catch(console.error);
        } else {
          await handleMessage(event).catch(console.error);
        }
      } else if (event.postback) {
        await handleMessage(event).catch(console.error);
      }
    }
  }
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({ status: "ok" }));

// ─── Privacy policy ───────────────────────────────────────────────────────────
app.get("/privacy", (_req, res) => res.sendFile(path.join(__dirname, "../public/privacy.html")));

// ─── Web wizard submit endpoint ───────────────────────────────────────────────
app.post("/submit", express.json(), async (req, res) => {
  const { data } = req.body;
  if (!data) return res.status(400).json({ ok: false, error: "No data provided" });

  try {
    const pdfUrl = await generateAndStorePDF(data, "web-" + Date.now());
    console.log("✅ Web submission stored:", data.name, "→", data.agency);
    res.json({ ok: true, pdfUrl });
  } catch (err) {
    console.error("Web submit error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 ResumeBot listening on port ${PORT}`));
