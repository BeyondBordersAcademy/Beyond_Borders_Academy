# Beyond Borders English Academy — Phase 1 Build Report

**Tagline:** Breaking Barriers, Building Futures
**Location:** `~/workspace/beyond-borders-academy/`
**Status:** Built, acceptance-tested, database shipped clean.

## Admin credentials

- **Email:** `admin@beyondborders.academy`
- **Password:** `ChangeMe123!`
- You will be **forced to set a new password on first login** (do this immediately).

## How to run

```bash
cd ~/workspace/beyond-borders-academy
npm install        # once (better-sqlite3 compiles; needs build tools)
npm start          # serves on $PORT, default http://localhost:3000
```

- Database auto-creates at `data/academy.db` with migrations on boot.
- Sessions persist in `data/sessions.db`. Uploads go to `uploads/`.
- Node ≥ 20 required (tested on Node 24; uses `better-sqlite3@^12`).

## What was built (Phase 1)

**Public site** — Home (headline "Your Future Speaks English.", mission, core values, course cards, FAQ — all copy from the master prompt; no fake testimonials), About, searchable course catalog, course detail pages, a real **20-question placement test** (grammar/vocabulary/reading/listening/communication → A1–C2 estimate, always labeled an estimate, never a certification; result stored and surfaced to the teacher), contact form (honeypot + rate limit, saved for admin), **public certificate verification** at `/verify/:code` (shows only what's needed), login/register/forgot/reset, invitation acceptance, privacy/terms/certificate policies, light/dark mode toggle, responsive + semantic accessible HTML.

**Student portal** — Dashboard (enrolled courses with progress bars, upcoming assignments/quizzes, announcements), resume-where-you-left-off learning, lesson pages (mark complete, optional Spanish explanation toggle), materials library, assignments (typed text / file upload / audio upload, draft vs submit, statuses, history, teacher feedback), quizzes (time limits, attempt limits, availability windows, auto-graded + manual questions, results with answer keys), gradebook (per-course weighted totals, category breakdowns, missing work), certificates (PDF download), profile + password, notifications, teacher messaging.

**Admin/teacher portal** — Overview stats (enrollments, pending grading, at-risk students <25% progress, recent audit activity), student management (search/filter/paginate, create, email invitations, edit, CEFR levels incl. placement estimates flagged with `~`, enroll, suspend/reactivate, private notes, password reset, CSV export), course CRUD + **duplicate** (copies units/lessons/materials/assignments/quizzes, never student data) + publish/unpublish/archive (delete blocked when enrollments exist), **course builder with drag-and-drop reorder** of units/lessons, **lesson editor** (rich-text toolbar, vocabulary-table helper, Spanish field, student preview), materials library (validated uploads, tags, reuse across courses without re-uploading), assignment builder + grading workspace (grades, feedback, revision requests, audit-logged), **quiz builder** (6 question types, answer keys, question banks, copy quiz to another course), manual grading of open-ended answers, **gradebook** (configurable category weights in course settings, per-student totals, detail drill-down, manual audit-logged grade entries, CSV export), **certificates** (eligibility check: 100% progress + ≥70% grade, or audit-logged manual override; navy/gold PDF with QR verification URL; issue/preview/download/revoke/reissue), announcements (academy-wide or per-course, creates notifications), messaging, academic reports (enrollment/progress/completion/at-risk), contact messages, full audit log, and **site settings** (name, tagline, contact, homepage content, SMTP fields).

**Security** — bcrypt passwords, server-side sessions, role checks on every route (`requireStudent`/`requireStaff`/`requireAdmin`), ownership checks on every record query (students can never see another student's grades, submissions, certificates, or attempts), uploads served only through a permission-checked `/files/*` route (executables blocked), helmet headers, rate limits on auth/contact, parameterized SQL throughout, audit logging of grade changes/certificate actions/account changes.

**Seed data** — Admin user + one clearly-labeled **draft** sample course ("Sample: Beginner English A1", 1 unit, 2 lessons incl. Spanish explanations, 1 quiz with 3 questions). No fake students, no fake testimonials, no invented credentials.

## Acceptance results (all verified via curl against a live server)

1. ✅ Register → login → enroll in published course → lesson → progress recorded (100%).
2. ✅ Quiz attempt saved; objective questions auto-scored (4/4 on all-correct; attempt limits enforced).
3. ✅ Admin creates assignment → student submits → admin grades (85) with feedback → student sees it → gradebook total correct (92.5%).
4. ✅ Certificate issued → PDF downloads (valid `%PDF`) → `/verify/:code` shows **Valid** → revoke → shows **Revoked**.
5. ✅ Student A → student B's certificate: 404; student B → student A's attempt: 403; logged-out `/admin` → 302 to login; teacher → `/admin/settings`: 403. Invitation registration, password reset, announcements→notifications, CSV exports, course duplication, drag-drop reorder, placement test, contact form + honeypot all verified. All pages return 200; no server errors in logs.

Bugs found and fixed during testing: better-sqlite3 v11 native crash on Node 24 (upgraded to v12); student router intercepting `/admin` (scoped middleware by path); quiz answer keys parsed as arrays by `qs` (renamed fields to `answers[q<id>]`); certificate PDFs stored as absolute paths (now project-relative); `/students/export.csv` shadowed by `/students/:id` (route order).

## Phase-1 gaps / deviations (honest)

- **Payments/Stripe:** not integrated. Paid courses exist as a data field, but enrollment in a paid course is refused with a message to contact the academy. `/admin/settings` shows "Not configured" with setup steps. No payment is ever faked.
- **AI features:** not built (Phase 3). Settings page shows "Not configured" with setup steps; nothing is simulated.
- **Live video (Zoom/Meet):** not integrated (Phase 2). Manual scheduling + meeting links via announcements/messages.
- **Email sending:** pluggable SMTP fields in settings; until configured, emails log to console and in-app notifications are used. The app never claims an email was delivered when it wasn't.
- **Placement "listening":** uses short written dialogues, clearly labeled (no audio yet).
- **Attendance, calendar UI, TA role:** Phase 2. Role values exist in the schema (`teacher`, `ta`) but Phase 1 ships with one admin (Charlie); teacher role is permission-tested.
- File uploads cap at 25 MB (submissions) / 50 MB (materials); video submissions are file-upload based in Phase 1.

## Postgres migration (2026-10-17)

The app was migrated from better-sqlite3 to PostgreSQL (`pg` driver) for hosting on Render (free web service) with the database on Supabase Postgres (free tier). Hugging Face Docker Spaces was evaluated and rejected (requires $9/mo PRO, verified via API 402).

- **`DATABASE_URL` is now required** (e.g. Supabase pooler connection string). The app refuses to boot without it. SSL (`rejectUnauthorized: false`) is enabled automatically for non-localhost hosts.
- **better-sqlite3 and connect-sqlite3 removed** from dependencies; added `pg` and `connect-pg-simple` (sessions now in a `user_sessions` Postgres table, auto-created on boot via `createTableIfMissing: true`).
- **Behavior preserved:** all SQL translated (`?` → `$1,$2…`, `LIKE` → `ILIKE`, `datetime('now')` → `TO_CHAR(NOW(),'YYYY-MM-DD HH24:MI:SS')`, `INTEGER PRIMARY KEY AUTOINCREMENT` → `SERIAL PRIMARY KEY`, `INSERT OR IGNORE` → `ON CONFLICT … DO NOTHING`); integer 0/1 flags kept as-is (not converted to BOOLEAN).
- **Await-precedence fixes:** ~40 call sites wrapped as `(await …)` where a property/method was chained after `.get()/.all()/.run()` or `getSetting()` (e.g. `.c`, `.map(…)`, `?.grading_config_json`).
- **Tests:** `test/pg-migrate.test.js` — all 17 assertions pass against real PostgreSQL 18.4 (migrations, seed, insert/lastInsertRowid, get/all/run, tx commit + rollback, ILIKE, getSetting/setSetting, timestamp format, constraints). HTTP smoke test on PG: home/login 200, admin login → forced password change → dashboard 200, student register → dashboard 200, student→/admin 403, anon→/admin 302, case-insensitive search, course reorder transaction `{"ok":true}`.
- **Known follow-up (not in this migration):** file uploads must move to Supabase Storage — Render's disk is ephemeral. See MIGRATION_REPORT.md.

## Supabase Storage migration (2026-10-17)

File uploads were moved off local disk to Supabase Storage, because Render's filesystem is ephemeral (uploads in `uploads/` would disappear on restart/redeploy).

- **New module `lib/storage.js`** — the only place that touches file bytes. Dual backend, auto-detected: `supabase` when `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` are both set, otherwise `local` (current disk behavior, so local dev keeps working). `STORAGE_BACKEND=supabase|local` forces either; forcing `supabase` without credentials throws a clear error at boot-time use. No new npm dependency (raw `fetch` against the Supabase Storage REST API).
- **DB path semantics unchanged:** `file_path` / `audio_path` / `pdf_path` still store `uploads/<prefix>/<filename>`. On Supabase the leading `uploads/` is stripped and the rest is the object key inside `SUPABASE_STORAGE_BUCKET` (default `academy-uploads`). No migration of existing rows needed; views keep linking `/files/<file_path>`.
- **Upload paths:** `routes/admin.js` (materials library, 50 MB) and `routes/student.js` (assignment file + audio submissions, 25 MB) now use multer `memoryStorage` with the same file-type filters and size limits; buffers are uploaded via `storage.uploadBuffer()` after permission checks, with a flash error + redirect on storage failure instead of a silent DB write.
- **Downloads:** `app.js` `/files/*` keeps every existing permission check (materials → enrolled-or-staff; submissions → owner/staff/enrolled; certificates → owner-or-staff; anon → login; `..`/absolute → 403). After the checks: Supabase backend → 302 to a 5-minute signed URL; local backend → `sendFile` exactly as before. `routes/student.js` `/materials/:id/download` and `/certificates/:id/download` behave the same (signed-URL redirect on Supabase, `res.download` locally).
- **Certificates:** `lib/certificates.js` `buildCertificatePDF()` now returns a Buffer (pdfkit chunks collected in memory) and `issueCertificate()` uploads it via `storage.uploadBuffer('certificates', …)`. `certDir()` is kept as a compat export.
- **Deletes:** material deletion calls `storage.deleteObject()` (idempotent, ignores missing objects).
- **Tests:** `test/storage.test.js` — 16 assertions pass: local roundtrip upload/download/delete, filename sanitization, path-escape and prefix guards, backend auto-detect + overrides, mocked-Supabase upload/download/delete/sign (URL, headers, `x-upsert`, `expiresIn` verified), certificate PDF buffer is a valid `%PDF`. Live app boot on Postgres with `STORAGE_BACKEND=local`: admin login → forced password change → material upload → `/files/` download 200 with matching bytes; anon → 302 login; traversal → 403; missing file with DB record → 404; student `/materials/:id/download` 200; certificate issue → PDF download 200 (`%PDF-`) → `/files/` serves it; assignment file+audio submission stored correctly. See STORAGE_REPORT.md.
- **Render env vars needed:** `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` (service role — server-side only, never exposed), optional `SUPABASE_STORAGE_BUCKET` (create the bucket `academy-uploads` as **private** in the Supabase dashboard first).

## Phase 2 (2026-10-18) — live classes, attendance, calendar, roles, email

**Status:** Built and tested locally. NOT pushed / NOT deployed (no local git repo; needs Charlie's GitHub token to push, then Render auto-deploys). Full detail in PHASE2_REPORT.md.

**Live class sessions** — staff schedule sessions per course (title, date/time + timezone, duration, Zoom/Meet meeting URL, description). Times stored as UTC, shown back in the session's timezone (labeled). Students see upcoming sessions on the dashboard, a `/sessions` page, and the course page; the Join button appears 15 min before start until end. Staff can edit/cancel (students notified)/delete. Meeting links are pasted manually — the seam for future Zoom/Meet API integration.

**Attendance** — per session, staff mark each enrolled student present/late/absent/excused (+ note), audit-logged. Per-course report with per-student % present.

**Calendar** — month grid + agenda views combining live sessions, quiz windows/due dates, and assignment due dates. Students see their courses (`/calendar`); staff see all/assigned (`/admin/calendar`).

**Roles** — admin (everything), teacher (full control of *assigned* courses: content, grading, sessions, attendance), TA (grading + attendance + messaging for assigned courses; no content editing). New `/admin/staff` page (admin-only) to create teacher/TA accounts and assign courses. Every course route enforces assignment server-side (`requireCourseAccess`); content routes additionally require admin/teacher (`requireContent`).

**Email** — nodemailer wired to the SMTP settings: real emails for invitations, password resets, announcements, and 24h session reminders (in-process 15-min interval; also auto-completes past sessions). UI stays honest when SMTP isn't configured (console log + in-app notifications, flash messages report actual delivery).

**Tests** — `test/phase2.test.js` ALL PASSED (16 groups on real PostgreSQL 18.4, scratch DB): role/course authorization matrix, timezone + join-window logic, attendance %, calendar merge, email honesty, reminder idempotency, and HTTP proofs (TA 403 on settings/session-create but can mark attendance; teacher 403 on another teacher's course with zero mutation; student/anon boundaries). `pg-migrate` (17) and `storage` (16) suites still pass. 27 pages render 200 across all four roles.

**Honest gaps** — not pushed/deployed; Zoom/Meet API not integrated (manual links); reminders are best-effort on Render's free tier (sleeps when idle); email needs SMTP credentials; question banks stay admin-managed; course duplication doesn't copy sessions; calendar shows the session's own timezone; no iCal export or push notifications.
