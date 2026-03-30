"use strict";

/**
 * pdf.js — Generates a classic formal A4 PDF resume
 * Stores privately in Supabase Storage + saves record to DB
 *
 * Supabase setup:
 *   Storage bucket: "Resumes" (private)
 *   Table: "resume_submissions" (see column list below)
 */

const PDFDocument   = require("pdfkit");
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ─── Build PDF ────────────────────────────────────────────────────────────────
function buildPDF(d) {
  return new Promise((resolve, reject) => {
    const doc    = new PDFDocument({ size: "A4", margin: 50 });
    const chunks = [];
    doc.on("data",  chunk => chunks.push(chunk));
    doc.on("end",   ()    => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const skip     = v  => !v || v === "NA";
    const location = [d.city, d.country].filter(Boolean).join(", ");
    const today    = new Date().toLocaleDateString("en-SG", { year: "numeric", month: "long", day: "numeric" });

    // ── Header ──
    doc.fontSize(18).font("Helvetica-Bold")
       .text((d.name ?? "").toUpperCase(), { align: "center" });
    doc.moveDown(0.2);
    doc.fontSize(10).font("Helvetica").fillColor("#444444")
       .text([d.phone, d.email, location, d.nationality].filter(Boolean).join("  |  "), { align: "center" });
    doc.moveDown(0.1);
    doc.fontSize(9).fillColor("#888888")
       .text(`Submitted to: ${d.agency ?? ""}`, { align: "center" });
    doc.moveDown(0.3);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).lineWidth(2).strokeColor("#111111").stroke();
    doc.moveDown(0.5);

    function sectionTitle(title) {
      doc.moveDown(0.3);
      doc.fontSize(9).font("Helvetica-Bold").fillColor("#111111")
         .text(title.toUpperCase(), { characterSpacing: 1.5 });
      doc.moveTo(50, doc.y).lineTo(545, doc.y).lineWidth(0.5).strokeColor("#111111").stroke();
      doc.moveDown(0.4);
    }

    function infoRow(label, value) {
      if (skip(value)) return;
      doc.fontSize(10).font("Helvetica-Bold").fillColor("#333333").text(label + ": ", { continued: true });
      doc.font("Helvetica").fillColor("#111111").text(value);
    }

    function pills(str) {
      if (skip(str)) return;
      const items = str.split(/[,،]+/).map(s => s.trim()).filter(Boolean);
      if (!items.length) return;
      doc.fontSize(10).font("Helvetica").fillColor("#111111");
      const x0 = 50; let x = x0, y = doc.y;
      items.forEach(item => {
        const w = doc.widthOfString(item) + 14;
        if (x + w > 545) { x = x0; y += 18; }
        doc.rect(x, y, w, 15).lineWidth(0.5).strokeColor("#999999").stroke();
        doc.text(item, x + 7, y + 3, { lineBreak: false });
        x += w + 6;
      });
      doc.y = y + 20;
      doc.moveDown(0.2);
    }

    function jobBlock(n) {
      const t = d[`job${n}Title`], c = d[`job${n}Company`], dt = d[`job${n}Dates`];
      if (skip(t)) return;
      doc.fontSize(10).font("Helvetica-Bold").fillColor("#111111").text(t, { continued: !skip(dt) });
      if (!skip(dt)) {
        doc.font("Helvetica").fillColor("#555555").text("  " + dt, { align: "right" });
      } else { doc.text(""); }
      if (!skip(c)) doc.fontSize(10).font("Helvetica-Oblique").fillColor("#555555").text(c);
      doc.moveDown(0.3);
    }

    // ── Personal Details ──
    sectionTitle("Personal Details");
    infoRow("Date of birth",    d.dob);
    infoRow("Nationality",      d.nationality);
    infoRow("Current location", location);
    infoRow("Work arrangement", d.workArrange);
    infoRow("Availability",     d.availability);
    if (!skip(d.salary)) infoRow("Expected salary (SGD)", d.salary);

    // ── Objective ──
    sectionTitle("Objective");
    doc.fontSize(10).font("Helvetica").fillColor("#111111")
       .text(`Seeking a ${d.jobType ?? ""} position in Singapore. ${d.experience ?? ""} of relevant work experience. Available to start ${d.availability ?? "immediately"}.`);

    // ── Work Experience ──
    sectionTitle("Work Experience");
    if (!skip(d.job1Title)) {
      jobBlock(1); jobBlock(2); jobBlock(3);
    } else {
      doc.fontSize(10).font("Helvetica-Oblique").fillColor("#888888").text("No work history provided.");
    }

    // ── Skills ──
    sectionTitle("Skills");
    if (!skip(d.skills)) pills(d.skills);
    else doc.fontSize(10).font("Helvetica-Oblique").fillColor("#888888").text("Not provided.");

    // ── Certifications ──
    if (!skip(d.certs)) {
      sectionTitle("Certifications & Licences");
      pills(d.certs);
    }

    // ── Education ──
    sectionTitle("Education");
    doc.fontSize(10).font("Helvetica").fillColor("#111111").text(d.education ?? "—");

    // ── Languages ──
    sectionTitle("Languages");
    if (!skip(d.languages)) pills(d.languages);
    else doc.fontSize(10).font("Helvetica-Oblique").fillColor("#888888").text("Not provided.");

    // ── Footer ──
    doc.moveDown(1);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).lineWidth(0.5).strokeColor("#dddddd").stroke();
    doc.moveDown(0.3);
    doc.fontSize(8).font("Helvetica").fillColor("#aaaaaa")
       .text(`Generated by StartJobReady  •  ${today}  •  For: ${d.agency ?? ""}`, { align: "center" });

    doc.end();
  });
}

// ─── Store to Supabase ────────────────────────────────────────────────────────
async function generateAndStorePDF(data, submissionId) {

  // 1. Generate PDF
  const pdfBuffer = await buildPDF(data);

  // 2. Upload to Supabase Storage (bucket: "Resumes", private)
  const safeName   = (data.name   ?? "unknown").replace(/[^a-z0-9]/gi, "_").toLowerCase();
  const safeAgency = (data.agency ?? "").replace(/[^a-z0-9]/gi, "_").toLowerCase();
  const fileName   = `${Date.now()}_${safeName}_${safeAgency}.pdf`;

  const { error: uploadError } = await supabase.storage
    .from("Resumes")
    .upload(fileName, pdfBuffer, { contentType: "application/pdf", upsert: false });
  if (uploadError) throw uploadError;

  // 3. Get signed URL (valid 1 year)
  const { data: signedData, error: urlError } = await supabase.storage
    .from("Resumes")
    .createSignedUrl(fileName, 60 * 60 * 24 * 365);
  if (urlError) throw urlError;
  const pdfUrl = signedData.signedUrl;

  // 4. Save record to Supabase DB (table: resume_submissions)
  const { error: dbError } = await supabase.from("resume_submissions").insert({
    psid:         submissionId,
    agency:       data.agency       ?? null,
    name:         data.name         ?? null,
    dob:          data.dob          ?? null,
    nationality:  data.nationality  ?? null,
    country:      data.country      ?? null,
    city:         data.city         ?? null,
    phone:        data.phone        ?? null,
    email:        data.email        ?? null,
    job_type:     data.jobType      ?? null,
    work_arrange: data.workArrange  ?? null,
    availability: data.availability ?? null,
    salary:       data.salary || null,
    experience:   data.experience   ?? null,
    job1_title:   data.job1Title    ?? null,
    job1_company: data.job1Company  ?? null,
    job1_dates:   data.job1Dates    ?? null,
    job2_title:   data.job2Title    || null,
    job2_company: data.job2Company  || null,
    job2_dates:   data.job2Dates    || null,
    job3_title:   data.job3Title    || null,
    job3_company: data.job3Company  || null,
    job3_dates:   data.job3Dates    || null,
    skills:       data.skills       ?? null,
    certs:        data.certs        || null,
    education:    data.education    ?? null,
    languages:    data.languages    ?? null,
    pdf_url:      pdfUrl,
  });
  if (dbError) throw dbError;

  console.log(`✅ PDF stored: ${fileName}`);
  return pdfUrl;
}

module.exports = { generateAndStorePDF };
