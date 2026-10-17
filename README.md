# Beyond Borders English Academy

Beyond Borders English Academy — "Breaking Barriers, Building Futures." An online English school (LMS) with a public website, student portal, and teacher/administrator dashboard.

## Hosting (Render + Supabase, free tiers)

- **Web service:** Render free web service, built from this repo's `Dockerfile`. Render injects `PORT`; the app reads it automatically.
- **Database:** Supabase Postgres (free tier). Set `DATABASE_URL` to the Supabase Postgres connection string (use the pooler URL with `?sslmode=require`-style params if needed; the app enables SSL automatically for non-localhost hosts).
- **Sessions:** stored in Postgres (`user_sessions` table, created automatically on boot).
- Required env vars: `DATABASE_URL`, `SESSION_SECRET` (any long random string).

## Local development

```bash
npm install
DATABASE_URL="postgres://postgres@127.0.0.1:55433/postgres" PORT=3000 node app.js
```

Admin login: `admin@beyondborders.academy` / `ChangeMe123!` (forced to change on first login).
