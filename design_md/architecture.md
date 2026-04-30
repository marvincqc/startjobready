# Architecture

## Stack
- **Runtime**: Node.js 18+ / Express 4 — `server.js`
- **Frontend**: Vanilla HTML/CSS/JS static files in `public/`
- **Database + Auth**: Supabase (PostgreSQL + Supabase Auth)
- **PDF generation**: PDFKit (`src/pdf.js`) + Supabase Storage
- **Email**: Resend (`notifications@jobready.sg`)
- **Deployment**: Render (web service, port 10000)

## Request Flow

```
Browser
  ├── Static pages (/, /login, /register, /dashboard, /admin, /pricing)
  │     └── Express serves public/*.html directly
  │
  ├── Worker form (/apply/:slug or /resume)
  │     └── Express resolves slug → serves public/index.html
  │         └── index.html calls /api/link/:slug for init data
  │             then POST /submit (multipart) to generate PDF + save row
  │
  └── Agency dashboard (/dashboard)
        └── public/dashboard.html
            ├── Supabase JS SDK: onAuthStateChange → Bearer token
            ├── GET /api/agency/me → plan + usage + agency data
            ├── GET /api/links
            ├── GET /api/submissions
            └── POST/PATCH/DELETE /api/links, /api/submissions/:id
```

## Auth
- **Agency auth**: Google OAuth via Supabase Auth (PKCE flow)
  - `/auth/callback` exchanges the OAuth code, reads `localStorage.auth_redirect`, redirects
  - All agency API routes: `requireAuth` middleware validates JWT via `supabase.auth.getUser(token)`
- **Admin auth**: Same JWT, `requireAdmin` checks email against `SUPER_ADMIN` env var
- **Workers**: No auth — public form, identified only by partner link slug

## PDF Storage
- Generated in a temp dir, uploaded to Supabase Storage bucket `resumes`
- Download gated behind `/api/pdf/download?id=<submission_id>` (agency JWT required)
- Falls back to local `/resume_output/` in dev when storage is unavailable

## Freemium Enforcement
- `PLAN_LIMITS` constant in `server.js` defines limits per tier
- `POST /submit` checks monthly submission count before generating PDF (HTTP 402 on cap)
- `POST /api/links` and `PATCH /api/links/:id` check active link count before creating/activating (HTTP 402 on cap)
- Usage meters served via `GET /api/agency/me` response (`usage` object)
