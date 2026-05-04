"use strict";

const fs = require("fs");
const fsPromises = fs.promises;
const path = require("path");
const PDFDocument = require("pdfkit");
const { PDFDocument: PdfLib } = require("pdf-lib");
const sharp = require("sharp");
const { createClient } = require("@supabase/supabase-js");

const supabaseUrl = process.env.SUPABASE_URL || "https://qpnkmqczvlmrxofqgzdu.supabase.co";
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
if (!supabaseServiceKey) {
  console.error("[pdf] SUPABASE_SERVICE_KEY is not set — storage uploads will be disabled. Set this to the service_role key from Supabase → Project Settings → API.");
}
const supabase = supabaseServiceKey ? createClient(supabaseUrl, supabaseServiceKey) : null;

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
      localPath: localAttachmentPath,   // absolute path — used for storage upload
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
  console.log(`[pdf] uploaded: ${relativePath}`);
}

async function mirrorSubmission(paths, pdfBuffer, manifestJson, attachmentArtifacts, data, submissionId) {
  if (!supabase) {
    console.warn("[pdf] mirrorSubmission skipped — no Supabase client");
    return {
      storageOk: false,
      databaseOk: false,
      pdfUrl: null,
      attachmentMirrorOk: false,
      attachmentErrors: [],
      mirrorError: "Supabase credentials are not configured.",
    };
  }
  console.log(`[pdf] mirrorSubmission: ${attachmentArtifacts.length} attachment(s), bucket=${STORAGE_BUCKET}`);

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
    attachmentArtifacts.map(attachment => {
      // Prefer the local copy (absolute path, written moments ago) over the original temp file
      const body = attachment.localPath
        ? fs.createReadStream(attachment.localPath)
        : attachment.buffer;
      if (!body) {
        return Promise.reject(new Error(`No data available for ${attachment.originalName}`));
      }
      console.log(`[pdf] uploading attachment: ${attachment.storagePath}`);
      return uploadBody(attachment.storagePath, body, attachment.mimeType || "application/octet-stream");
    })
  );
  attachmentResults.forEach((result, index) => {
    if (result.status === "rejected") {
      console.error(`[pdf] attachment upload failed (${attachmentArtifacts[index].originalName}): ${result.reason?.message}`);
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

async function buildPDF(d) {
  // Sanitize all string fields — Helvetica cannot render emoji or flag characters
  const clean = {};
  for (const [k, v] of Object.entries(d)) {
    clean[k] = typeof v === "string" ? stripEmoji(v) : v;
  }
  d = clean;

  // Pre-process photo to a JPEG buffer sized for top-right placement
  let photoBuffer = null;
  if (d.photo && typeof d.photo === "string") {
    try {
      const { buffer: rawBuf } = parseAttachmentDataUrl(d.photo);
      photoBuffer = await sharp(rawBuf)
        .rotate()
        .resize(200, 250, { fit: "cover", position: "centre" })
        .jpeg({ quality: 88 })
        .toBuffer();
    } catch (err) {
      console.warn("[pdf] photo conversion failed:", err.message);
    }
  }

  return new Promise((resolve, reject) => {
    const L = 50, R = 545, W = R - L;
    const PHOTO_W = 90, PHOTO_H = 113, PHOTO_GAP = 14;
    const TOP = 48;
    const textW = photoBuffer ? W - PHOTO_W - PHOTO_GAP : W;
    const textAlign = photoBuffer ? "left" : "center";

    const doc = new PDFDocument({ size: "A4", margins: { top: TOP, bottom: 48, left: L, right: 50 } });
    const chunks = [];
    doc.on("data", chunk => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const skip = v => !v || String(v).trim() === "" || v === "NA";
    const location = [d.city, d.country].filter(v => !skip(v)).join(", ");
    const today = new Date().toLocaleDateString("en-SG", { year: "numeric", month: "long", day: "numeric" });

    // ── Header ────────────────────────────────────────────────────
    if (photoBuffer) {
      doc.image(photoBuffer, R - PHOTO_W, TOP, { width: PHOTO_W, height: PHOTO_H });
    }

    // Name
    doc.fontSize(20).font("Helvetica-Bold").fillColor("#111111")
       .text((d.name ?? "").toUpperCase(), L, TOP, { width: textW, align: textAlign });
    doc.moveDown(0.2);

    const contactParts = [d.phone, d.email, location].filter(v => !skip(v));
    if (contactParts.length) {
      doc.fontSize(9.5).font("Helvetica").fillColor("#444444")
         .text(contactParts.join("   |   "), { width: textW, align: textAlign });
    }
    if (!skip(d.nationality)) {
      doc.fontSize(9).fillColor("#666666")
         .text(d.nationality, { width: textW, align: textAlign });
    }

    // Routing note (small, below contact)
    const routingParts = [];
    if (!skip(d.agency)) routingParts.push(`Submitted to: ${d.agency}`);
    if (!skip(d.partnerAgency)) {
      const via = [d.partnerAgency, d.partnerCountry].filter(v => !skip(v)).join(", ");
      routingParts.push(`Via: ${via}`);
    }
    if (routingParts.length) {
      doc.moveDown(0.15);
      doc.fontSize(8).fillColor("#999999").text(routingParts.join("   |   "), { width: textW, align: textAlign });
    }

    // Ensure cursor clears the photo before drawing the divider
    const dividerY = photoBuffer ? Math.max(doc.y + 6, TOP + PHOTO_H + 10) : doc.y + 10;
    doc.moveTo(L, dividerY).lineTo(R, dividerY).lineWidth(1.5).strokeColor("#111111").stroke();
    doc.y = dividerY + 10;

    // ── Section title ─────────────────────────────────────────────
    function section(title) {
      if (doc.y > 700) doc.addPage();
      else doc.moveDown(0.5);
      doc.fontSize(8.5).font("Helvetica-Bold").fillColor("#111111")
         .text(title.toUpperCase(), L, doc.y, { align: "left", characterSpacing: 1.2, width: W });
      doc.moveDown(0.05);
      doc.moveTo(L, doc.y).lineTo(R, doc.y).lineWidth(0.5).strokeColor("#bbbbbb").stroke();
      doc.moveDown(0.35);
    }

    // ── Two-column label: value row ───────────────────────────────
    function infoRow(label, value) {
      if (skip(value)) return;
      const y = doc.y;
      doc.fontSize(9.5).font("Helvetica-Bold").fillColor("#555555")
         .text(label, L, y, { width: 155, lineBreak: false });
      doc.fontSize(9.5).font("Helvetica").fillColor("#111111")
         .text(value, L + 160, y, { width: W - 160 });
      doc.moveDown(0.15);
    }

    // ── Inline comma list ─────────────────────────────────────────
    function inlineList(str) {
      if (skip(str)) return;
      const items = str.split(/[,،]+/).map(s => s.trim()).filter(Boolean);
      if (!items.length) return;
      doc.fontSize(9.5).font("Helvetica").fillColor("#111111")
         .text(items.join(", "), { width: W });
    }

    // ── Job entry ─────────────────────────────────────────────────
    function jobBlock(n) {
      const title = d[`job${n}Title`];
      const company = d[`job${n}Company`];
      const dates = d[`job${n}Dates`];
      if (skip(title)) return;

      // Company + dates on first line
      const companyLine = [company, dates].filter(v => !skip(v)).join("   ·   ");
      if (companyLine) {
        doc.fontSize(9.5).font("Helvetica").fillColor("#555555")
           .text(companyLine, { width: W });
        doc.moveDown(0.15);
      }
      // Designation (title) below, bold
      doc.fontSize(10).font("Helvetica-Bold").fillColor("#111111")
         .text(title, { width: W });
      doc.moveDown(0.4);
    }

    // ── Personal Details ──────────────────────────────────────────
    section("Personal Details");
    infoRow("Date of Birth", d.dob);
    infoRow("Nationality", d.nationality);
    if (!skip(location)) infoRow("Current Location", location);
    infoRow("Availability", d.availability);
    infoRow("Work Arrangement", d.workArrange);
    if (!skip(d.salary)) infoRow("Expected Salary (SGD)", d.salary);

    // ── Job Preferences ───────────────────────────────────────────
    const jobPrefs = [];
    if (!skip(d.jobType)) jobPrefs.push(`Job type: ${d.jobType}`);
    if (!skip(d.experience)) jobPrefs.push(`Experience: ${d.experience}`);
    if (jobPrefs.length) {
      section("Job Objective");
      jobPrefs.forEach(p => {
        doc.fontSize(9.5).font("Helvetica").fillColor("#111111").text(p, { width: W });
        doc.moveDown(0.15);
      });
    }

    // ── Work Experience ───────────────────────────────────────────
    section("Work Experience");
    let hasJobs = false;
    for (let n = 1; n <= 50; n++) {
      if (skip(d[`job${n}Title`])) break;
      jobBlock(n);
      hasJobs = true;
    }
    if (!hasJobs) {
      doc.fontSize(9.5).font("Helvetica-Oblique").fillColor("#888888").text("No work history provided.", { width: W });
    }

    // ── Skills ────────────────────────────────────────────────────
    if (!skip(d.skills)) {
      section("Skills");
      inlineList(d.skills);
    }

    // ── Certifications ────────────────────────────────────────────
    const certsText = Array.isArray(d.certsList) && d.certsList.length
      ? d.certsList.map(c => c.name).join(", ")
      : (d.certs || "");
    if (!skip(certsText)) {
      section("Certifications & Licences");
      inlineList(certsText);
    }

    // ── Education ─────────────────────────────────────────────────
    if (!skip(d.education)) {
      section("Education");
      doc.fontSize(9.5).font("Helvetica").fillColor("#111111").text(d.education, { width: W });
    }

    // ── Languages ─────────────────────────────────────────────────
    if (!skip(d.languages)) {
      section("Languages");
      inlineList(d.languages);
    }

    // ── Footer ────────────────────────────────────────────────────
    doc.moveDown(1.2);
    doc.moveTo(L, doc.y).lineTo(R, doc.y).lineWidth(0.4).strokeColor("#cccccc").stroke();
    doc.moveDown(0.35);
    const footerParts = ["Generated by JobReady", today, `For: ${d.agency ?? ""}`];
    if (!skip(d.partnerAgency)) footerParts.push(`Via: ${d.partnerAgency}`);
    doc.fontSize(7.5).font("Helvetica").fillColor("#aaaaaa")
       .text(footerParts.join("  •  "), { align: "center", width: W });

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

async function mergeAttachmentsIntoPDF(resumeBuffer, attachmentBuffers) {
  if (!attachmentBuffers || attachmentBuffers.length === 0) return resumeBuffer;

  const merged = await PdfLib.create();

  // Copy resume pages first
  const resumePdf = await PdfLib.load(resumeBuffer);
  const resumePages = await merged.copyPages(resumePdf, resumePdf.getPageIndices());
  for (const page of resumePages) merged.addPage(page);

  for (const att of attachmentBuffers) {
    const mime = (att.mimeType || "").toLowerCase();
    try {
      if (mime === "application/pdf") {
        const attPdf = await PdfLib.load(att.data);
        const attPages = await merged.copyPages(attPdf, attPdf.getPageIndices());
        for (const page of attPages) merged.addPage(page);
      } else {
        // Convert any image format (JPEG, PNG, AVIF, HEIC, WebP, GIF, TIFF …) to JPEG via sharp
        const jpegBuf = await sharp(att.data).rotate().jpeg({ quality: 90 }).toBuffer();
        const img = await merged.embedJpg(jpegBuf);
        const { width, height } = img.scale(1);
        const page = merged.addPage([width, height]);
        page.drawImage(img, { x: 0, y: 0, width, height });
      }
    } catch (err) {
      console.warn(`Skipping attachment in merge (${att.name}): ${err.message}`);
    }
  }

  const mergedBuffer = await merged.save();
  return Buffer.from(mergedBuffer);
}

module.exports = { generateAndStorePDF, buildPDF, mergeAttachmentsIntoPDF };
