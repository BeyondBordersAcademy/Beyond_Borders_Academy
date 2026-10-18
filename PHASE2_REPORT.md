# Phase 2 Build Report — Beyond Borders English Academy

**Date:** 2026-10-18
**Status:** Built and tested locally. **NOT pushed, NOT deployed** (no git repo locally; needs Charlie's GitHub token to push, then Render will auto-deploy).

## What was built

### 1. Live class sessions
- New `live_sessions` table (migration v3): course, title, description, `starts_at` (UTC, same TEXT format as the rest of the app), `duration_min`, `timezone`, `meeting_url`, `status` (scheduled/cancelled/completed), `reminder_sent_at`, `created_by`.
- Staff: `/admin/sessions` (list with status + Join-now button for staff), `/admin/sessions/new`, edit, cancel (notifies students), delete. Timezone-aware scheduling: staff pick date/time + one of 24 timezones; stored as UTC via the Intl API (no new dependency); students always see the correct local rendering, labeled with the zone.
- Students: "Upcoming Live Classes" on the dashboard, a `/sessions` page (upcoming + past with their own attendance mark), and upcoming sessions on the course detail page. The **Join button appears 15 min before start until the session ends**, only for scheduled sessions with a meeting URL.
- Design decision (per brief): meeting URL is pasted per session (Zoom/Meet link) — the seam where a future Zoom/Meet API integration plugs in. No OAuth was built.

### 2. Attendance
- New `attendance` table: per session per student, status present/late/absent/excused + note + who marked it (audit-logged).
- `/admin/sessions/:id/attendance` — marking sheet for enrolled students (defaults to present).
- `/admin/attendance?course_id=` — per-course report: per-student present/late/absent/excused counts and % present = (present+late)/total sessions. TAs and teachers can both mark.

### 3. Calendar
- Month grid + agenda list views combining live sessions, quiz windows/due dates, and assignment due dates.
- Students: `/calendar` (their enrolled courses). Staff: `/admin/calendar` (all courses for admin, assigned courses for teacher/TA).

### 4. Roles: admin / teacher / TA
- `requireStaff` now admits admin+teacher+ta to the staff portal. New `requireContent` (admin+teacher) gates all content create/edit/delete routes — TAs get 403 there. `requireAdmin` unchanged (settings, user management, invites, banks, audit, contact messages, announcements-to-all).
- New `staff_courses` table + `/admin/staff` (admin-only): create teacher/TA accounts (forced password change), change roles, suspend/reactivate, reset passwords, assign/unassign courses.
- New `requireCourseAccess(resolve)` middleware: teachers/TAs only touch assigned courses; every course-scoped route (builder, lessons, materials, assignments, quizzes, gradebook, certificates, sessions, attendance, reports, messages) enforces it. Teachers auto-get assigned when they create a course.
- Lists (courses, materials, assignments, quizzes, certificates, reports, messages, overview stats) are scoped to assigned courses for non-admin staff.
- Teachers can post announcements to their own courses; academy-wide stays admin-only. Students can message TAs now.

### 5. Email (nodemailer, card-free)
- `sendEmail()` in lib/helpers.js now sends real mail via nodemailer using the SMTP fields in site settings (host/port/user/pass/from). New `emailConfigured()` helper.
- Wired into: invitations, password resets, announcements (per-recipient), and the 24h session-reminder worker. UI is honest everywhere: flash messages say whether the email actually went out; settings page shows configured/not-configured status; forgot-password page tells the user to ask their teacher when email isn't configured.
- Until SMTP is configured, behavior is exactly as before (console log + in-app notifications), and nothing claims an email was sent when it wasn't.
- Reminder worker: in-process `setInterval` (15 min) in app.js — finds sessions starting within 24h, emails + notifies enrolled students, marks `reminder_sent_at` (idempotent); also auto-flips past sessions to `completed`.

## Files changed / added
- `lib/db.js` — migration v3 (`live_sessions`, `attendance`, `staff_courses`); `staff_courses` added to NO_ID_TABLES.
- `lib/auth.js` — `requireContent`, `canAccessCourse`, `staffCourseIds`, `assignCourse`/`unassignCourse`, `requireCourseAccess`, `courseFilter`; TA admitted to staff portal and file checks.
- `lib/helpers.js` — nodemailer `sendEmail`/`emailConfigured`, timezone utils (`zonedTimeToUtc`, `utcToZonedText`, `zonedDateTimeParts`, `toDbTs`, `parseDbTs`), `sessionTimes`/`canJoinSession`/`sessionDisplayTime`, `getCalendarEvents`/`buildMonthGrid`, `attendanceSummary`, `runSessionReminders`.
- `routes/admin.js` — role gating + course scoping across all routes; new staff, sessions, attendance, calendar routes.
- `routes/student.js` — `/sessions`, `/calendar`, dashboard upcoming sessions; students may message TAs.
- `routes/public.js` — course detail shows upcoming sessions; honest forgot-password message.
- `app.js` — TA in `/files` permission check; in-process reminder scheduler (only when run directly).
- `package.json` — added `nodemailer`.
- New views: `admin/sessions.ejs`, `admin/session-form.ejs`, `admin/attendance-mark.ejs`, `admin/attendance-report.ejs`, `admin/calendar.ejs`, `admin/staff.ejs`, `student/sessions.ejs`, `student/calendar.ejs`, `partials/calendar-grid.ejs` (shared).
- Updated views: `admin/_nav.ejs` (role-aware links), `admin/overview.ejs` (scoped for staff), `admin/reports.ejs` (empty-state), `admin/settings.ejs` (email status), `admin/announcements.ejs` (audience gating), `student/dashboard.ejs`, `public/course-detail.ejs`.
- `test/phase2.test.js` — new suite (see below).

## Test results
- `test/phase2.test.js` — **ALL PASSED** (16 groups, real PostgreSQL 18.4, scratch `phase2test` DB): migrations create the 3 tables; `canAccessCourse` matrix (admin bypass, teacher/TA assigned-only, student never); `requireAdmin` blocks teacher+TA; `requireContent` blocks TA; `requireCourseAccess` blocks cross-course; timezone conversion incl. EST round-trip; join-window logic (15-min rule, cancelled, no-URL); attendance summary %; calendar merges 3 event kinds + scoping; email honesty (unconfigured → sent:false; bad host → graceful failure, never throws); reminder worker (reminds once, idempotent, auto-completes past sessions, creates in-app notifications); HTTP proofs — **TA gets 403 on /admin/settings and /admin/sessions/new but 200 on attendance marking (incl. POST saving a mark)**; **teacher gets 403 viewing/editing/POSTing another teacher's course with zero mutation, sees only assigned courses, but 200 on own course builder**; admin keeps access; student sees sessions page with the session listed; anonymous → 302.
- `test/pg-migrate.test.js` — **ALL 17 PASSED** (regression check, incl. new migration v3 applying cleanly).
- `test/storage.test.js` — **ALL 16 PASSED** (regression check).
- Render smoke: 27 pages across admin/teacher/TA/student all return 200.

## Honest gaps / known limitations
1. **Not pushed, not deployed.** No `.git` in the local repo — needs a fresh GitHub token from Charlie (transient use) to push; Render will auto-deploy from the push.
2. **Zoom/Meet API not integrated** — meeting links are pasted manually per session (documented seam in code comments for future OAuth work).
3. **Reminders are best-effort on Render free tier**: the worker only runs while the process is awake; the free tier sleeps after 15 min idle. The 24h window means any wake-up inside it still delivers, but a site that sleeps 24h straight would miss reminders.
4. **Email needs SMTP credentials** to do anything real; until then it's console + in-app (honest UI).
5. **Question banks stay admin-only** (teachers can *use* banks in the quiz form but not manage them).
6. **Duplicating a course does not copy live sessions** (scheduled events aren't content).
7. **Calendar shows session times in the session's own timezone** (labeled), not auto-converted to the viewer's zone.
8. Attendance "late" counts as present in the % (shown and labeled in the report).
9. No iCal/ICS export; no push notifications.

## What I need from Charlie next
1. **A fresh GitHub token** (paste in chat; used once to push, never stored) — then I push and Render auto-deploys Phase 2.
2. **SMTP credentials** (host, port, username, password, from-address) if he wants real emails — entered by him in Admin → Settings, or pasted for me to enter transiently.
3. **Zoom vs Google Meet**: no action needed — just paste meeting links per session for now; API integration is a future phase if he wants it.
4. **Who the first teachers/TAs are** — he creates them in Admin → Staff and assigns their courses.
