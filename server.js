"use strict";

const express = require("express");
const path = require("path");

const { generateAndStorePDF } = require("./src/pdf");

const app = express();

// Serve static files from public folder
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json({ limit: "10mb" }));

// Health check
app.get("/health", (_req, res) => res.json({ status: "ok" }));

// Privacy policy
app.get("/privacy", (_req, res) =>
  res.sendFile(path.join(__dirname, "public", "privacy.html"))
);

// Web wizard submit
app.post("/submit", async (req, res) => {
  const { data } = req.body;
  
  if (!data) {
    return res.status(400).json({ ok: false, error: "No data provided" });
  }

  try {
    const submissionId = "web-" + Date.now();
    const pdfUrl = await generateAndStorePDF(data, submissionId);
    console.log(`✅ Submission: ${data.name || "Anonymous"} → ${data.agency || "No agency"}`);
    res.json({ ok: true, pdfUrl });
  } catch (err) {
    console.error("❌ Submit error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Start server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 StartJobReady listening on port ${PORT}`));
