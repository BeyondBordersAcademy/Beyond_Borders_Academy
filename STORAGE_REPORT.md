# Supabase Storage Migration Report — Beyond Borders English Academy

**Date:** 2026-10-17
**Goal:** move file uploads from local disk to Supabase Storage (Render's disk is ephemeral; `uploads/materials`, `uploads/submissions`, `uploads/certificates`, `uploads/avatars` must survive restarts/redeploys). Keep 100% of existing behavior and every permission check; degrade gracefully to local disk when Supabase is not configured.

## Files changed

| File | Change |
|---|---|
| `lib/storage.js` | **New.** Single storage abstraction. `backend()` auto-detects: `supabase` if `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` are set, else `local`; `STORAGE_BACKEND=supabase\|local` overrides (forcing `supabase` without credentials throws a clear error). API: `uploadBuffer(prefix, filename, buffer, mimetype)` → DB path; `downloadBuffer(path)`; `deleteObject(path)` (idempotent); `getSignedUrl(path, expiresIn)` (null on local). Raw `fetch` against the Storage REST API — **no new npm dependency**. Prefix whitelist (`materials/submissions/certificates/avatars`), filename sanitization, and path-escape guards built in. |
| `routes/admin.js` | multer `dest:` → `memoryStorage()` (same 50 MB limit, same blocked-extension filter). `POST /materials`: buffer uploaded via `storage.uploadBuffer('materials', …)` after permission checks; storage failure → flash error + redirect (no silent DB write). Material delete: `fs.unlinkSync` → `await storage.deleteObject()`. Removed now-unused `fs` require and `matDir`. |
| `routes/student.js` | multer `dest:` → `memoryStorage()` (same 25 MB limit, same filter). Assignment submit: `file`/`audio` fields uploaded via `storage.uploadBuffer('submissions', …)`; when no new file is attached the previous path is kept (resubmission flow unchanged). `/materials/:id/download` and `/certificates/:id/download`: keep all permission checks; Supabase → 302 to 5-min signed URL, local → `res.download` as before. Removed now-unused `uploadDir`/`mkdirSync`. |
| `lib/certificates.js` | `buildCertificatePDF()` now collects pdfkit output in memory and resolves a **Buffer** (no disk write). `issueCertificate()` uploads it via `storage.uploadBuffer('certificates', '<code>.pdf', …)` and stores the returned path in `pdf_path`. `certDir()` kept as a compat export. |
| `app.js` | `/files/*`: **every existing permission check kept verbatim** (materials → enrolled-or-staff; submissions → owner/staff/enrolled-in-course; certificates → owner-or-staff; anonymous → redirect to login; `..`/absolute → 403; DB record without file → 404). After the checks: Supabase backend → 302 redirect to a 300-second signed URL; local backend → `sendFile` exactly as before. |
| `test/storage.test.js` | **New.** 16-assertion suite (plain node): local roundtrip, sanitization, guards, auto-detect/overrides, mocked-Supabase REST calls, certificate PDF validity. Run: `node test/storage.test.js`. |
| `BUILD_REPORT.md` | Added "Supabase Storage migration" section. |

## How it behaves

**Without Supabase env vars (local dev, default):** identical to the old behavior. Uploads land in `./uploads/<prefix>/`, downloads stream from disk. Nothing else to configure.

**With Supabase (`SUPABASE_URL` + `SUPABASE_SERVICE_KEY` set, e.g. on Render):** uploads go to the `academy-uploads` bucket (override with `SUPABASE_STORAGE_BUCKET`; create the bucket as **private** in the Supabase dashboard). Downloads redirect to a 5-minute signed URL only *after* the app's own permission checks pass — the bucket stays private and no URL is guessable. DB columns keep the same `uploads/<prefix>/<file>` values, so existing rows and all `/files/…` view links keep working with zero data migration.

**Failure modes:** storage upload failure during material/submission creation → user sees "Upload failed (storage error). Please try again." and no broken DB row is written. Signed-URL failure on download → the standard 500 error page (logged). The service-role key is server-side only, never sent to browsers.

## Test results

`node test/storage.test.js` — **ALL 16 PASSED**:
- backend auto-detect → `local` with no env; `STORAGE_BACKEND=local` overrides Supabase env; forced `supabase` without credentials throws a clear error.
- local: upload → download roundtrip byte-identical; `getSignedUrl` → `null`; `deleteObject` idempotent; `../../evil/x.png` → basename `x.png`; `../secret` read rejected; unknown prefix rejected.
- mocked Supabase (fetch stub): `POST /storage/v1/object/academy-uploads/submissions/hw1.pdf` with `apikey`, `Authorization: Bearer`, `x-upsert: true`, correct `Content-Type`, raw buffer body; download `GET` returns bytes; `DELETE` hits the right URL; `POST /object/sign/…` with `{expiresIn: 300}` returns the full signed URL; unknown prefix makes no request.
- `buildCertificatePDF()` returns a Buffer starting with `%PDF-` (5,046 bytes), and it uploads through the storage layer.

**Live app boot test** (real PostgreSQL 18.4, `STORAGE_BACKEND=local`, port 3101) — all verified via curl:
1. Admin login → forced password change → `/admin` 200.
2. Material upload (multipart, memoryStorage) → 302; file on disk at `uploads/materials/…`.
3. `/files/uploads/materials/<file>` as staff → **200, bytes match upload**.
4. Anonymous → **302 to /login**; `..%2F` traversal → **403**; DB record with missing file → **404** (pre-existing semantics preserved).
5. Enrolled student `/materials/:id/download` → **200, bytes match**.
6. Certificate issue (forced) → PDF stored via storage layer; student download → **200, valid `%PDF-`**; `/files/` serves the same PDF (byte-identical).
7. Assignment submission with file + audio → both stored under `uploads/submissions/…`, DB paths correct; staff `/files/` download of submission → **200, bytes match**.

Test servers were shut down afterward (app by PID, scratch Postgres stopped); scratch test files removed from `uploads/`. The local `uploads/` tree and `watchdog.sh` were not touched. The Postgres migration was not touched.

## Render deployment checklist (for the parent)

Set on the Render web service: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` (service role), and in the Supabase dashboard create a **private** bucket named `academy-uploads` (or set `SUPABASE_STORAGE_BUCKET`). No code or DB changes needed at deploy time.
