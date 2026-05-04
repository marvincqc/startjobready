"use strict";

const fs = require("fs");
const fsp = fs.promises;
const express = require("express");
const path    = require("path");
const os = require("os");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");
require("dotenv").config();

const { createClient } = require("@supabase/supabase-js");
const { generateAndStorePDF, buildPDF, mergeAttachmentsIntoPDF } = require("./src/pdf");
const packageInfo = require("./package.json");

// Supabase admin client (service role for server-side inserts + JWT validation)
// Lazy init so missing env vars don't crash the server on startup
let _supabase = null;
function getSupabase() {
  if (!_supabase) {
    const url = process.env.SUPABASE_URL || "https://qpnkmqczvlmrxofqgzdu.supabase.co";
    const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
    if (!key) throw new Error("SUPABASE_SERVICE_KEY env var is required.");
    _supabase = createClient(url, key);
  }
  return _supabase;
}
// Convenience proxy so existing code using `supabase.from(...)` still works
const supabase = new Proxy({}, {
  get(_, prop) {
    try { return getSupabase()[prop]; }
    catch (e) {
      // Return a function that rejects, so async handlers surface a proper error
      // instead of an uncaught synchronous throw that kills the process.
      return (...args) => Promise.reject(e);
    }
  },
});

const app = express();
const rootDir = __dirname;
const resumeOutputDir = path.join(rootDir, "resume_output");
const agencyLinksPath = path.join(rootDir, "config", "agency-links.json");
const appName = "JobReady";

// /resume_output is NOT served as a public static directory.
// PDFs are gated behind /api/pdf/:filename (see below).
app.use(express.static(path.join(rootDir, "public"), { index: false }));
app.use(express.json({ limit: "50mb" }));

function getDeploymentMeta() {
  const commit = String(process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || "").trim();
  const branch = String(process.env.RENDER_GIT_BRANCH || process.env.GIT_BRANCH || "").trim();

  return {
    app: appName,
    version: packageInfo.version,
    commit: commit || null,
    branch: branch || null,
  };
}

function sanitizeTempSegment(value, fallback = "attachment") {
  const cleaned = String(value ?? "")
    .trim()
    .replace(/[\/\\?%*:|"<>]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();

  return cleaned || fallback;
}

function normalizeAgencyLinkSlug(value) {
  const cleaned = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return cleaned;
}

function readAgencyLinks() {
  try {
    const raw = fs.readFileSync(agencyLinksPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .map(item => {
        const slug = normalizeAgencyLinkSlug(item.slug || item.code);
        const targetAgency = String(item.targetAgency || item.agency || "").trim();
        if (!slug || !targetAgency) return null;

        return {
          slug,
          targetAgency,
          partnerAgency: String(item.partnerAgency || item.sourceAgency || "").trim() || null,
          partnerCountry: String(item.partnerCountry || "").trim() || null,
          linkLabel: String(item.linkLabel || item.name || "").trim() || null,
          description: String(item.description || "").trim() || null,
          lockAgency: item.lockAgency !== false,
        };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function buildPartnerResumeUrl(link) {
  const params = new URLSearchParams();
  params.set("agency", link.targetAgency);
  params.set("partnerLinkCode", link.slug);
  if (link.partnerAgency) params.set("partnerAgency", link.partnerAgency);
  if (link.partnerCountry) params.set("partnerCountry", link.partnerCountry);
  if (link.linkLabel) params.set("linkLabel", link.linkLabel);
  if (link.lockAgency) params.set("lockAgency", "1");
  return `/resume?${params.toString()}`;
}

function buildSubmissionId(data) {
  const stamp = Date.now();
  const linkCode = sanitizeTempSegment(data?.partnerLinkCode || "", "").replace(/_/g, "-");
  return linkCode ? `web-${linkCode}-${stamp}` : `web-${stamp}`;
}

function cleanupTempDir(dir) {
  if (!dir) return Promise.resolve();
  return fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
}

function detectMime(buf) {
  if (!buf || buf.length < 4) return null;
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return "image/jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return "image/png";
  if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return "application/pdf";
  return null;
}

async function writeUploadedFile(file, tempPath) {
  const source = typeof file?.stream === "function" ? Readable.fromWeb(file.stream()) : null;
  if (!source) {
    throw new Error("Unsupported uploaded file payload.");
  }

  await pipeline(source, fs.createWriteStream(tempPath));
}

async function readMultipartSubmission(req) {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "jobready-upload-"));
  try {
    const request = new Request(new URL(req.originalUrl || req.url, "http://127.0.0.1").toString(), {
      method: req.method,
      headers: req.headers,
      body: req,
      duplex: "half",
    });

    const formData = await request.formData();
    const payloadRaw = formData.get("payload");
    if (typeof payloadRaw !== "string" || !payloadRaw.trim()) {
      const err = new Error("Missing submission payload.");
      err.statusCode = 400;
      throw err;
    }

    let payload;
    try {
      payload = JSON.parse(payloadRaw);
    } catch {
      const err = new Error("Invalid submission payload.");
      err.statusCode = 400;
      throw err;
    }

    const attachmentFiles = formData.getAll("attachments");
    const attachments = [];
    for (const file of attachmentFiles) {
      if (!file || typeof file.stream !== "function") continue;

      const baseName = path.basename(file.name || "attachment", path.extname(file.name || ""));
      const safeStem = sanitizeTempSegment(baseName, "attachment");
      const ext = path.extname(file.name || "").toLowerCase();
      const tempPath = path.join(
        tempDir,
        `${String(attachments.length + 1).padStart(2, "0")}_${safeStem}${ext || ""}`
      );

      await writeUploadedFile(file, tempPath);
      attachments.push({
        name: file.name || "attachment",
        type: file.type || "application/octet-stream",
        size: file.size || 0,
        tempPath,
      });
    }

    return {
      data: payload.data,
      lang: payload.lang,
      attachments,
      cleanupDir: tempDir,
    };
  } catch (err) {
    await cleanupTempDir(tempDir);
    throw err;
  }
}

async function readSubmissionInput(req) {
  const contentType = String(req.headers["content-type"] || "");
  if (contentType.includes("multipart/form-data")) {
    return readMultipartSubmission(req);
  }

  const body = req.body ?? {};
  return {
    data: body.data,
    lang: body.lang,
    attachments: Array.isArray(body.attachments) ? body.attachments : [],
    cleanupDir: null,
  };
}

// ─── Simple in-memory rate limiter ────────────────────────────────────────────
const _rateBuckets = new Map();
function rateLimit({ windowMs, max }) {
  return (req, res, next) => {
    const key = req.ip || "unknown";
    const now = Date.now();
    let bucket = _rateBuckets.get(key);
    if (!bucket || now - bucket.start > windowMs) {
      bucket = { start: now, count: 0 };
      _rateBuckets.set(key, bucket);
    }
    bucket.count++;
    if (bucket.count > max) {
      return res.status(429).json({ ok: false, error: "Too many requests. Please wait before submitting again." });
    }
    next();
  };
}

// ─── Auth middleware ──────────────────────────────────────────────────────────
async function requireAuth(req, res, next) {
  const authHeader = req.headers["authorization"] || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ ok: false, error: "Unauthorized" });

  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ ok: false, error: "Unauthorized" });

  req.user = user;
  next();
}

const SUPER_ADMIN = "marvincqc@gmail.com";

// ─── Plan limits ──────────────────────────────────────────────────────────────
const PLAN_LIMITS = {
  free:  { maxLinks: 3,        maxSubmissionsPerMonth: 20 },
  pro:   { maxLinks: 25,       maxSubmissionsPerMonth: 500 },
  scale: { maxLinks: Infinity, maxSubmissionsPerMonth: Infinity },
};
const VALID_PLANS = Object.keys(PLAN_LIMITS);
const planOf = (agency) => PLAN_LIMITS[agency?.plan] || PLAN_LIMITS.free;

async function countActiveLinks(agencyId) {
  const { count } = await supabase
    .from("partner_links")
    .select("*", { count: "exact", head: true })
    .eq("agency_id", agencyId)
    .eq("active", true);
  return count || 0;
}

async function countSubmissionsThisMonth(agencyId) {
  const start = new Date();
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  const { count } = await supabase
    .from("submissions")
    .select("*", { count: "exact", head: true })
    .eq("agency_id", agencyId)
    .gte("created_at", start.toISOString());
  return count || 0;
}

async function loadAgencyUsage(agency) {
  const limits = planOf(agency);
  const [activeLinks, submissionsThisMonth] = await Promise.all([
    countActiveLinks(agency.id),
    countSubmissionsThisMonth(agency.id),
  ]);
  return {
    plan: agency.plan || "free",
    activeLinks,
    activeLinksLimit: limits.maxLinks === Infinity ? null : limits.maxLinks,
    submissionsThisMonth,
    submissionsLimit: limits.maxSubmissionsPerMonth === Infinity ? null : limits.maxSubmissionsPerMonth,
  };
}

// ─── Authenticated PDF download ───────────────────────────────────────────────
// Accepts ?id=<submission_id> and generates a short-lived Supabase Storage signed URL.
// Falls back to local disk for dev/testing.
app.get("/api/pdf/download", async (req, res) => {
  const token = (() => {
    const h = req.headers["authorization"] || "";
    if (h.startsWith("Bearer ")) return h.slice(7);
    return req.query.token || null;
  })();
  if (!token) return res.status(401).send("Unauthorized");

  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) return res.status(401).send("Unauthorized");

  const submissionId = req.query.id;
  if (!submissionId) return res.status(400).send("Missing submission id");

  const isAdmin = user.email === SUPER_ADMIN;

  // Admin can download any submission; agency users only their own
  let sub;
  if (isAdmin) {
    const { data } = await supabase
      .from("submissions")
      .select("data, attachment_count, pdf_path")
      .eq("id", submissionId)
      .maybeSingle();
    sub = data;
  } else {
    const { data: agency } = await supabase
      .from("agencies")
      .select("id")
      .eq("auth_id", user.id)
      .maybeSingle();
    if (!agency) return res.status(403).send("Forbidden");
    const { data } = await supabase
      .from("submissions")
      .select("data, attachment_count, pdf_path")
      .eq("id", submissionId)
      .eq("agency_id", agency.id)
      .maybeSingle();
    sub = data;
  }
  if (!sub) return res.status(404).json({ ok: false, error: "Submission not found" });
  if (!sub.data) return res.status(404).json({ ok: false, error: "No data stored for this submission" });

  // Build resume PDF
  const workerName = (sub.data.name || "resume").replace(/[^a-z0-9_\- ]/gi, "").trim().replace(/\s+/g, "_") || "resume";
  let pdfBuffer = await buildPDF(sub.data);

  // Fetch and merge attachments using the manifest stored alongside the submission.
  // The manifest contains exact storagePaths written at upload time — no reconstruction needed.
  try {
    const pdfPath = sub.pdf_path || "";
    if (pdfPath) {
      const manifestPath = pdfPath.replace(/\/resume\.pdf$/, "/submission.json");
      console.log(`[pdf-download] fetching manifest: ${manifestPath}`);
      const { data: manifestBlob, error: manifestErr } = await supabase.storage
        .from("Resumes").download(manifestPath);
      if (manifestErr) {
        console.warn(`[pdf-download] manifest download error: ${manifestErr.message}`);
      } else if (manifestBlob) {
        const manifestJson = await manifestBlob.text();
        const manifest = JSON.parse(manifestJson);
        const attEntries = Array.isArray(manifest.attachments) ? manifest.attachments : [];
        console.log(`[pdf-download] manifest has ${attEntries.length} attachment(s)`);
        const attBuffers = [];
        for (const att of attEntries) {
          const mime = (att.mimeType || "").toLowerCase();
          if (mime !== "application/pdf" && mime !== "image/jpeg" && mime !== "image/png" && mime !== "image/jpg") {
            console.log(`[pdf-download] skipping unsupported mime: ${att.mimeType} (${att.originalName})`);
            continue;
          }
          const { data: fileBlob, error: dlErr } = await supabase.storage
            .from("Resumes").download(att.storagePath);
          if (dlErr || !fileBlob) {
            console.warn(`[pdf-download] could not download ${att.storagePath}: ${dlErr?.message}`);
            continue;
          }
          const buf = Buffer.from(await fileBlob.arrayBuffer());
          attBuffers.push({ name: att.originalName, mimeType: mime === "image/jpg" ? "image/jpeg" : mime, data: buf });
        }
        if (attBuffers.length > 0) {
          console.log(`[pdf-download] merging ${attBuffers.length} attachment(s)`);
          pdfBuffer = await mergeAttachmentsIntoPDF(pdfBuffer, attBuffers);
        }
      }
    } else {
      console.warn(`[pdf-download] no pdf_path stored for submission ${submissionId} — skipping attachments`);
    }
  } catch (mergeErr) {
    console.warn(`[pdf-download] merge error (returning resume only): ${mergeErr.message}`);
  }

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${workerName}_resume.pdf"`);
  res.setHeader("Content-Length", pdfBuffer.length);
  res.send(pdfBuffer);
});

// Legacy route kept so old links don't hard-404
app.get("/api/pdf/:filename", async (req, res) => {
  const token = (() => {
    const h = req.headers["authorization"] || "";
    if (h.startsWith("Bearer ")) return h.slice(7);
    return req.query.token || null;
  })();
  if (!token) return res.status(401).send("Unauthorized");
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).send("Unauthorized");
  const filename = path.basename(req.params.filename);
  const filePath = path.join(resumeOutputDir, filename);
  res.sendFile(filePath, err => {
    if (err && !res.headersSent) res.status(404).send("Not found");
  });
});

// ─── Health check (used by cron keepalive) ────────────────────────────────────
app.get("/health", (_req, res) => res.json({ status: "ok", ...getDeploymentMeta() }));

// ─── Main pages ───────────────────────────────────────────────────────────────
app.get("/", (_req, res) => res.sendFile(path.join(rootDir, "public", "home.html")));
app.get("/resume", (_req, res) => res.sendFile(path.join(rootDir, "public", "index.html")));
app.get("/apply/:slug", async (req, res) => {
  const slug = normalizeAgencyLinkSlug(req.params.slug);
  try {
    // 1. Check Supabase partner_links first
    const { data: dbLink } = await supabase
      .from("partner_links")
      .select("*, agencies(slug, name)")
      .eq("full_slug", slug)
      .maybeSingle();

    if (dbLink) {
      if (!dbLink.active) {
        return res.status(410).type("html").send(linkErrorPage(
          "This link has been deactivated",
          "This application link is no longer active. Please contact your agency for an updated link."
        ));
      }
      // Serve the form directly — keep the clean /apply/:slug URL in the browser
      return res.sendFile(path.join(rootDir, "public", "index.html"));
    }
  } catch (e) {
    console.warn("/apply/:slug DB error (falling back to legacy):", e.message);
  }

  // 2. Fall back to legacy agency-links.json
  const legacyLink = readAgencyLinks().find(item => item.slug === slug);
  if (legacyLink) return res.redirect(buildPartnerResumeUrl(legacyLink));

  // 3. Not found
  return res.status(404).type("html").send(linkErrorPage(
    "Partner link not found",
    "This application link is not active or may have been typed incorrectly. Please ask your agency for the correct JobReady link."
  ));
});

// Public endpoint — resolves a partner link slug to form init data (no auth needed)
app.get("/api/link/:slug", async (req, res) => {
  const slug = normalizeAgencyLinkSlug(req.params.slug);
  try {
    const { data: dbLink } = await supabase
      .from("partner_links")
      .select("id, full_slug, partner_name, partner_country, lock_agency, active, agencies(slug, name)")
      .eq("full_slug", slug)
      .maybeSingle();

    if (!dbLink) return res.status(404).json({ ok: false, error: "Link not found" });
    if (!dbLink.active) return res.status(410).json({ ok: false, error: "Link deactivated" });

    res.json({
      ok: true,
      agency: dbLink.agencies.slug,
      partnerLinkCode: dbLink.full_slug,
      partnerLinkId: dbLink.id,
      partnerAgency: dbLink.partner_name || null,
      partnerCountry: dbLink.partner_country || null,
      lockAgency: dbLink.lock_agency || false,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: "Service temporarily unavailable" });
  }
});

function linkErrorPage(title, message) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} — JobReady</title>
  <style>
    body { font-family: Arial, sans-serif; background:#f4efe6; color:#13202b; margin:0; display:grid; place-items:center; min-height:100vh; padding:24px; }
    .card { max-width:560px; background:#fff; border-radius:24px; padding:32px; box-shadow:0 24px 60px rgba(12,18,24,0.14); }
    h1 { margin:0 0 12px; font-size:32px; }
    p { margin:0 0 18px; line-height:1.7; color:#62717f; }
    a { display:inline-flex; align-items:center; justify-content:center; min-height:46px; padding:0 18px; border-radius:999px; background:#13202b; color:#fff; text-decoration:none; font-weight:700; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${title}</h1>
    <p>${message}</p>
    <a href="/">Go to JobReady Home</a>
  </div>
</body>
</html>`;
}

// ─── Privacy policy ───────────────────────────────────────────────────────────
app.get("/privacy", (_req, res) => res.sendFile(path.join(rootDir, "public", "privacy.html")));
app.get("/pricing", (_req, res) => res.sendFile(path.join(rootDir, "public", "pricing.html")));

// ─── Auth pages ───────────────────────────────────────────────────────────────
app.get("/register",        (_req, res) => res.sendFile(path.join(rootDir, "public", "register.html")));
app.get("/login",           (_req, res) => res.sendFile(path.join(rootDir, "public", "login.html")));
app.get("/dashboard",       (_req, res) => res.sendFile(path.join(rootDir, "public", "dashboard.html")));
app.get("/auth/callback",   (_req, res) => res.sendFile(path.join(rootDir, "public", "auth", "callback.html")));

// ─── Supabase public config (safe to expose) ──────────────────────────────────
app.get("/config.js", (_req, res) => {
  res.type("application/javascript").send(
    `window.SUPABASE_URL = ${JSON.stringify(process.env.SUPABASE_URL || "https://qpnkmqczvlmrxofqgzdu.supabase.co")};\n` +
    `window.SUPABASE_ANON_KEY = ${JSON.stringify(process.env.SUPABASE_ANON_KEY || "")};\n`
  );
});

// ─── Agency setup (called once after first sign-in) ───────────────────────────
app.post("/api/agency/setup", requireAuth, async (req, res) => {
  const { name, slug } = req.body || {};
  if (!name || !slug) return res.status(400).json({ ok: false, error: "name and slug required" });

  const cleanSlug = normalizeAgencyLinkSlug(slug);
  if (!cleanSlug) return res.status(400).json({ ok: false, error: "Invalid slug" });

  // Check if agency already exists for this auth user
  const { data: existing } = await supabase
    .from("agencies")
    .select("id")
    .eq("auth_id", req.user.id)
    .maybeSingle();

  if (existing) return res.json({ ok: true, agency: existing });

  const { data: agency, error } = await supabase
    .from("agencies")
    .insert({ auth_id: req.user.id, name, slug: cleanSlug, contact_email: req.user.email })
    .select()
    .single();

  if (error) {
    console.error("agency/setup error:", error.code, error.message);
    if (error.code === "23505") return res.status(409).json({ ok: false, error: "Slug already taken. Choose another." });
    return res.status(500).json({ ok: false, error: error.message });
  }

  res.json({ ok: true, agency });
});

// ─── Agency profile ───────────────────────────────────────────────────────────
app.get("/api/agency/me", requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from("agencies")
    .select("*")
    .eq("auth_id", req.user.id)
    .maybeSingle();

  if (error) return res.status(500).json({ ok: false, error: error.message });
  if (!data) return res.json({ ok: true, agency: null, usage: null });

  const usage = await loadAgencyUsage(data);
  res.json({ ok: true, agency: { ...data, plan: data.plan || "free" }, usage });
});

// ─── Partner links ────────────────────────────────────────────────────────────
app.get("/api/links", requireAuth, async (req, res) => {
  const { data: agency } = await supabase
    .from("agencies")
    .select("id")
    .eq("auth_id", req.user.id)
    .maybeSingle();

  if (!agency) return res.status(404).json({ ok: false, error: "Agency not found" });

  const { data, error } = await supabase
    .from("partner_links")
    .select("*")
    .eq("agency_id", agency.id)
    .order("created_at", { ascending: false });

  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true, links: data });
});

app.post("/api/links", requireAuth, async (req, res) => {
  const { partner_name, partner_country, code } = req.body || {};
  if (!partner_name || !code) return res.status(400).json({ ok: false, error: "partner_name and code required" });

  const { data: agency } = await supabase
    .from("agencies")
    .select("id, slug, plan")
    .eq("auth_id", req.user.id)
    .maybeSingle();

  if (!agency) return res.status(404).json({ ok: false, error: "Agency not found" });

  const limits = planOf(agency);
  const activeLinks = await countActiveLinks(agency.id);
  if (activeLinks >= limits.maxLinks) {
    return res.status(402).json({
      ok: false,
      code: "plan_limit_links",
      plan: agency.plan || "free",
      limit: limits.maxLinks === Infinity ? null : limits.maxLinks,
      error: `You've reached your active link limit on the ${agency.plan || "free"} plan. Upgrade to add more.`,
    });
  }

  const cleanCode = normalizeAgencyLinkSlug(code);
  const fullSlug = `${agency.slug}-${cleanCode}`;

  const { data, error } = await supabase
    .from("partner_links")
    .insert({ agency_id: agency.id, partner_name, partner_country: partner_country || null, code: cleanCode, full_slug: fullSlug })
    .select()
    .single();

  if (error) {
    if (error.code === "23505") return res.status(409).json({ ok: false, error: "A link with that code already exists for your agency." });
    return res.status(500).json({ ok: false, error: error.message });
  }

  res.json({ ok: true, link: data });
});

app.patch("/api/links/:id", requireAuth, async (req, res) => {
  const { active } = req.body || {};
  if (typeof active !== "boolean") return res.status(400).json({ ok: false, error: "active (boolean) required" });

  const { data: agency } = await supabase
    .from("agencies")
    .select("id, plan")
    .eq("auth_id", req.user.id)
    .maybeSingle();

  if (!agency) return res.status(404).json({ ok: false, error: "Agency not found" });

  if (active) {
    const limits = planOf(agency);
    const activeLinks = await countActiveLinks(agency.id);
    if (activeLinks >= limits.maxLinks) {
      return res.status(402).json({
        ok: false,
        code: "plan_limit_links",
        plan: agency.plan || "free",
        limit: limits.maxLinks === Infinity ? null : limits.maxLinks,
        error: `You've reached your active link limit on the ${agency.plan || "free"} plan. Upgrade to reactivate this link.`,
      });
    }
  }

  const { data, error } = await supabase
    .from("partner_links")
    .update({ active })
    .eq("id", req.params.id)
    .eq("agency_id", agency.id)
    .select()
    .maybeSingle();

  if (error) return res.status(500).json({ ok: false, error: error.message });
  if (!data) return res.status(404).json({ ok: false, error: "Link not found" });
  res.json({ ok: true, link: data });
});

// ─── Submissions ──────────────────────────────────────────────────────────────
app.get("/api/submissions", requireAuth, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 50);
  const cursor = req.query.cursor || null;
  const q = (req.query.q || "").trim();
  const nationality = (req.query.nationality || "").trim();

  const { data: agency } = await supabase
    .from("agencies")
    .select("id")
    .eq("auth_id", req.user.id)
    .maybeSingle();
  if (!agency) return res.status(404).json({ ok: false, error: "Agency not found" });

  let query = supabase
    .from("submissions")
    .select("id, worker_name, nationality, job_type, attachment_count, created_at, agency_id, partner_link_id")
    .eq("agency_id", agency.id)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (q) query = query.ilike("worker_name", `%${q}%`);
  if (nationality) query = query.eq("nationality", nationality);
  if (cursor) query = query.lt("created_at", cursor);

  const { data, error } = await query;
  if (error) return res.status(500).json({ ok: false, error: error.message });

  const nextCursor = data.length === limit ? data[data.length - 1].created_at : null;
  res.json({ ok: true, submissions: data, nextCursor });
});

app.get("/api/submissions/:id", requireAuth, async (req, res) => {
  const { data: agency } = await supabase
    .from("agencies")
    .select("id")
    .eq("auth_id", req.user.id)
    .maybeSingle();
  if (!agency) return res.status(404).json({ ok: false, error: "Agency not found" });

  const { data, error } = await supabase
    .from("submissions")
    .select("*")
    .eq("id", req.params.id)
    .eq("agency_id", agency.id)
    .maybeSingle();
  if (error) return res.status(500).json({ ok: false, error: error.message });
  if (!data) return res.status(404).json({ ok: false, error: "Not found" });

  res.json({ ok: true, submission: data });
});

app.patch("/api/submissions/:id", requireAuth, async (req, res) => {
  const { data: agency } = await supabase
    .from("agencies")
    .select("id")
    .eq("auth_id", req.user.id)
    .maybeSingle();
  if (!agency) return res.status(403).json({ ok: false, error: "Forbidden" });

  const allowed = ["worker_name", "nationality", "job_type", "data"];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }
  if (!Object.keys(updates).length) return res.status(400).json({ ok: false, error: "Nothing to update." });

  const { error } = await supabase
    .from("submissions")
    .update(updates)
    .eq("id", req.params.id)
    .eq("agency_id", agency.id);

  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true });
});

app.delete("/api/submissions/:id", requireAuth, async (req, res) => {
  const { data: agency } = await supabase
    .from("agencies")
    .select("id")
    .eq("auth_id", req.user.id)
    .maybeSingle();
  if (!agency) return res.status(403).json({ ok: false, error: "Forbidden" });

  const { error } = await supabase
    .from("submissions")
    .delete()
    .eq("id", req.params.id)
    .eq("agency_id", agency.id);

  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true });
});

// ─── Add attachments to an existing submission ───────────────────────────────
app.post("/api/submissions/:id/attachments", requireAuth, async (req, res) => {
  const isAdmin = req.user.email === SUPER_ADMIN;

  let sub;
  if (isAdmin) {
    const { data } = await supabase
      .from("submissions").select("pdf_path, attachment_count").eq("id", req.params.id).maybeSingle();
    sub = data;
  } else {
    const { data: agency } = await supabase
      .from("agencies").select("id").eq("auth_id", req.user.id).maybeSingle();
    if (!agency) return res.status(403).json({ ok: false, error: "Forbidden" });
    const { data } = await supabase
      .from("submissions").select("pdf_path, attachment_count")
      .eq("id", req.params.id).eq("agency_id", agency.id).maybeSingle();
    sub = data;
  }

  if (!sub) return res.status(404).json({ ok: false, error: "Submission not found" });
  if (!sub.pdf_path) return res.status(400).json({ ok: false, error: "Submission has no storage path." });

  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "jobready-att-"));
  try {
    const request = new Request(
      new URL(req.originalUrl || req.url, "http://127.0.0.1").toString(),
      { method: req.method, headers: req.headers, body: req, duplex: "half" }
    );
    const formData = await request.formData();
    const files = formData.getAll("attachments").filter(f => f && typeof f.stream === "function");
    if (!files.length) return res.status(400).json({ ok: false, error: "No files provided." });

    // Download existing manifest (or start fresh)
    const manifestPath = sub.pdf_path.replace(/\/resume\.pdf$/, "/submission.json");
    const attachmentDir = sub.pdf_path.replace(/\/resume\.pdf$/, "/attachments");
    let manifest = { attachments: [] };
    const { data: manifestBlob } = await supabase.storage.from("Resumes").download(manifestPath);
    if (manifestBlob) {
      try { manifest = JSON.parse(await manifestBlob.text()); } catch {}
    }
    if (!Array.isArray(manifest.attachments)) manifest.attachments = [];

    let nextIndex = manifest.attachments.length + 1;
    const added = [];
    const rejected = [];

    for (const file of files) {
      const tempPath = path.join(tempDir, `tmp_${nextIndex}`);
      await writeUploadedFile(file, tempPath);
      const fileBuffer = await fsp.readFile(tempPath);

      // Detect actual format from magic bytes — don't trust browser MIME/extension
      const detectedMime = detectMime(fileBuffer);
      if (!detectedMime) {
        rejected.push(`${file.name} (unsupported format — only PDF, JPEG, and PNG are accepted)`);
        continue;
      }

      const ext = detectedMime === "application/pdf" ? ".pdf"
                : detectedMime === "image/jpeg"      ? ".jpg"
                :                                      ".png";
      const safeStem = sanitizeTempSegment(path.basename(file.name || "att", path.extname(file.name || "")), "att");
      const fileName = `${String(nextIndex).padStart(2, "0")}_${safeStem}${ext}`;
      const storagePath = `${attachmentDir}/${fileName}`;

      const { error: uploadErr } = await supabase.storage
        .from("Resumes")
        .upload(storagePath, fileBuffer, { contentType: detectedMime, upsert: true });
      if (uploadErr) throw new Error(`Upload failed for ${file.name}: ${uploadErr.message}`);

      const entry = { originalName: file.name, mimeType: detectedMime, size: fileBuffer.length, storagePath };
      manifest.attachments.push(entry);
      added.push(entry);
      nextIndex++;
      console.log(`[att-upload] ${file.name} (${detectedMime}) → ${storagePath}`);
    }

    if (rejected.length && !added.length) {
      return res.status(400).json({ ok: false, error: rejected.join("; ") });
    }

    // Re-upload manifest
    await supabase.storage.from("Resumes").upload(
      manifestPath,
      Buffer.from(JSON.stringify(manifest, null, 2), "utf8"),
      { contentType: "application/json", upsert: true }
    );

    // Update attachment count in DB
    const countUpdate = supabase.from("submissions")
      .update({ attachment_count: manifest.attachments.length })
      .eq("id", req.params.id);
    if (!isAdmin) countUpdate.eq("agency_id", agency.id);
    await countUpdate;

    res.json({ ok: true, added: added.length, total: manifest.attachments.length, rejected });
  } finally {
    await cleanupTempDir(tempDir);
  }
});

// Passport OCR was moved to the browser. Keep this route non-fatal for stale clients.
app.all("/ocr-passport", (_req, res) => {
  res.status(410).json({
    ok: false,
    error: "Passport OCR now runs in the browser on the latest JobReady build. Redeploy main if this endpoint is still being called.",
  });
});

// ─── Web wizard submit ────────────────────────────────────────────────────────
app.post("/submit", rateLimit({ windowMs: 60_000, max: 10 }), async (req, res) => {
  let cleanupDir = null;
  try {
    const submission = await readSubmissionInput(req);
    const { data, attachments } = submission;
    cleanupDir = submission.cleanupDir;
    if (!data || typeof data !== "object") {
      return res.status(400).json({ ok: false, error: "No data provided" });
    }

    // Resolve agency early so we can enforce the monthly submission cap
    // BEFORE spending compute on PDF generation.
    let resolvedAgency = null;
    if (data.agency) {
      const { data: agencyRow } = await supabase
        .from("agencies")
        .select("id, plan, name")
        .eq("slug", normalizeAgencyLinkSlug(data.agency))
        .maybeSingle();
      if (agencyRow) resolvedAgency = agencyRow;
    }

    if (resolvedAgency) {
      const limits = planOf(resolvedAgency);
      const used = await countSubmissionsThisMonth(resolvedAgency.id);
      if (used >= limits.maxSubmissionsPerMonth) {
        return res.status(402).json({
          ok: false,
          code: "plan_limit_submissions",
          error: "This agency isn't accepting new applications this month. Please reach out to them directly or try again next month.",
        });
      }
    }

    const submissionId = buildSubmissionId(data);
    const safeAttachments = Array.isArray(attachments) ? attachments : [];
    const result = await generateAndStorePDF(data, submissionId, safeAttachments);
    const partnerSuffix = data.partnerAgency
      ? ` via ${data.partnerAgency}${data.partnerCountry ? `, ${data.partnerCountry}` : ""}`
      : "";
    console.log(`✅ Submission: ${data.name} → ${data.agency}${partnerSuffix} (${safeAttachments.length} attachment(s))`);
    if (result.mirrorError) {
      console.warn(`Mirror note for ${submissionId}: ${result.mirrorError}`);
    }

    // Save submission record to Supabase
    try {
      let agencyId = resolvedAgency?.id || null;
      let partnerLinkId = null;

      // Validate that the supplied partnerLinkId actually belongs to this agency
      if (data.partnerLinkId && agencyId) {
        const { data: linkRow } = await supabase
          .from("partner_links")
          .select("id")
          .eq("id", data.partnerLinkId)
          .eq("agency_id", agencyId)
          .maybeSingle();
        if (linkRow) partnerLinkId = linkRow.id;
      }

      const { data: insertedRow } = await supabase.from("submissions").insert({
        agency_id: agencyId,
        partner_link_id: partnerLinkId,
        worker_name: data.name || null,
        nationality: data.nationality || null,
        job_type: data.jobType || data.job_type || null,
        data,
        pdf_path: result.storagePath || null,
        attachment_count: result.attachmentCount || 0,
      }).select("id").single();

    } catch (dbErr) {
      console.warn("Supabase submission record error (non-fatal):", dbErr.message);
    }

    res.json({
      ok: true,
      attachmentCount: result.attachmentCount,
    });
  } catch (err) {
    console.error("Submit error:", err.message);
    res.status(err.statusCode || 500).json({ ok: false, error: err.message });
  } finally {
    if (cleanupDir) {
      await cleanupTempDir(cleanupDir);
    }
  }
});

// ─── Admin ────────────────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  if (!req.user || req.user.email !== SUPER_ADMIN) {
    return res.status(403).json({ ok: false, error: "Forbidden" });
  }
  next();
}

app.get("/admin", (_req, res) => res.sendFile(path.join(rootDir, "public", "admin.html")));

app.get("/api/admin/stats", requireAuth, requireAdmin, async (req, res) => {
  const [{ count: agencyCount }, { count: submissionCount }, { data: { users } }] = await Promise.all([
    supabase.from("agencies").select("*", { count: "exact", head: true }),
    supabase.from("submissions").select("*", { count: "exact", head: true }),
    supabase.auth.admin.listUsers({ perPage: 1000 }),
  ]);
  res.json({ ok: true, agencies: agencyCount || 0, submissions: submissionCount || 0, authUsers: users.length });
});

app.get("/api/admin/agencies", requireAuth, requireAdmin, async (req, res) => {
  const { data: agencies, error } = await supabase
    .from("agencies")
    .select("id, name, slug, auth_id, plan, created_at")
    .order("created_at", { ascending: false });
  if (error) return res.status(500).json({ ok: false, error: error.message });

  const { data: { users } } = await supabase.auth.admin.listUsers({ perPage: 1000 });
  const userMap = Object.fromEntries(users.map(u => [u.id, u.email]));

  const { data: counts } = await supabase
    .from("submissions")
    .select("agency_id");
  const countMap = {};
  (counts || []).forEach(r => { countMap[r.agency_id] = (countMap[r.agency_id] || 0) + 1; });

  // Active link counts and submissions-this-month for usage badges
  const { data: activeLinks } = await supabase
    .from("partner_links")
    .select("agency_id")
    .eq("active", true);
  const activeLinkMap = {};
  (activeLinks || []).forEach(r => { activeLinkMap[r.agency_id] = (activeLinkMap[r.agency_id] || 0) + 1; });

  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const { data: monthSubs } = await supabase
    .from("submissions")
    .select("agency_id")
    .gte("created_at", monthStart.toISOString());
  const monthSubMap = {};
  (monthSubs || []).forEach(r => { monthSubMap[r.agency_id] = (monthSubMap[r.agency_id] || 0) + 1; });

  const result = agencies.map(a => {
    const limits = planOf(a);
    return {
      ...a,
      plan: a.plan || "free",
      email: userMap[a.auth_id] || null,
      submission_count: countMap[a.id] || 0,
      active_links: activeLinkMap[a.id] || 0,
      active_links_limit: limits.maxLinks === Infinity ? null : limits.maxLinks,
      submissions_this_month: monthSubMap[a.id] || 0,
      submissions_limit: limits.maxSubmissionsPerMonth === Infinity ? null : limits.maxSubmissionsPerMonth,
    };
  });
  res.json({ ok: true, agencies: result });
});

app.patch("/api/admin/agencies/:id/plan", requireAuth, requireAdmin, async (req, res) => {
  const { plan } = req.body || {};
  if (!VALID_PLANS.includes(plan)) {
    return res.status(400).json({ ok: false, error: `plan must be one of ${VALID_PLANS.join(", ")}` });
  }
  const { data, error } = await supabase
    .from("agencies")
    .update({ plan })
    .eq("id", req.params.id)
    .select()
    .maybeSingle();
  if (error) return res.status(500).json({ ok: false, error: error.message });
  if (!data) return res.status(404).json({ ok: false, error: "Agency not found" });
  res.json({ ok: true, agency: data });
});

app.delete("/api/admin/agencies/:id", requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { data: agency } = await supabase.from("agencies").select("auth_id").eq("id", id).maybeSingle();
  if (!agency) return res.status(404).json({ ok: false, error: "Not found" });

  await supabase.from("submissions").delete().eq("agency_id", id);
  await supabase.from("partner_links").delete().eq("agency_id", id);
  await supabase.from("agencies").delete().eq("id", id);
  if (agency.auth_id) await supabase.auth.admin.deleteUser(agency.auth_id);

  res.json({ ok: true });
});

app.get("/api/admin/submissions", requireAuth, requireAdmin, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  const cursor = req.query.cursor || null;

  let query = supabase
    .from("submissions")
    .select("id, worker_name, nationality, job_type, attachment_count, created_at, agency_id, partner_link_id")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (cursor) query = query.lt("created_at", cursor);

  const { data, error } = await query;
  if (error) return res.status(500).json({ ok: false, error: error.message });

  const nextCursor = data.length === limit ? data[data.length - 1].created_at : null;
  res.json({ ok: true, submissions: data, nextCursor });
});

app.get("/api/admin/submissions/:id", requireAuth, requireAdmin, async (req, res) => {
  const { data, error } = await supabase
    .from("submissions")
    .select("*")
    .eq("id", req.params.id)
    .maybeSingle();
  if (error) return res.status(500).json({ ok: false, error: error.message });
  if (!data) return res.status(404).json({ ok: false, error: "Not found" });
  res.json({ ok: true, submission: data });
});

app.patch("/api/admin/submissions/:id", requireAuth, requireAdmin, async (req, res) => {
  const allowed = ["worker_name", "nationality", "job_type", "data"];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }
  if (!Object.keys(updates).length) return res.status(400).json({ ok: false, error: "Nothing to update." });

  const { error } = await supabase
    .from("submissions")
    .update(updates)
    .eq("id", req.params.id);

  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true });
});

app.delete("/api/admin/submissions/:id", requireAuth, requireAdmin, async (req, res) => {
  const { error } = await supabase.from("submissions").delete().eq("id", req.params.id);
  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true });
});

app.post("/api/admin/wipe", requireAuth, requireAdmin, async (req, res) => {
  try {
    await supabase.from("submissions").delete().neq("id", "00000000-0000-0000-0000-000000000000");
    await supabase.from("partner_links").delete().neq("id", "00000000-0000-0000-0000-000000000000");
    await supabase.from("agencies").delete().neq("id", "00000000-0000-0000-0000-000000000000");

    const { data: { users } } = await supabase.auth.admin.listUsers({ perPage: 1000 });
    await Promise.all(
      users
        .filter(u => u.email !== SUPER_ADMIN)
        .map(u => supabase.auth.admin.deleteUser(u.id))
    );

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Contact form ─────────────────────────────────────────────────────────────
app.post("/api/contact", rateLimit({ windowMs: 60_000, max: 5 }), async (req, res) => {
  const { name, email, message } = req.body || {};
  if (!name || !email || !message) return res.status(400).json({ ok: false, error: "All fields required." });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ ok: false, error: "Invalid email." });
  if (message.length > 2000) return res.status(400).json({ ok: false, error: "Message too long." });
  try {
    const { error } = await supabase.from("contact_messages").insert({ name, email, message });
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: "Failed to save message." });
  }
});

// ─── Admin: contact messages ──────────────────────────────────────────────────
app.get("/api/admin/messages", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("contact_messages")
      .select("id, name, email, message, read, created_at")
      .order("created_at", { ascending: false });
    if (error) throw error;
    res.json({ ok: true, messages: data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.patch("/api/admin/messages/:id/read", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { error } = await supabase
      .from("contact_messages")
      .update({ read: true })
      .eq("id", req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete("/api/admin/messages/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { error } = await supabase
      .from("contact_messages")
      .delete()
      .eq("id", req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Global error handler ─────────────────────────────────────────────────────
// Catches unhandled promise rejections from async route handlers that lack
// their own try/catch (e.g. missing DB credentials in local dev).
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error("Unhandled route error:", err.message);
  if (!res.headersSent) {
    res.status(err.statusCode || 500).json({ ok: false, error: err.message });
  }
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection (non-fatal):", reason);
});

// ─── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  const meta = getDeploymentMeta();
  const extra = [meta.branch, meta.commit].filter(Boolean).join(" @ ");
  console.log(`🚀 ${appName} v${meta.version} listening on port ${PORT}${extra ? ` (${extra})` : ""}`);
});
