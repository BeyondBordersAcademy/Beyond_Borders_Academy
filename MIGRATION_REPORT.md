# Postgres Migration Report — Beyond Borders English Academy

**Date:** 2026-10-17
**Goal:** migrate the app from better-sqlite3 to PostgreSQL (`pg`), keeping 100% of app behavior, for hosting on Render (free) + Supabase Postgres (free). The local SQLite instance (`data/academy.db`, port 3000, watchdog cron) was **not touched**.

## Files changed

| File | Change |
|---|---|
| `lib/db.js` | Rewritten: `pg` Pool (`DATABASE_URL`), SSL `{rejectUnauthorized:false}` for non-localhost; `db.prepare()` converts `?`→`$1,$2…` and `LIKE`→`ILIKE` (string-literal-aware); `datetime('now')`→`TO_CHAR(NOW(),'YYYY-MM-DD HH24:MI:SS')`; `run()` appends `RETURNING id` on INSERTs for `lastInsertRowid`; `db.exec` splits multi-statement DDL; `db.transaction(fn)` with BEGIN/COMMIT/ROLLBACK; async `getSetting`/`setSetting`; DDL translated (`SERIAL PRIMARY KEY`, no `COLLATE NOCASE`, no PRAGMAs); exports `createLayer(pool)` test hook; boot waits for `ready` before `listen` |
| `routes/public.js` | All db calls awaited; `(await …)` wraps where props/methods chain after the promise (`.c`, `.map(…)`); `INSERT OR IGNORE` → `INSERT … ON CONFLICT (user_id, course_id) DO NOTHING` |
| `routes/student.js` | Same; also fixed `new Set(await … .all(…).map(…))` |
| `routes/admin.js` | Same; transaction rewritten as `await db.transaction(async (tx) => … tx.prepare …)`; fixed `JSON.parse((await …).history_json …)`; `INSERT OR IGNORE` → `ON CONFLICT DO NOTHING` |
| `lib/helpers.js` | All db calls awaited; fixed `JSON.parse((await …)?.grading_config_json …)` and `(await …).total` |
| `lib/auth.js`, `lib/certificates.js` | All db calls awaited |
| `app.js` | Session store → `connect-pg-simple` with `createTableIfMissing: true`, table `user_sessions`; async middleware; boot awaits `ready`, exits(1) on DB failure |
| `package.json` | Removed `better-sqlite3`, `connect-sqlite3`; added `pg`, `connect-pg-simple`; devDeps `pg-mem` (unused — see below), `@embedded-postgres/linux-x64` |
| `Dockerfile` | Dropped `ENV PORT=7860`/`EXPOSE 7860` (HF plan dead); Render injects `PORT`, app reads it; dropped apt build-tools layer (`pg` is pure JS) |
| `README.md` | Rewritten for Render + Supabase (was HF Spaces frontmatter) |
| `BUILD_REPORT.md` | Added "Postgres migration" section |
| `test/pg-migrate.test.js` | New: 17-assertion suite against real PostgreSQL 18.4 |

## Placeholder-conversion verification

- Scanned every SQL string in the codebase for `?` inside string literals: **none found** (all `?` hits were JS ternaries or the `unitIds.map(() => '?')` placeholder generator, which is runtime-safe).
- `LIKE`→`ILIKE`: all 4 `LIKE` uses are search filters (admin students/materials/audit search, public course search); ILIKE preserves SQLite's case-insensitive LIKE. Verified live: `?q=STUDENT1` matches `student1@test.com`.
- INTEGER 0/1 flags kept as-is (no BOOLEAN conversion). Timestamps keep the `YYYY-MM-DD HH24:MI:SS` TEXT format via `TO_CHAR`.

## Test results

- `test/pg-migrate.test.js` — **ALL 17 PASSED** against real PostgreSQL 18.4 (embedded binaries): migrations, seed (admin + sample draft course), insert/`lastInsertRowid`, get/get-undefined, all, multi-placeholder, ILIKE, tx commit + rollback, update changes, getSetting/setSetting (+ON CONFLICT), seed assertions, timestamp format, UNIQUE + CHECK violations.
- `node -c` passes on all 8 JS files. `npm ls pg` confirms install.
- HTTP smoke test (app on :3100 → local PG): home 200, login 200, admin login → forced password change → dashboard 200, student register → dashboard 200, student→/admin **403**, anon→/admin **302**, case-insensitive search OK, course reorder transaction `{"ok":true}`, clean server log.

## Bugs found & fixed during migration

1. **Await-precedence:** `await db.prepare(…).get(…).c` evaluates `.c` on the promise. ~40 sites wrapped as `(await …).c` (incl. `?.`, `.map()`, `JSON.parse(…)` cases).
2. **`INSERT OR IGNORE`** (3 sites) → `ON CONFLICT (user_id, course_id) DO NOTHING`.
3. **connect-pg-simple `createTableIfMissing` defaults to false** in the installed version → sessions table never created → passed `createTableIfMissing: true`.

## Not verifiable without live Supabase (parent to test)

- Actual Supabase connection (pooler URL, SSL handshake, `pgbouncer` transaction-mode compatibility — the app uses simple `pool.query` + one client per transaction, which works in transaction mode, but verify).
- `SERIAL` columns and `user_sessions` creation under Supabase's default roles/permissions.
- Cold-start behavior on Render free tier (sleep after 15 min idle); `ready` runs migrations on every boot (idempotent via `IF NOT EXISTS` / `schema_migrations`).
- Performance under real latency (many per-request queries; unchanged from SQLite version).

## Known follow-up (out of scope)

**File uploads must move to Supabase Storage.** Render's filesystem is ephemeral — uploaded materials/submissions in `uploads/` will disappear on restart/redeploy. The DB migration does not address this.
