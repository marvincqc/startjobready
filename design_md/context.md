# JobReady — Project Context

## What It Is
A SaaS tool for Singapore manpower agencies to collect structured job applications from foreign workers. Agencies share a partner link; workers fill in a multi-step form; a PDF resume is generated and stored; the agency sees submissions in a dashboard.

## Users

| User     | How they interact                                                         |
|----------|---------------------------------------------------------------------------|
| Worker   | Opens `/apply/<slug>` on mobile, fills in the form in their language, submits |
| Agency   | Signs up via Google OAuth, creates partner links, views/downloads submissions in dashboard |
| Admin    | Accesses `/admin` (email-gated), manages agencies, plans, and submissions  |

## Key Pages

| Route              | File                     | Purpose                                      |
|--------------------|--------------------------|----------------------------------------------|
| `/`                | `public/home.html`       | Marketing landing page                       |
| `/pricing`         | `public/pricing.html`    | Three-tier pricing: Free / Pro / Scale       |
| `/login`           | `public/login.html`      | Google OAuth sign-in (Google only)           |
| `/register`        | `public/register.html`   | Google OAuth + agency profile setup          |
| `/dashboard`       | `public/dashboard.html`  | Agency dashboard — submissions, links, usage |
| `/admin`           | `public/admin.html`      | Admin panel — all agencies, plan management  |
| `/apply/:slug`     | → `public/index.html`    | Worker application form                      |
| `/auth/callback`   | `public/auth/callback.html` | OAuth callback handler                    |

## Worker Form (`public/index.html`)
- 26-step wizard collecting: name, nationality, phone, job type, experience, skills, education, languages, documents, etc.
- Multi-language: English (default), Chinese (zh), Malay (ms), Tamil (ta), Hindi (hi), Bengali (bn)
- Language switching re-renders all labels/questions/hints via `stepOverrides` merge in `getSteps()`
- Progress auto-saved to `localStorage`; "Save progress" button in header opens exit/resume modal
- Attachment uploads (passport, cert scans) submitted as multipart
- On submit: POST `/submit` → server enforces monthly cap → generates PDF → saves to Supabase Storage → saves submission row → sends agency email notification via Resend

## Agency Dashboard (`public/dashboard.html`)
- Auth: Supabase `onAuthStateChange` + Bearer token on all API calls
- Sign out button: calls `sb.auth.signOut()` → clears localStorage refresh token → redirects to `/login`
- Plan chip + usage meters (submissions this month, active links) pulled from `GET /api/agency/me`
- Submission drawer: view full data, download PDF, delete submission
- Partner links tab: create, toggle active/inactive, copy worker URL
- Upgrade modal: three-tier comparison, Pro/Scale → `mailto:upgrade@jobready.sg`

## Freemium Model
- Three tiers: Free / Pro (S$29/mo) / Scale (S$129/mo)
- Free: 3 active links, **20 submissions/month**
- Pro: 25 active links, 500 submissions/month
- Scale: unlimited both
- No payment processor — plan changes done manually via admin UI
- Worker sees friendly cap message when agency hits monthly limit

## Auth Details
- Google OAuth only (email/password removed)
- Supabase refresh tokens stored in `localStorage` — persist across browser sessions
- Sign-out button is the only way to terminate a session; important for shared devices
