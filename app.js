// Beyond Borders English Academy -- Phase 1 LMS
// Express app: public site, student portal, admin/teacher portal.
const path = require('path');
const fs = require('fs');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const { db, getSetting, pool, ready } = require('./lib/db');
const { attachUser } = require('./lib/auth');
const storage = require('./lib/storage');

const app = express();
const PORT = process.env.PORT || 3000;

// ---- view engine ------------------------------------------------------------
const expressLayouts = require('express-ejs-layouts');
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
app.set('layout', 'layout');

// ---- static + uploads -------------------------------------------------------
app.use(express.static(path.join(__dirname, 'public')));
for (const d of ['uploads/materials', 'uploads/submissions', 'uploads/certificates', 'uploads/avatars']) {
  fs.mkdirSync(path.join(__dirname, d), { recursive: true });
}

// ---- security headers -------------------------------------------------------
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdn.tailwindcss.com'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://cdn.tailwindcss.com', 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'blob:'],
      mediaSrc: ["'self'", 'blob:'],
      connectSrc: ["'self'"],
      frameSrc: ["'self'"],
    },
  },
}));

// ---- body parsing -----------------------------------------------------------
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.json({ limit: '2mb' }));

// ---- sessions (server-side, Postgres store) -----------------------------------
const PgStore = require('connect-pg-simple')(session);
app.use(session({
  store: new PgStore({ pool, tableName: 'user_sessions', createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'bbea-dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 24 * 7 },
}));

// ---- rate limits ------------------------------------------------------------
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false });
const contactLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false });
app.use('/login', authLimiter);
app.use('/register', authLimiter);
app.use('/contact', contactLimiter);

// ---- locals for every view --------------------------------------------------
app.use(attachUser);
// theme cookie (no cookie-parser dependency; tiny manual parse)
app.use(async (req, res, next) => {
  const c = req.headers.cookie || '';
  const m = c.match(/(?:^|;\s*)theme=(dark|light)/);
  req.cookies = { theme: m ? m[1] : 'light' };
  next();
});
app.use(async (req, res, next) => {
  res.locals.siteName = await getSetting('site_name', 'Beyond Borders English Academy');
  res.locals.tagline = await getSetting('tagline', 'Breaking Barriers, Building Futures');
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  res.locals.theme = req.cookies.theme === 'dark' ? 'dark' : 'light';
  next();
});
app.locals.fmtDate = require('./lib/helpers').fmtDate;
app.locals.fmtDateTime = require('./lib/helpers').fmtDateTime;
app.locals.esc = require('./lib/helpers').esc;

function setFlash(req, type, message) {
  req.session.flash = { type, message };
}
app.use(async (req, res, next) => { req.setFlash = (t, m) => setFlash(req, t, m); next(); });
// Force password change: users flagged must_change_password can only visit the
// password page (or log out) until they set a new password.
app.use(async (req, res, next) => {
  if (req.user && req.user.must_change_password) {
    const ok = req.path === '/profile/password' || req.path === '/logout';
    if (!ok) {
      req.setFlash('info', 'For security, please set a new password to continue.');
      return res.redirect('/profile/password');
    }
  }
  next();
});

// ---- routes -----------------------------------------------------------------
app.use('/', require('./routes/public'));
app.use('/', require('./routes/student'));
app.use('/admin', require('./routes/admin'));

// ---- protected file serving ---------------------------------------------------
// Uploads are NOT served statically. /files/<path-under-uploads> checks the
// database record that references the file and enforces ownership server-side.
app.get('/files/*', async (req, res) => {
  const rel = req.params[0] || '';
  if (!rel || rel.includes('..') || path.isAbsolute(rel)) return res.status(403).end();
  const abs = path.join(__dirname, rel);
  const root = path.join(__dirname, 'uploads');
  if (!abs.startsWith(root + path.sep)) return res.status(403).end();
  if (!req.user) { req.session.returnTo = req.originalUrl; return res.redirect('/login'); }

  const isStaff = ['admin', 'teacher', 'ta'].includes(req.user.role);
  let allowed = false;

  const mat = await db.prepare('SELECT course_id FROM materials WHERE file_path=?').get(rel);
  if (mat) {
    allowed = isStaff || !!await db.prepare(
      `SELECT id FROM enrollments WHERE user_id=? AND course_id=? AND status IN ('active','completed')`)
      .get(req.user.id, mat.course_id);
  }
  const sub = await db.prepare(`SELECT s.user_id, a.course_id FROM submissions s
    JOIN assignments a ON a.id=s.assignment_id WHERE s.file_path=? OR s.audio_path=?`).get(rel, rel);
  if (sub) {
    allowed = isStaff || sub.user_id === req.user.id || !!await db.prepare(
      `SELECT id FROM enrollments WHERE user_id=? AND course_id=? AND status IN ('active','completed')`)
      .get(req.user.id, sub.course_id);
  }
  const cert = await db.prepare('SELECT user_id FROM certificates WHERE pdf_path=?').get(rel);
  if (cert) {
    allowed = isStaff || cert.user_id === req.user.id;
  }
  const qaudio = await db.prepare(`SELECT z.course_id FROM questions qq JOIN quizzes z ON z.id=qq.quiz_id
    WHERE qq.audio_url=?`).get('/files/' + rel);
  if (qaudio) {
    allowed = isStaff || (qaudio.course_id && !!await db.prepare(
      `SELECT id FROM enrollments WHERE user_id=? AND course_id=? AND status IN ('active','completed')`)
      .get(req.user.id, qaudio.course_id));
  }
  if (!allowed) return res.status(403).render('errors/403', { title: 'Forbidden' });
  // Supabase backend: the file lives in Supabase Storage (Render's disk is
  // ephemeral), so redirect to a short-lived signed URL after the permission
  // checks above. Local backend: serve from disk as before.
  if (storage.backend() === 'supabase') {
    const url = await storage.getSignedUrl(rel, 300);
    return res.redirect(url);
  }
  if (!fs.existsSync(abs)) return res.status(404).render('errors/404', { title: 'File not found' });
  res.sendFile(abs);
});

// ---- errors -----------------------------------------------------------------
app.use((req, res) => res.status(404).render('errors/404', { title: 'Page not found' }));
// eslint-disable-next-line no-unused-vars
app.use(async (err, req, res, next) => {
  console.error('[error]', err);
  res.status(500).render('errors/500', { title: 'Something went wrong' });
});

// Boot only after DB migrations + seed have completed.
ready.then(() => {
  if (require.main === module) {
    app.listen(PORT, () => {
      console.log(`Beyond Borders English Academy running on http://localhost:${PORT}`);
      console.log('Admin login: admin@beyondborders.academy / ChangeMe123! (change on first login)');
    });
    // Phase 2: in-process scheduler for live-session reminders (24h before)
    // and auto-completing past sessions. Runs every 15 minutes while the
    // process is alive. NOTE: on Render's free tier the process sleeps when
    // idle, so reminders are best-effort -- the 24h window is wide enough
    // that any wake-up inside it still delivers.
    const { runSessionReminders } = require('./lib/helpers');
    const tick = () => runSessionReminders()
      .then(r => { if (r.reminded || r.completed) console.log(`[reminders] reminded=${r.reminded} completed=${r.completed}`); })
      .catch(e => console.error('[reminders] tick failed:', e.message));
    setTimeout(tick, 60 * 1000); // first run 1 min after boot
    setInterval(tick, 15 * 60 * 1000);
  }
}).catch(err => {
  console.error('[db] failed to initialize:', err.message);
  process.exit(1);
});
module.exports = app;
