"use strict";

const fs = require("fs");
const fsPromises = fs.promises;
const path = require("path");
const PDFDocument = require("pdfkit");
const { createClient } = require("@supabase/supabase-js");

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = supabaseUrl && supabaseServiceKey ? createClient(supabaseUrl, supabaseServiceKey) : null;

const STORAGE_BUCKET = "Resumes";
const OUTPUT_ROOT = path.join(__dirname, "..", "resume_output");

function sanitizeSegment(value, fallback = "unknown_agency") {
  const cleaned = String(value ?? "")
    .trim()
    .replace(/[\/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/\.+$/g, "");

  return cleaned || fallback;
}

function sanitizeStem(value, fallback = "file") {
  const cleaned = String(value ?? "")
    .trim()
    .replace(/\.[^/.]+$/, "")
    .replace(/[\/\\?%*:|"<>]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();

  return cleaned || fallback;
}

function fileStamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-").replace("T", "_").replace("Z", "");
}

function extensionForMime(mimeType) {
  switch (String(mimeType ?? "").toLowerCase()) {
    case "application/pdf": return ".pdf";
    case "image/jpeg": return ".jpg";
    case "image/png": return ".png";
    case "image/webp": return ".webp";
    case "image/gif": return ".gif";
    case "image/heic": return ".heic";
    case "text/plain": return ".txt";
    case "application/msword": return ".doc";
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document": return ".docx";
    case "application/vnd.ms-excel": return ".xls";
    case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": return ".xlsx";
    case "application/rtf":
    case "text/rtf":
      return ".rtf";
    default:
      return "";
  }
}

function parseAttachmentDataUrl(dataUrl) {
  const match = String(dataUrl ?? "").match(/^data:([^;]+);base64,(.+)$/s);
  if (!match) {
    throw new Error("Invalid attachment payload.");
  }

  return {
    mimeType: match[1] || "application/octet-stream",
    buffer: Buffer.from(match[2], "base64"),
  };
}

function coerceBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (value instanceof ArrayBuffer) return Buffer.from(new Uint8Array(value));
  return null;
}

function buildSubmissionPaths(data, submissionId) {
  const agencyFolder = sanitizeSegment(data.agency ?? "unknown_agency");
  const submissionFolder = sanitizeSegment(submissionId, submissionId);
  const relativeSubmissionDir = path.posix.join("resume_output", agencyFolder, submissionFolder);

  return {
    agencyFolder,
    submissionFolder,
    relativeSubmissionDir,
    relativePdfPath: path.posix.join(relativeSubmissionDir, "resume.pdf"),
    relativeManifestPath: path.posix.join(relativeSubmissionDir, "submission.json"),
    relativeAttachmentDir: path.posix.join(relativeSubmissionDir, "attachments"),
  };
}

function normalizeAttachmentInput(item, index, relativeAttachmentDir) {
  const originalName = String(item.name ?? `attachment-${index + 1}`).trim() || `attachment-${index + 1}`;
  const extensionFromName = path.extname(originalName).toLowerCase();
  const sourcePath = item.tempPath || item.sourcePath || "";
  const rawBuffer = coerceBuffer(item.buffer);
  const payload = rawBuffer
    ? { buffer: rawBuffer, mimeType: item.type || item.mimeType || "application/octet-stream" }
    : sourcePath
      ? { buffer: null, mimeType: item.type || item.mimeType || "application/octet-stream" }
      : parseAttachmentDataUrl(item.dataUrl);
  const extension = extensionFromName || extensionForMime(item.type || payload.mimeType) || ".bin";
  const stem = sanitizeStem(originalName, `attachment-${index + 1}`);
  const fileName = `${String(index + 1).padStart(2, "0")}_${stem}${extension}`;
  const storagePath = path.posix.join(relativeAttachmentDir, fileName);

  return {
    originalName,
    mimeType: item.type || payload.mimeType || "application/octet-stream",
    size: Number(item.size || (payload.buffer ? payload.buffer.length : 0)) || 0,
    buffer: payload.buffer,
    sourcePath: sourcePath || null,
    storagePath,
  };
}

async function writeLocalSubmissionArtifacts(paths, pdfBuffer, data, submissionId, attachmentInputs) {
  const localSubmissionDir = path.join(OUTPUT_ROOT, paths.agencyFolder, paths.submissionFolder);
  const localAttachmentDir = path.join(localSubmissionDir, "attachments");
  await fsPromises.mkdir(localAttachmentDir, { recursive: true });

  const localPdfPath = path.join(localSubmissionDir, "resume.pdf");
  await fsPromises.writeFile(localPdfPath, pdfBuffer);

  const attachmentArtifacts = [];
  for (let index = 0; index < attachmentInputs.length; index += 1) {
    const attachment = normalizeAttachmentInput(attachmentInputs[index], index, paths.relativeAttachmentDir);
    const localAttachmentRelativePath = attachment.storagePath.replace(/^resume_output[\\/]/, "");
    const localAttachmentPath = path.join(OUTPUT_ROOT, localAttachmentRelativePath);
    if (attachment.sourcePath) {
      await fsPromises.copyFile(attachment.sourcePath, localAttachmentPath);
    } else {
      await fsPromises.writeFile(localAttachmentPath, attachment.buffer);
    }
    attachmentArtifacts.push({
      originalName: attachment.originalName,
      mimeType: attachment.mimeType,
      size: attachment.size,
      storagePath: attachment.storagePath,
      localPath: attachment.storagePath,
      buffer: attachment.buffer,
      sourcePath: attachment.sourcePath,
    });
  }

  const manifest = {
    submissionId,
    createdAt: new Date().toISOString(),
    agency: data.agency ?? null,
    partnerAgency: data.partnerAgency ?? null,
    partnerCountry: data.partnerCountry ?? null,
    partnerLinkCode: data.partnerLinkCode ?? null,
    partnerLinkLabel: data.partnerLinkLabel ?? null,
    name: data.name ?? null,
    pdfPath: paths.relativePdfPath,
    attachmentCount: attachmentArtifacts.length,
    attachments: attachmentArtifacts.map(({ buffer, sourcePath, ...summary }) => summary),
  };

  const manifestJson = JSON.stringify(manifest, null, 2);
  await fsPromises.writeFile(path.join(localSubmissionDir, "submission.json"), manifestJson);

  return {
    localPdfPath,
    localManifestPath: path.join(localSubmissionDir, "submission.json"),
    attachmentArtifacts,
    manifestJson,
  };
}

async function uploadBody(relativePath, body, contentType) {
  const { error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(relativePath, body, { contentType, upsert: true });

  if (error) throw error;
}

async function mirrorSubmission(paths, pdfBuffer, manifestJson, attachmentArtifacts, data, submissionId) {
  if (!supabase) {
    return {
      storageOk: false,
      databaseOk: false,
      pdfUrl: null,
      attachmentMirrorOk: false,
      attachmentErrors: [],
      mirrorError: "Supabase credentials are not configured.",
    };
  }

  const warnings = [];
  let pdfUrl = null;
  let storageOk = false;
  let attachmentMirrorOk = attachmentArtifacts.length === 0;
  const attachmentErrors = [];
  let databaseOk = false;

  try {
    await uploadBody(paths.relativePdfPath, pdfBuffer, "application/pdf");
    storageOk = true;

    const { data: signedData, error: urlError } = await supabase.storage
      .from(STORAGE_BUCKET)
      .createSignedUrl(paths.relativePdfPath, 60 * 60 * 24 * 365);
    if (urlError) throw urlError;
    pdfUrl = signedData.signedUrl;
  } catch (err) {
    warnings.push(`Resume mirror issue: ${err.message}`);
  }

  try {
    await uploadBody(paths.relativeManifestPath, Buffer.from(manifestJson, "utf8"), "application/json");
  } catch (err) {
    warnings.push(`Manifest mirror issue: ${err.message}`);
  }

  const attachmentResults = await Promise.allSettled(
    attachmentArtifacts.map(attachment =>
      uploadBody(
        attachment.storagePath,
        attachment.sourcePath ? fs.createReadStream(attachment.sourcePath) : attachment.buffer,
        attachment.mimeType || "application/octet-stream"
      )
    )
  );
  attachmentResults.forEach((result, index) => {
    if (result.status === "rejected") {
      attachmentErrors.push({
        name: attachmentArtifacts[index].originalName,
        error: result.reason?.message || "Attachment upload failed",
      });
    }
  });
  attachmentMirrorOk = attachmentErrors.length === 0;
  if (attachmentErrors.length) {
    const failedNames = attachmentErrors.map(item => item.name).filter(Boolean);
    const preview = failedNames.slice(0, 3).join(", ");
    const suffix = failedNames.length > 3 ? ` and ${failedNames.length - 3} more` : "";
    warnings.push(`Attachment mirror issue: ${preview}${suffix}.`);
  }

  try {
    const { error: dbError } = await supabase.from("resume_submissions").insert({
      psid: submissionId,
      agency: data.agency ?? null, name: data.name ?? null,
      dob: data.dob ?? null, nationality: data.nationality ?? null,
      country: data.country ?? null, city: data.city ?? null,
      phone: data.phone ?? null, email: data.email ?? null,
      job_type: data.jobType ?? null, work_arrange: data.workArrange ?? null,
      availability: data.availability ?? null, salary: data.salary || null,
      experience: data.experience ?? null,
      job1_title: data.job1Title ?? null, job1_company: data.job1Company ?? null, job1_dates: data.job1Dates ?? null,
      job2_title: data.job2Title || null, job2_company: data.job2Company || null, job2_dates: data.job2Dates || null,
      job3_title: data.job3Title || null, job3_company: data.job3Company || null, job3_dates: data.job3Dates || null,
      skills: data.skills ?? null, certs: data.certs || null,
      education: data.education ?? null, languages: data.languages ?? null,
      pdf_url: pdfUrl,
    });
    if (dbError) throw dbError;
    databaseOk = true;
  } catch (err) {
    warnings.push(`Database mirror issue: ${err.message}`);
  }

  return {
    storageOk,
    databaseOk,
    pdfUrl,
    attachmentMirrorOk,
    attachmentErrors,
    mirrorError: warnings.length ? warnings.join(" | ") : null,
  };
}

function stripEmoji(str) {
  return String(str ?? "")
    .replace(/[\u{1F000}-\u{1FFFF}]/gu, "")
    .replace(/[\u{2600}-\u{27BF}]/gu, "")
    .replace(/️/gu, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function buildPDF(d) {
  // Sanitize all string fields — Helvetica cannot render emoji or flag characters
  const clean = {};
  for (const [k, v] of Object.entries(d)) {
    clean[k] = typeof v === "string" ? stripEmoji(v) : v;
  }
  d = clean;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const chunks = [];
    doc.on("data", chunk => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const skip = v => !v || v === "NA";
    const location = [d.city, d.country].filter(Boolean).join(", ");
    const today = new Date().toLocaleDateString("en-SG", { year: "numeric", month: "long", day: "numeric" });

    // Header
    doc.fontSize(18).font("Helvetica-Bold").text((d.name ?? "").toUpperCase(), { align: "center" });
    doc.moveDown(0.2);
    doc.fontSize(10).font("Helvetica").fillColor("#444444")
       .text([d.phone, d.email, location, d.nationality].filter(Boolean).join("  |  "), { align: "center" });
    doc.moveDown(0.1);
    doc.fontSize(9).fillColor("#888888").text(`Submitted to: ${d.agency ?? ""}`, { align: "center" });
    if (d.partnerAgency || d.partnerCountry) {
      const routedBy = [d.partnerAgency, d.partnerCountry].filter(Boolean).join(" • ");
      doc.moveDown(0.1);
      doc.fontSize(9).fillColor("#888888").text(`Partner link: ${routedBy}`, { align: "center" });
    }
    doc.moveDown(0.3);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).lineWidth(2).strokeColor("#111111").stroke();
    doc.moveDown(0.5);

    function sectionTitle(title) {
      doc.moveDown(0.3);
      doc.fontSize(9).font("Helvetica-Bold").fillColor("#111111").text(title.toUpperCase(), { characterSpacing: 1.5 });
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
      if (!skip(dt)) { doc.font("Helvetica").fillColor("#555555").text("  " + dt, { align: "right" }); }
      else { doc.text(""); }
      if (!skip(c)) doc.fontSize(10).font("Helvetica-Oblique").fillColor("#555555").text(c);
      doc.moveDown(0.3);
    }

    sectionTitle("Personal Details");
    infoRow("Date of birth", d.dob);
    infoRow("Nationality", d.nationality);
    infoRow("Current location", location);
    infoRow("Work arrangement", d.workArrange);
    infoRow("Availability", d.availability);
    if (!skip(d.salary)) infoRow("Expected salary (SGD)", d.salary);

    sectionTitle("Objective");
    doc.fontSize(10).font("Helvetica").fillColor("#111111")
       .text(`Seeking a ${d.jobType ?? ""} position in Singapore. ${d.experience ?? ""} of relevant work experience. Available to start ${d.availability ?? "immediately"}.`);

    sectionTitle("Work Experience");
    if (!skip(d.job1Title)) { jobBlock(1); jobBlock(2); jobBlock(3); }
    else doc.fontSize(10).font("Helvetica-Oblique").fillColor("#888888").text("No work history provided.");

    sectionTitle("Skills");
    if (!skip(d.skills)) pills(d.skills);
    else doc.fontSize(10).font("Helvetica-Oblique").fillColor("#888888").text("Not provided.");

    if (!skip(d.certs)) { sectionTitle("Certifications & Licences"); pills(d.certs); }

    sectionTitle("Education");
    doc.fontSize(10).font("Helvetica").fillColor("#111111").text(d.education ?? "—");

    sectionTitle("Languages");
    if (!skip(d.languages)) pills(d.languages);
    else doc.fontSize(10).font("Helvetica-Oblique").fillColor("#888888").text("Not provided.");

    doc.moveDown(1);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).lineWidth(0.5).strokeColor("#dddddd").stroke();
    doc.moveDown(0.3);
    const footerParts = ["Generated by JobReady", today, `For: ${d.agency ?? ""}`];
    if (d.partnerAgency) footerParts.push(`Via: ${d.partnerAgency}`);
    doc.fontSize(8).font("Helvetica").fillColor("#aaaaaa")
       .text(footerParts.join("  •  "), { align: "center" });

    doc.end();
  });
}

async function generateAndStorePDF(data, submissionId, attachments = []) {
  const pdfBuffer = await buildPDF(data);
  const paths = buildSubmissionPaths(data, submissionId);
  const localArtifacts = await writeLocalSubmissionArtifacts(paths, pdfBuffer, data, submissionId, attachments);
  const mirror = await mirrorSubmission(
    paths,
    pdfBuffer,
    localArtifacts.manifestJson,
    localArtifacts.attachmentArtifacts,
    data,
    submissionId
  );

  console.log(`✅ PDF stored locally: ${paths.relativePdfPath}`);
  if (localArtifacts.attachmentArtifacts.length) {
    console.log(`✅ ${localArtifacts.attachmentArtifacts.length} attachment(s) stored locally`);
  }
  if (mirror.storageOk) console.log(`✅ PDF mirrored to Supabase: ${paths.relativePdfPath}`);

  return {
    localUrl: `/${paths.relativePdfPath}`,
    storagePath: paths.relativePdfPath,
    pdfUrl: mirror.pdfUrl,
    storageOk: mirror.storageOk,
    databaseOk: mirror.databaseOk,
    attachmentMirrorOk: mirror.attachmentMirrorOk,
    attachmentErrors: mirror.attachmentErrors,
    mirrorError: mirror.mirrorError,
    attachmentCount: localArtifacts.attachmentArtifacts.length,
  };
}

module.exports = { generateAndStorePDF, buildPDF };
