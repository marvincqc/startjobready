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
const { generateAndStorePDF } = require("./src/pdf");
const packageInfo = require("./package.json");

// Supabase admin client (service role for server-side inserts + JWT validation)
// Lazy init so missing env vars don't crash the server on startup
let _supabase = null;
function getSupabase() {
  if (!_supabase) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
    if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_KEY env vars are required.");
    _supabase = createClient(url, key);
  }
  return _supabase;
}
// Convenience proxy so existing code using `supabase.from(...)` still works
const supabase = new Proxy({}, {
  get(_, prop) { return getSupabase()[prop]; },
});

const app = express();
const rootDir = __dirname;
const resumeOutputDir = path.join(rootDir, "resume_output");
const agencyLinksPath = path.join(rootDir, "config", "agency-links.json");
const appName = "JobReady";

app.use("/resume_output", express.static(resumeOutputDir));
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

// ─── Health check (used by cron keepalive) ────────────────────────────────────
app.get("/health", (_req, res) => res.json({ status: "ok", ...getDeploymentMeta() }));

// ─── Main pages ───────────────────────────────────────────────────────────────
app.get("/", (_req, res) => res.sendFile(path.join(rootDir, "public", "home.html")));
app.get("/resume", (_req, res) => res.sendFile(path.join(rootDir, "public", "index.html")));
app.get("/apply/:slug", async (req, res) => {
  const slug = normalizeAgencyLinkSlug(req.params.slug);

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
    const params = new URLSearchParams();
    params.set("agency", dbLink.agencies.slug);
    params.set("partnerLinkCode", dbLink.full_slug);
    params.set("partnerLinkId", dbLink.id);
    if (dbLink.partner_name) params.set("partnerAgency", dbLink.partner_name);
    if (dbLink.partner_country) params.set("partnerCountry", dbLink.partner_country);
    if (dbLink.lock_agency) params.set("lockAgency", "1");
    return res.redirect(`/resume?${params.toString()}`);
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

// ─── Auth pages ───────────────────────────────────────────────────────────────
app.get("/register", (_req, res) => res.sendFile(path.join(rootDir, "public", "register.html")));
app.get("/login",    (_req, res) => res.sendFile(path.join(rootDir, "public", "login.html")));
app.get("/dashboard",(_req, res) => res.sendFile(path.join(rootDir, "public", "dashboard.html")));

// ─── Supabase public config (safe to expose) ──────────────────────────────────
app.get("/config.js", (_req, res) => {
  res.type("application/javascript").send(
    `window.SUPABASE_URL = ${JSON.stringify(process.env.SUPABASE_URL || "")};\n` +
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
  res.json({ ok: true, agency: data });
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
    .select("id, slug")
    .eq("auth_id", req.user.id)
    .maybeSingle();

  if (!agency) return res.status(404).json({ ok: false, error: "Agency not found" });

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
    .select("id")
    .eq("auth_id", req.user.id)
    .maybeSingle();

  if (!agency) return res.status(404).json({ ok: false, error: "Agency not found" });

  const { data, error } = await supabase
    .from("partner_links")
    .update({ active })
    .eq("id", req.params.id)
    .eq("agency_id", agency.id)
    .select()
    .single();

  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true, link: data });
});

// ─── Submissions ──────────────────────────────────────────────────────────────
app.get("/api/submissions", requireAuth, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 50);
  const cursor = req.query.cursor || null; // ISO timestamp of last item

  const isAdmin = req.user.email === SUPER_ADMIN;

  let query = supabase
    .from("submissions")
    .select("id, worker_name, nationality, job_type, attachment_count, created_at, agency_id, partner_link_id")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (!isAdmin) {
    const { data: agency } = await supabase
      .from("agencies")
      .select("id")
      .eq("auth_id", req.user.id)
      .maybeSingle();
    if (!agency) return res.status(404).json({ ok: false, error: "Agency not found" });
    query = query.eq("agency_id", agency.id);
  }

  if (cursor) query = query.lt("created_at", cursor);

  const { data, error } = await query;
  if (error) return res.status(500).json({ ok: false, error: error.message });

  const nextCursor = data.length === limit ? data[data.length - 1].created_at : null;
  res.json({ ok: true, submissions: data, nextCursor });
});

app.get("/api/submissions/:id", requireAuth, async (req, res) => {
  const isAdmin = req.user.email === SUPER_ADMIN;

  let query = supabase
    .from("submissions")
    .select("*")
    .eq("id", req.params.id);

  if (!isAdmin) {
    const { data: agency } = await supabase
      .from("agencies")
      .select("id")
      .eq("auth_id", req.user.id)
      .maybeSingle();
    if (!agency) return res.status(404).json({ ok: false, error: "Agency not found" });
    query = query.eq("agency_id", agency.id);
  }

  const { data, error } = await query.maybeSingle();
  if (error) return res.status(500).json({ ok: false, error: error.message });
  if (!data) return res.status(404).json({ ok: false, error: "Not found" });

  res.json({ ok: true, submission: data });
});

// Passport OCR was moved to the browser. Keep this route non-fatal for stale clients.
app.all("/ocr-passport", (_req, res) => {
  res.status(410).json({
    ok: false,
    error: "Passport OCR now runs in the browser on the latest JobReady build. Redeploy main if this endpoint is still being called.",
  });
});

// ─── Web wizard submit ────────────────────────────────────────────────────────
app.post("/submit", async (req, res) => {
  let cleanupDir = null;
  try {
    const submission = await readSubmissionInput(req);
    const { data, attachments } = submission;
    cleanupDir = submission.cleanupDir;
    if (!data || typeof data !== "object") {
      return res.status(400).json({ ok: false, error: "No data provided" });
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
      let agencyId = null;
      let partnerLinkId = data.partnerLinkId || null;

      if (data.agency) {
        const { data: agencyRow } = await supabase
          .from("agencies")
          .select("id")
          .eq("slug", normalizeAgencyLinkSlug(data.agency))
          .maybeSingle();
        if (agencyRow) agencyId = agencyRow.id;
      }

      await supabase.from("submissions").insert({
        agency_id: agencyId,
        partner_link_id: partnerLinkId || null,
        worker_name: data.name || null,
        nationality: data.nationality || null,
        job_type: data.jobType || data.job_type || null,
        data,
        pdf_path: result.storagePath || null,
        attachment_count: result.attachmentCount || 0,
      });
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

// ─── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  const meta = getDeploymentMeta();
  const extra = [meta.branch, meta.commit].filter(Boolean).join(" @ ");
  console.log(`🚀 ${appName} v${meta.version} listening on port ${PORT}${extra ? ` (${extra})` : ""}`);
});
