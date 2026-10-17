// Public routes: home, about, courses, placement test, contact,
// certificate verification, login/register/password reset/invitations.
const express = require('express');
const bcrypt = require('bcryptjs');
const slugify = require('slugify');
const { db, getSetting } = require('../lib/db');
const { audit, notify, sendEmail, randomToken, esc } = require('../lib/helpers');
const { QUESTIONS, estimateCEFR, LEVEL_DESCRIPTIONS, CEFR_ORDER } = require('../lib/placement');

const router = express.Router();

// ---- home -------------------------------------------------------------------
router.get('/', async (req, res) => {
  const courses = await db.prepare(`SELECT title, slug, level, description, format, price_cents
    FROM courses WHERE status='published' ORDER BY id LIMIT 6`).all();
  const faqs = [
    ['Do I need to pay to start learning?', 'No. Many courses are free, and enrollment in a free course never requires a payment method. Paid programs are always clearly marked with their price.'],
    ['How do I know my English level?', 'Take our free placement assessment. It gives you an approximate CEFR level (A1\u2013C2) and recommends a starting course. It is an estimate, not an official certification.'],
    ['Are classes live or self-paced?', 'Both formats are supported. Self-paced courses let you study anytime; instructor-led cohorts follow a schedule with live sessions.'],
    ['Will I receive a certificate?', 'Yes. When you meet a course\u2019s completion requirements, the academy issues a certificate of completion with a unique verification code. These are academy certificates, not government-accredited qualifications.'],
    ['Is my personal information safe?', 'We protect student records and never sell personal data. See our privacy policy in the footer for details.'],
  ];
  res.render('public/home', { title: 'Home', courses, faqs,
    heroHeadline: await getSetting('homepage_hero_headline'),
    heroSub: await getSetting('homepage_hero_sub'),
    mission: await getSetting('homepage_mission'),
    values: (await getSetting('homepage_values')).split(',').map(s => s.trim()).filter(Boolean),
  });
});

router.get('/about', async (req, res) => res.render('public/about', { title: 'About the Academy' }));

// ---- courses ----------------------------------------------------------------
router.get('/courses', async (req, res) => {
  const q = (req.query.q || '').trim();
  let courses;
  if (q) {
    courses = await db.prepare(`SELECT * FROM courses WHERE status='published'
      AND (title LIKE ? OR description LIKE ? OR level LIKE ?) ORDER BY title`)
      .all(`%${q}%`, `%${q}%`, `%${q}%`);
  } else {
    courses = await db.prepare(`SELECT * FROM courses WHERE status='published' ORDER BY title`).all();
  }
  res.render('public/courses', { title: 'Course Catalog', courses, q });
});

router.get('/courses/:slug', async (req, res) => {
  const course = await db.prepare('SELECT * FROM courses WHERE slug=?').get(req.params.slug);
  if (!course || (course.status !== 'published' && !(req.user && (req.user.role === 'admin' || req.user.role === 'teacher')))) {
    return res.status(404).render('errors/404', { title: 'Course not found' });
  }
  const units = await db.prepare('SELECT * FROM units WHERE course_id=? ORDER BY position').all(course.id);
  const unitIds = units.map(u => u.id);
  const lessons = unitIds.length
    ? (await db.prepare(`SELECT * FROM lessons WHERE unit_id IN (${unitIds.map(() => '?').join(',')}) AND status='published' ORDER BY position`).all(...unitIds))
    : [];
  let enrolled = false;
  if (req.user) {
    enrolled = !!await db.prepare('SELECT id FROM enrollments WHERE user_id=? AND course_id=? AND status IN (\'active\',\'completed\')')
      .get(req.user.id, course.id);
  }
  res.render('public/course-detail', { title: course.title, course, units, lessons, enrolled });
});

// ---- placement assessment ---------------------------------------------------
router.get('/placement', async (req, res) => {
  res.render('public/placement', { title: 'Placement Assessment', questions: QUESTIONS });
});

router.post('/placement', async (req, res) => {
  const answers = req.body.answers || {};
  let correct = 0;
  QUESTIONS.forEach((q, i) => {
    if (String(answers[i] || '').trim() === q.correct) correct++;
  });
  const cefr = estimateCEFR(correct, QUESTIONS.length);
  // Recommend the lowest published course at or above the estimated level; else the highest published course.
  const idx = CEFR_ORDER.indexOf(cefr);
  const published = await db.prepare(`SELECT id, level FROM courses WHERE status='published'`).all();
  let recommended = null;
  for (const lvl of CEFR_ORDER.slice(idx)) {
    recommended = published.find(c => (c.level || '').toUpperCase().startsWith(lvl));
    if (recommended) break;
  }
  if (!recommended) recommended = published[0] || null;
  const name = String(req.body.name || '').slice(0, 120);
  const email = String(req.body.email || '').slice(0, 160);
  const userId = req.user ? req.user.id : null;
  const r = await db.prepare(`INSERT INTO placement_results
    (user_id, name, email, score, max_score, cefr_estimate, recommended_course_id, answers_json)
    VALUES (?,?,?,?,?,?,?,?)`).run(userId, name, email, correct, QUESTIONS.length, cefr,
      recommended ? recommended.id : null, JSON.stringify(answers));
  const result = await db.prepare('SELECT * FROM placement_results WHERE id=?').get(r.lastInsertRowid);
  if (userId) {
    // Store the estimate on the student profile for the teacher to review/adjust.
    await db.prepare('UPDATE users SET cefr_level=? WHERE id=?').run('~' + cefr, userId);
    notify(userId, 'placement', 'Placement result ready', `Your estimated level is ${cefr}. This is an estimate, not an official certification.`);
  }
  audit(userId, 'placement.completed', `score=${correct}/${QUESTIONS.length} cefr~${cefr}`);
  res.render('public/placement-result', { title: 'Your Placement Result', result, cefr,
    description: LEVEL_DESCRIPTIONS[cefr],
    recommended: recommended ? (await db.prepare('SELECT * FROM courses WHERE id=?').get(recommended.id)) : null });
});

// ---- contact ----------------------------------------------------------------
router.get('/contact', async (req, res) => {
  res.render('public/contact', { title: 'Contact Us', contactEmail: (await getSetting('contact_email')) });
});

router.post('/contact', async (req, res) => {
  // Honeypot spam protection
  if (req.body.company_website) return res.redirect('/contact?sent=1');
  const name = String(req.body.name || '').trim().slice(0, 120);
  const email = String(req.body.email || '').trim().slice(0, 160);
  const message = String(req.body.message || '').trim().slice(0, 5000);
  if (!name || !email.includes('@') || !message) {
    req.setFlash('error', 'Please complete your name, a valid email, and a message.');
    return res.redirect('/contact');
  }
  await db.prepare('INSERT INTO contact_messages (name, email, message) VALUES (?,?,?)').run(name, email, message);
  audit(null, 'contact.received', `from=${email}`);
  res.redirect('/contact?sent=1');
});

// ---- certificate verification (public) --------------------------------------
router.get('/verify/:code', async (req, res) => {
  const cert = await db.prepare(`SELECT c.*, u.name AS student_name, co.title AS course_title, co.level AS course_level
    FROM certificates c JOIN users u ON u.id=c.user_id JOIN courses co ON co.id=c.course_id
    WHERE c.code=?`).get(req.params.code.trim().toUpperCase());
  res.render('public/verify', { title: 'Certificate Verification', cert });
});

// ---- auth -------------------------------------------------------------------
router.get('/login', async (req, res) => {
  if (req.user) return res.redirect(req.user.role === 'student' ? '/dashboard' : '/admin');
  res.render('public/login', { title: 'Log In' });
});

router.post('/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const user = await db.prepare('SELECT * FROM users WHERE email=?').get(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    req.setFlash('error', 'Invalid email or password.');
    audit(null, 'auth.login_failed', `email=${email}`);
    return res.redirect('/login');
  }
  if (user.status === 'suspended') {
    req.setFlash('error', 'This account has been suspended. Please contact the academy.');
    return res.redirect('/login');
  }
  if (user.status === 'pending') {
    req.setFlash('error', 'Your registration is pending approval by the academy.');
    return res.redirect('/login');
  }
  req.session.userId = user.id;
  audit(user.id, 'auth.login', '');
  if (user.must_change_password) {
    req.setFlash('info', 'For security, please set a new password.');
    return res.redirect('/profile/password');
  }
  const to = req.session.returnTo || (user.role === 'student' ? '/dashboard' : '/admin');
  delete req.session.returnTo;
  res.redirect(to);
});

router.get('/register', async (req, res) => {
  if (req.user) return res.redirect('/dashboard');
  res.render('public/register', { title: 'Create Account', invite: null });
});

router.post('/register', async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 120);
  const email = String(req.body.email || '').trim().toLowerCase().slice(0, 160);
  const password = String(req.body.password || '');
  const inviteToken = String(req.body.invite_token || '').trim();
  if (!name || !email.includes('@') || password.length < 8) {
    req.setFlash('error', 'Please provide your name, a valid email, and a password of at least 8 characters.');
    return res.redirect('/register');
  }
  if (await db.prepare('SELECT id FROM users WHERE email=?').get(email)) {
    req.setFlash('error', 'An account with this email already exists. Try logging in.');
    return res.redirect('/login');
  }
  // Invitation-based registration
  let role = 'student', status = 'active', courseId = null;
  if (inviteToken) {
    const inv = await db.prepare('SELECT * FROM invitations WHERE token=? AND used=0').get(inviteToken);
    if (!inv || new Date(inv.expires_at) < new Date() || inv.email.toLowerCase() !== email) {
      req.setFlash('error', 'This invitation is invalid or expired.');
      return res.redirect('/register');
    }
    role = inv.role; courseId = inv.course_id;
    await db.prepare('UPDATE invitations SET used=1 WHERE id=?').run(inv.id);
  }
  const hash = bcrypt.hashSync(password, 12);
  const r = await db.prepare(`INSERT INTO users (name, email, password_hash, role, status)
    VALUES (?,?,?,?,?)`).run(name, email, hash, role, status);
  const userId = r.lastInsertRowid;
  if (courseId) {
    await db.prepare('INSERT INTO enrollments (user_id, course_id) VALUES (?,?) ON CONFLICT (user_id, course_id) DO NOTHING').run(userId, courseId);
  }
  audit(userId, 'auth.registered', `role=${role}${inviteToken ? ' via invitation' : ''}`);
  req.session.userId = userId;
  req.setFlash('success', `Welcome, ${esc(name)}! Your account is ready.`);
  res.redirect(role === 'student' ? '/dashboard' : '/admin');
});

router.get('/invite/:token', async (req, res) => {
  const inv = await db.prepare('SELECT * FROM invitations WHERE token=? AND used=0').get(req.params.token);
  if (!inv || new Date(inv.expires_at) < new Date()) {
    return res.status(404).render('errors/404', { title: 'Invitation not found' });
  }
  res.render('public/register', { title: 'Accept Invitation', invite: inv });
});

router.get('/forgot', async (req, res) => res.render('public/forgot', { title: 'Reset Password' }));

router.post('/forgot', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const user = await db.prepare('SELECT id FROM users WHERE email=?').get(email);
  // Always respond the same way to avoid account enumeration.
  if (user) {
    const token = randomToken();
    const exp = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await db.prepare('INSERT INTO password_resets (user_id, token, expires_at) VALUES (?,?,?)').run(user.id, token, exp);
    const link = `${req.protocol}://${req.get('host')}/reset/${token}`;
    sendEmail(email, 'Password reset', `Use this link within 1 hour to reset your password:\n${link}`);
    notify(user.id, 'security', 'Password reset requested', 'A reset link was requested. It expires in 1 hour.');
  }
  req.setFlash('info', 'If an account exists for that email, a reset link has been sent.');
  res.redirect('/login');
});

router.get('/reset/:token', async (req, res) => {
  const pr = await db.prepare('SELECT * FROM password_resets WHERE token=? AND used=0').get(req.params.token);
  if (!pr || new Date(pr.expires_at) < new Date()) {
    return res.status(404).render('errors/404', { title: 'Reset link invalid' });
  }
  res.render('public/reset', { title: 'Set New Password', token: req.params.token });
});

router.post('/reset/:token', async (req, res) => {
  const pr = await db.prepare('SELECT * FROM password_resets WHERE token=? AND used=0').get(req.params.token);
  if (!pr || new Date(pr.expires_at) < new Date()) {
    req.setFlash('error', 'This reset link is invalid or expired.');
    return res.redirect('/forgot');
  }
  const password = String(req.body.password || '');
  if (password.length < 8) {
    req.setFlash('error', 'Password must be at least 8 characters.');
    return res.redirect('/reset/' + req.params.token);
  }
  const hash = bcrypt.hashSync(password, 12);
  await db.prepare('UPDATE users SET password_hash=?, must_change_password=0 WHERE id=?').run(hash, pr.user_id);
  await db.prepare('UPDATE password_resets SET used=1 WHERE id=?').run(pr.id);
  audit(pr.user_id, 'auth.password_reset', '');
  req.setFlash('success', 'Password updated. Please log in.');
  res.redirect('/login');
});

router.post('/logout', async (req, res) => {
  const uid = req.session.userId;
  req.session.destroy(() => {
    if (uid) audit(uid, 'auth.logout', '');
    res.redirect('/');
  });
});

// theme toggle
router.post('/theme', async (req, res) => {
  const next = req.cookies.theme === 'dark' ? 'light' : 'dark';
  res.setHeader('Set-Cookie', `theme=${next}; Path=/; Max-Age=31536000; SameSite=Lax`);
  res.redirect(req.get('Referer') || '/');
});

// ---- password change (any logged-in role; also used for forced first-login change)
const { requireLogin } = require('../lib/auth');
router.get('/profile/password', requireLogin, async (req, res) => {
  res.render('student/password', { title: 'Change Password', forced: !!req.user.must_change_password });
});

router.post('/profile/password', requireLogin, async (req, res) => {
  const cur = String(req.body.current_password || '');
  const next = String(req.body.new_password || '');
  if (next.length < 8) { req.setFlash('error', 'New password must be at least 8 characters.'); return res.redirect('/profile/password'); }
  const user = await db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if (!user.must_change_password && !bcrypt.compareSync(cur, user.password_hash)) {
    req.setFlash('error', 'Current password is incorrect.');
    return res.redirect('/profile/password');
  }
  await db.prepare('UPDATE users SET password_hash=?, must_change_password=0 WHERE id=?')
    .run(bcrypt.hashSync(next, 12), req.user.id);
  audit(req.user.id, 'auth.password_changed', '');
  req.setFlash('success', 'Password changed.');
  res.redirect(req.user.role === 'student' ? '/dashboard' : '/admin');
});

// ---- policies -----------------------------------------------------------------
router.get('/policies/:page', async (req, res) => {
  const pages = ['privacy', 'terms', 'certificates'];
  if (!pages.includes(req.params.page)) return res.status(404).render('errors/404', { title: 'Not found' });
  res.render('public/policy-' + req.params.page, { title: 'Policy' });
});

module.exports = router;
