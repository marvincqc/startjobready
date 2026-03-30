"use strict";

const express = require("express");
const path = require("path");
const multer = require("multer");
const { createWorker } = require("tesseract.js");
const sharp = require("sharp");
const MRZ = require("mrz");

const { generateAndStorePDF } = require("./src/pdf");

const app = express();

// Configure multer for memory storage (5MB limit)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// Serve static files from public folder
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json({ limit: "10mb" }));

// Health check
app.get("/health", (_req, res) => res.json({ status: "ok" }));

// Privacy policy
app.get("/privacy", (_req, res) =>
  res.sendFile(path.join(__dirname, "public", "privacy.html"))
);

// OCR endpoint
app.post("/ocr-passport", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, error: "No image uploaded" });
    }

    // Preprocess image: resize to max 1500px, grayscale, normalize
    const processedBuffer = await sharp(req.file.buffer)
      .resize(1500, null, { withoutEnlargement: true })
      .grayscale()
      .normalize()
      .toBuffer();

    // Run Tesseract
    const worker = await createWorker("eng");
    const { data: { text } } = await worker.recognize(processedBuffer);
    await worker.terminate();

    // Parse MRZ using mrz library
    const result = MRZ.parse(text);
    if (!result.valid) {
      return res.status(400).json({ ok: false, error: "Could not read MRZ. Please try a clearer photo." });
    }

    const fields = result.fields;
    // Extract relevant data
    const extracted = {
      name: `${fields.surname || ""} ${fields.givenNames || ""}`.trim(),
      dob: fields.birthDate || "",
      nationality: fields.nationality || "",
      passportNumber: fields.documentNumber || "",
    };

    res.json({ ok: true, data: extracted });
  } catch (err) {
    console.error("OCR error:", err);
    res.status(500).json({ ok: false, error: "OCR processing failed" });
  }
});

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
