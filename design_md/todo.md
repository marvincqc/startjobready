# To-Do / Status

## Done

### Core Product
- [x] Multi-step worker form (26 steps, 6 languages)
- [x] Language switcher — full `stepOverrides` for zh, ms, ta, hi, bn
- [x] Auto-save to localStorage + "Save progress" / resume modal
- [x] File attachment uploads (passport, certs)
- [x] PDF generation (PDFKit) + Supabase Storage upload
- [x] Multipart form submission (`POST /submit`)

### Agency Auth & Dashboard
- [x] Google OAuth only (Supabase PKCE flow)
- [x] Agency registration + profile setup (name + slug)
- [x] Dashboard: submission list, pagination, search/filter
- [x] Submission detail drawer with PDF download
- [x] Delete submission (agency-scoped, confirmed)
- [x] Sign-out button (clears refresh token, fixes shared-device session bleed)
- [x] Partner links: create, toggle active/inactive, copy URL

### Freemium Pricing
- [x] `plan` column on `agencies` table (free / pro / scale)
- [x] `PLAN_LIMITS` enforcement on `POST /submit` (monthly cap — 20 free, 500 pro)
- [x] `PLAN_LIMITS` enforcement on `POST /api/links` and `PATCH /api/links/:id` (link cap)
- [x] Usage meters on dashboard (submissions this month, active links)
- [x] Plan chip in dashboard nav (Free / Pro / Scale)
- [x] Upgrade modal with three-tier comparison
- [x] Pricing page (`/pricing`)
- [x] Pricing link in home nav

### Admin
- [x] `/admin` panel — list all agencies with usage badges
- [x] Plan dropdown per agency (PATCH `/api/admin/agencies/:id/plan`)
- [x] Delete agency + submissions
- [x] Admin wipe endpoint

### Email
- [x] Resend integration — submission notification email to agency `contact_email`

### Stability
- [x] Lazy Supabase init (server starts without env vars)
- [x] `unhandledRejection` guard — process stays alive if DB unreachable
- [x] try/catch on `/apply/:slug` and `/api/link/:slug` (falls back gracefully)
- [x] Mobile layout fixes on worker form
- [x] Worker form `step-q` uses `clamp()` — no text clipping on long translated questions

## Pending / Ideas

- [ ] Stripe payment integration for Pro/Scale upgrades (currently manual via admin)
- [ ] Agency can update `contact_email` from dashboard settings
- [ ] Bulk CSV export of submissions
- [ ] Submission search by worker name / nationality in dashboard
- [ ] Email confirmation to worker after submission
- [ ] Custom SMTP in Supabase to lift the 2/hour auth email rate limit (if email login ever re-added)
