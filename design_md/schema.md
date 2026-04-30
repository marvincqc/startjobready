# Data Model

## Supabase Tables

### `agencies`
| Column          | Type      | Notes                                      |
|-----------------|-----------|--------------------------------------------|
| id              | uuid PK   | auto-generated                             |
| auth_id         | uuid      | Supabase auth.users.id (foreign key)       |
| name            | text      | Agency display name                        |
| slug            | text      | URL-safe identifier, unique, immutable     |
| contact_email   | text      | Receives submission notification emails    |
| plan            | text      | `free` \| `pro` \| `scale` — DEFAULT free  |
| created_at      | timestamptz | auto                                     |

### `partner_links`
| Column          | Type      | Notes                                                |
|-----------------|-----------|------------------------------------------------------|
| id              | uuid PK   |                                                      |
| agency_id       | uuid FK   | → agencies.id                                        |
| full_slug       | text      | e.g. `apex-myanmar-2025`, unique                     |
| partner_name    | text      | Sending agency name (optional)                       |
| partner_country | text      | Worker source country (optional)                     |
| lock_agency     | bool      | If true, worker cannot change the target agency      |
| active          | bool      | Inactive links serve a 410 deactivated page          |
| created_at      | timestamptz |                                                    |

### `submissions`
| Column           | Type      | Notes                                             |
|------------------|-----------|---------------------------------------------------|
| id               | uuid PK   |                                                   |
| agency_id        | uuid FK   | → agencies.id (nullable for unmatched slugs)      |
| partner_link_id  | uuid FK   | → partner_links.id (nullable)                     |
| worker_name      | text      |                                                   |
| nationality      | text      |                                                   |
| job_type         | text      |                                                   |
| data             | jsonb     | Full form answers                                 |
| pdf_path         | text      | Supabase Storage path (`resumes/<submissionId>.pdf`) |
| attachment_count | int       |                                                   |
| created_at       | timestamptz | Used for monthly submission counting            |

## Plan Limits (enforced server-side)

| Plan  | Active links | Submissions / month |
|-------|-------------|---------------------|
| free  | 3           | **20**              |
| pro   | 25          | 500                 |
| scale | Unlimited   | Unlimited           |

Limits are evaluated live via `COUNT` queries — no stored counters.
Monthly window: first day of current calendar month (UTC) to now.

## SQL Migration (run once in Supabase SQL editor)

```sql
-- Add plan column to existing agencies table
ALTER TABLE agencies ADD COLUMN plan TEXT NOT NULL DEFAULT 'free'
  CHECK (plan IN ('free', 'pro', 'scale'));
```
