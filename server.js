"use strict";

const express = require("express");
const path = require("path");
const multer = require("multer");
const { createWorker } = require("tesseract.js");
const sharp = require("sharp");
const MRZ = require("mrz");
const { createClient } = require("@supabase/supabase-js");

const { generateAndStorePDF } = require("./src/pdf");

const app = express();

// Supabase client (uses env vars)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Multer config
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

// OCR endpoint with storage
app.post("/ocr-passport", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, error: "No image uploaded" });
    }

    // Preprocess image
    const processedBuffer = await sharp(req.file.buffer)
      .resize(1500, null, { withoutEnlargement: true })
      .grayscale()
      .normalize()
      .toBuffer();

    // Run Tesseract
    const worker = await createWorker("eng");
    const { data: { text } } = await worker.recognize(processedBuffer);
    await worker.terminate();

    // Parse MRZ
    const result = MRZ.parse(text);
    if (!result.valid) {
      return res.status(400).json({ ok: false, error: "Could not read MRZ. Please try a clearer photo." });
    }

    const fields = result.fields;
    const extracted = {
      name: `${fields.surname || ""} ${fields.givenNames || ""}`.trim(),
      dob: fields.birthDate || "",
      nationality: fields.nationality || "",
      passportNumber: fields.documentNumber || "",
    };

    // Upload the original image to Supabase Storage
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    const fileName = `passport_${timestamp}_${random}.jpg`;

    const { error: uploadError } = await supabase.storage
      .from("PassportPhotos")
      .upload(fileName, req.file.buffer, { contentType: "image/jpeg", upsert: false });

    if (uploadError) {
      console.error("Storage upload error:", uploadError);
      // Continue without photo URL – OCR data still returned
    }

    let photoUrl = null;
    if (!uploadError) {
      const { data: signedUrlData, error: urlError } = await supabase.storage
        .from("PassportPhotos")
        .createSignedUrl(fileName, 60 * 60 * 24 * 365); // 1 year
      if (!urlError) {
        photoUrl = signedUrlData.signedUrl;
      }
    }

    res.json({ ok: true, data: extracted, photoUrl });
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
