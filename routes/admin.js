// Admin / teacher portal. requireStaff on the whole router; requireAdmin for
// site settings and destructive config. All permissions enforced server-side.
const express = require('express');
const path = require('path');
const multer = require('multer');
const slugify = require('slugify');
const bcrypt = require('bcryptjs');
const { db, getSetting, setSetting } = require('../lib/db');
const { requireStaff, requireAdmin } = require('../lib/auth');
const { audit, notify, randomToken, computeGradebook, updateProgress, esc, fmtDate } = require('../lib/helpers');
const { issueCertificate } = require('../lib/certificates');
const storage = require('../lib/storage');

const router = express.Router();
router.use(requireStaff);

// ---- uploads (materials library) -------------------------------------------------
// memoryStorage: after permission checks the buffer is pushed to Supabase Storage
// (or local disk when Supabase is not configured) via lib/storage.js.
const matUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const bad = /\.(exe|bat|cmd|sh|js|php|py|rb|pl|cgi|dll|msi|com|scr|jar|html|htm)$/i;
    if (bad.test(file.originalname)) return cb(new Error('File type not allowed for security reasons.'));
    cb(null, true);
  },
});

function paginate(req, total, perPage = 20) {
  const page = Math.max(1, parseInt(req.query.page || '1', 10) || 1);
  return { page, perPage, offset: (page - 1) * perPage, pages: Math.max(1, Math.ceil(total / perPage)) };
}

// tiny JSON lookup used by the certificate issue form
router.get('/api/student-by-email', async (req, res) => {
  const email = String(req.query.email || '').trim().toLowerCase();
  const u = await db.prepare(`SELECT id, name FROM users WHERE email=? AND role='student' AND status='active'`).get(email);
  if (!u) return res.json({ ok: false });
  res.json({ ok: true, id: u.id, name: u.name });
});

// ---- overview ---------------------------------------------------------------------
router.get('/', async (req, res) => {  const stats = {
    students: (await db.prepare(`SELECT COUNT(*) c FROM users WHERE role='student'`).get()).c,
    activeStudents: (await db.prepare(`SELECT COUNT(*) c FROM users WHERE role='student' AND status='active'`).get()).c,
    courses: (await db.prepare(`SELECT COUNT(*) c FROM courses WHERE status='published'`).get()).c,
    draftCourses: (await db.prepare(`SELECT COUNT(*) c FROM courses WHERE status='draft'`).get()).c,
    enrollments: (await db.prepare(`SELECT COUNT(*) c FROM enrollments WHERE status='active'`).get()).c,
    pendingGrading: (await db.prepare(`SELECT COUNT(*) c FROM submissions WHERE status IN ('submitted','under_review')`).get()).c
      + (await db.prepare(`SELECT COUNT(*) c FROM attempts WHERE status='needs_grading'`).get()).c,
    certificates: (await db.prepare(`SELECT COUNT(*) c FROM certificates WHERE status='valid'`).get()).c,
    unreadContact: (await db.prepare(`SELECT COUNT(*) c FROM contact_messages WHERE handled=0`).get()).c,
  };
  const recent = await db.prepare(`SELECT a.*, u.name AS actor FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.created_at DESC LIMIT 8`).all();
  const atRisk = await db.prepare(`SELECT u.id, u.name, u.email, e.course_id, c.title AS course_title, e.progress_pct
    FROM enrollments e JOIN users u ON u.id=e.user_id JOIN courses c ON c.id=e.course_id
    WHERE e.status='active' AND e.progress_pct < 25 ORDER BY e.progress_pct LIMIT 8`).all();
  res.render('admin/overview', { title: 'Admin Overview', stats, recent, atRisk });
});

// ---- students -----------------------------------------------------------------------
router.get('/students', async (req, res) => {
  const q = (req.query.q || '').trim();
  const status = req.query.status || '';
  const level = req.query.level || '';
  const conds = [`role='student'`]; const params = [];
  if (q) { conds.push('(name LIKE ? OR email LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  if (status) { conds.push('status=?'); params.push(status); }
  if (level) { conds.push('cefr_level=?'); params.push(level); }
  const where = 'WHERE ' + conds.join(' AND ');
  const total = (await db.prepare(`SELECT COUNT(*) c FROM users ${where}`).get(...params)).c;
  const { page, perPage, offset, pages } = paginate(req, total);
  const students = await db.prepare(`SELECT * FROM users ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, perPage, offset);
  res.render('admin/students', { title: 'Students', students, q, status, level, page, pages, total });
});

router.get('/students/new', async (req, res) => res.render('admin/student-form', { title: 'New Student', s: null }));

router.get('/students/export.csv', async (req, res) => {
  const rows = await db.prepare(`SELECT id, name, email, role, status, cefr_level, created_at FROM users WHERE role='student' ORDER BY name`).all();
  const csv = ['id,name,email,role,status,cefr_level,created_at']
    .concat(rows.map(r => [r.id, `"${r.name.replace(/"/g, '""')}"`, r.email, r.role, r.status, r.cefr_level || '', r.created_at].join(',')))
    .join('\n');
  audit(req.user.id, 'students.exported', `count=${rows.length}`);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="students.csv"');
  res.send(csv);
});

router.post('/students', async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 120);
  const email = String(req.body.email || '').trim().toLowerCase().slice(0, 160);
  const password = String(req.body.password || '');
  const cefr = String(req.body.cefr_level || '').trim().toUpperCase().slice(0, 4) || null;
  if (!name || !email.includes('@') || password.length < 8) {
    req.setFlash('error', 'Name, valid email, and a password of 8+ characters are required.');
    return res.redirect('/admin/students/new');
  }
  if (await db.prepare('SELECT id FROM users WHERE email=?').get(email)) {
    req.setFlash('error', 'That email is already registered.');
    return res.redirect('/admin/students/new');
  }
  const r = await db.prepare(`INSERT INTO users (name, email, password_hash, role, status, cefr_level, admin_notes)
    VALUES (?,?,?,?,?,?,?)`).run(name, email, bcrypt.hashSync(password, 12), 'student', 'active', cefr, String(req.body.admin_notes || '').slice(0, 2000));
  audit(req.user.id, 'student.created', `user=${r.lastInsertRowid} email=${email}`);
  req.setFlash('success', 'Student account created.');
  res.redirect('/admin/students/' + r.lastInsertRowid);
});

router.get('/students/:id', async (req, res) => {
  const s = await db.prepare('SELECT * FROM users WHERE id=? AND role=\'student\'').get(req.params.id);
  if (!s) return res.status(404).render('errors/404', { title: 'Student not found' });
  const enrollments = await db.prepare(`SELECT e.*, c.title FROM enrollments e JOIN courses c ON c.id=e.course_id WHERE e.user_id=?`).all(s.id);
  const submissions = await db.prepare(`SELECT s.*, a.title FROM submissions s JOIN assignments a ON a.id=s.assignment_id
    WHERE s.user_id=? ORDER BY s.updated_at DESC LIMIT 10`).all(s.id);
  const attempts = await db.prepare(`SELECT at.*, q.title FROM attempts at JOIN quizzes q ON q.id=at.quiz_id
    WHERE at.user_id=? AND at.status != 'in_progress' ORDER BY at.submitted_at DESC LIMIT 10`).all(s.id);
  const certs = await db.prepare(`SELECT c.*, co.title AS course_title FROM certificates c JOIN courses co ON co.id=c.course_id WHERE c.user_id=?`).all(s.id);
  const courses = await db.prepare(`SELECT id, title FROM courses WHERE status='published' ORDER BY title`).all();
  res.render('admin/student-detail', { title: s.name, s, enrollments, submissions, attempts, certs, courses });
});

router.post('/students/:id', async (req, res) => {
  const s = await db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!s) return res.status(404).render('errors/404', { title: 'Not found' });
  const action = req.body.action;
  if (action === 'update') {
    const cefr = String(req.body.cefr_level || '').trim().toUpperCase().slice(0, 4) || null;
    await db.prepare('UPDATE users SET name=?, cefr_level=?, admin_notes=?, status=? WHERE id=?')
      .run(String(req.body.name || s.name).slice(0, 120), cefr, String(req.body.admin_notes || '').slice(0, 2000),
        ['active', 'suspended', 'pending'].includes(req.body.status) ? req.body.status : s.status, s.id);
    audit(req.user.id, 'student.updated', `user=${s.id}`);
    req.setFlash('success', 'Student record updated.');
  } else if (action === 'suspend' || action === 'reactivate') {
    await db.prepare('UPDATE users SET status=? WHERE id=?').run(action === 'suspend' ? 'suspended' : 'active', s.id);
    audit(req.user.id, `student.${action}d`, `user=${s.id}`);
    req.setFlash('success', action === 'suspend' ? 'Account suspended.' : 'Account reactivated.');
  } else if (action === 'enroll') {
    const courseId = Number(req.body.course_id);
    if (await db.prepare('SELECT id FROM courses WHERE id=?').get(courseId)) {
      await db.prepare('INSERT INTO enrollments (user_id, course_id) VALUES (?,?) ON CONFLICT (user_id, course_id) DO NOTHING').run(s.id, courseId);
      audit(req.user.id, 'enrollment.admin', `user=${s.id} course=${courseId}`);
      notify(s.id, 'enrollment', 'Enrolled in a course', 'Your teacher enrolled you in a new course.');
      req.setFlash('success', 'Student enrolled.');
    }
  } else if (action === 'reset_password') {
    const pw = randomToken(6);
    await db.prepare('UPDATE users SET password_hash=?, must_change_password=1 WHERE id=?').run(bcrypt.hashSync(pw, 12), s.id);
    audit(req.user.id, 'student.password_reset', `user=${s.id}`);
    req.setFlash('success', `Temporary password set: ${pw} (student must change it at login)`);
  }
  res.redirect('/admin/students/' + s.id);
});

// invitations
router.get('/invites', async (req, res) => {
  const invites = await db.prepare(`SELECT i.*, c.title AS course_title FROM invitations i
    LEFT JOIN courses c ON c.id=i.course_id ORDER BY i.created_at DESC LIMIT 50`).all();
  const courses = await db.prepare('SELECT id, title FROM courses WHERE status=\'published\' ORDER BY title').all();
  res.render('admin/invites', { title: 'Invitations', invites, courses });
});

router.post('/invites', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const courseId = req.body.course_id ? Number(req.body.course_id) : null;
  if (!email.includes('@')) { req.setFlash('error', 'A valid email is required.'); return res.redirect('/admin/invites'); }
  const token = randomToken(24);
  const exp = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
  await db.prepare(`INSERT INTO invitations (email, token, role, course_id, expires_at, created_by)
    VALUES (?,?,?,?,?,?)`).run(email, token, 'student', courseId, exp, req.user.id);
  audit(req.user.id, 'invite.created', `email=${email}`);
  req.setFlash('success', `Invitation created. Share this link: ${req.protocol}://${req.get('host')}/invite/${token}`);
  res.redirect('/admin/invites');
});

// ---- courses --------------------------------------------------------------------------
router.get('/courses', async (req, res) => {
  const courses = await db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM enrollments e WHERE e.course_id=c.id AND e.status='active') AS enrolled
    FROM courses c ORDER BY c.status, c.title`).all();
  res.render('admin/courses', { title: 'Courses', courses });
});

router.get('/courses/new', async (req, res) => res.render('admin/course-form', { title: 'New Course', c: null }));

router.post('/courses', async (req, res) => {
  const title = String(req.body.title || '').trim().slice(0, 200);
  if (!title) { req.setFlash('error', 'A course title is required.'); return res.redirect('/admin/courses/new'); }
  let slug = slugify(title, { lower: true, strict: true }).slice(0, 80) || 'course';
  if (await db.prepare('SELECT id FROM courses WHERE slug=?').get(slug)) slug = `${slug}-${Date.now().toString(36)}`;
  const r = await db.prepare(`INSERT INTO courses
    (title, slug, description, objectives, level, instructor, format, price_cents, enrollment_mode, status, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(title, slug,
    String(req.body.description || ''), String(req.body.objectives || ''),
    String(req.body.level || '').slice(0, 10), String(req.body.instructor || req.user.name).slice(0, 120),
    String(req.body.format || 'self-paced'), Math.max(0, parseInt(req.body.price_cents || '0', 10) || 0),
    ['open', 'invite', 'approval'].includes(req.body.enrollment_mode) ? req.body.enrollment_mode : 'open',
    ['draft', 'published'].includes(req.body.status) ? req.body.status : 'draft', req.user.id);
  audit(req.user.id, 'course.created', `course=${r.lastInsertRowid} title=${title}`);
  req.setFlash('success', 'Course created. Add units and lessons in the course builder.');
  res.redirect(`/admin/courses/${r.lastInsertRowid}/builder`);
});

router.get('/courses/:id/edit', async (req, res) => {
  const c = await db.prepare('SELECT * FROM courses WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).render('errors/404', { title: 'Course not found' });
  res.render('admin/course-form', { title: 'Edit Course', c });
});

router.post('/courses/:id', async (req, res) => {
  const c = await db.prepare('SELECT * FROM courses WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).render('errors/404', { title: 'Course not found' });
  const action = req.body.action || 'update';
  if (action === 'update') {
    const grading = { categories: {} };
    for (const cat of ['assignments', 'quizzes', 'exams', 'participation']) {
      const w = parseFloat(req.body['weight_' + cat]);
      if (!isNaN(w) && w > 0) grading.categories[cat] = w;
    }
    await db.prepare(`UPDATE courses SET title=?, description=?, objectives=?, level=?, instructor=?, format=?,
      price_cents=?, enrollment_mode=?, status=?, grading_config_json=?, completion_requirements=?, certificate_requirements=?
      WHERE id=?`).run(
      String(req.body.title || c.title).slice(0, 200), String(req.body.description || ''),
      String(req.body.objectives || ''), String(req.body.level || '').slice(0, 10),
      String(req.body.instructor || '').slice(0, 120), String(req.body.format || 'self-paced'),
      Math.max(0, parseInt(req.body.price_cents || '0', 10) || 0),
      ['open', 'invite', 'approval'].includes(req.body.enrollment_mode) ? req.body.enrollment_mode : c.enrollment_mode,
      ['draft', 'published', 'archived'].includes(req.body.status) ? req.body.status : c.status,
      JSON.stringify(grading), String(req.body.completion_requirements || ''), String(req.body.certificate_requirements || ''), c.id);
    audit(req.user.id, 'course.updated', `course=${c.id}`);
    req.setFlash('success', 'Course updated.');
    res.redirect('/admin/courses/' + c.id + '/builder');
  } else if (['publish', 'unpublish', 'archive'].includes(action)) {
    const map = { publish: 'published', unpublish: 'draft', archive: 'archived' };
    await db.prepare('UPDATE courses SET status=? WHERE id=?').run(map[action], c.id);
    audit(req.user.id, `course.${action}`, `course=${c.id}`);
    req.setFlash('success', `Course ${action}ed.`);
    res.redirect('/admin/courses');
  } else if (action === 'delete') {
    const enrolled = (await db.prepare('SELECT COUNT(*) c FROM enrollments WHERE course_id=?').get(c.id)).c;
    if (enrolled > 0) {
      req.setFlash('error', `Cannot delete: ${enrolled} student enrollment record(s) exist. Archive the course instead to preserve academic history.`);
      return res.redirect('/admin/courses');
    }
    await db.prepare('DELETE FROM courses WHERE id=?').run(c.id);
    audit(req.user.id, 'course.deleted', `course=${c.id} title=${c.title}`);
    req.setFlash('success', 'Course deleted.');
    res.redirect('/admin/courses');
  } else if (action === 'duplicate') {
    const newId = await duplicateCourse(c.id, req.user.id);
    audit(req.user.id, 'course.duplicated', `from=${c.id} to=${newId}`);
    req.setFlash('success', 'Course duplicated as a draft (lessons, quizzes, assignments copied; no student data).');
    res.redirect('/admin/courses/' + newId + '/builder');
  } else {
    res.redirect('/admin/courses');
  }
});

async function duplicateCourse(courseId, actorId) {
  const c = await db.prepare('SELECT * FROM courses WHERE id=?').get(courseId);
  let slug = (c.slug + '-copy').slice(0, 80);
  if (await db.prepare('SELECT id FROM courses WHERE slug=?').get(slug)) slug += '-' + Date.now().toString(36);
  const nc = await db.prepare(`INSERT INTO courses
    (title, slug, description, objectives, level, instructor, format, price_cents, enrollment_mode, status, grading_config_json, completion_requirements, certificate_requirements, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(c.title + ' (Copy)', slug, c.description, c.objectives, c.level,
    c.instructor, c.format, c.price_cents, c.enrollment_mode, 'draft', c.grading_config_json,
    c.completion_requirements, c.certificate_requirements, actorId);
  const newCourseId = nc.lastInsertRowid;
  const unitMap = {}, lessonMap = {};
  for (const u of await db.prepare('SELECT * FROM units WHERE course_id=? ORDER BY position').all(courseId)) {
    const nu = await db.prepare('INSERT INTO units (course_id, title, position) VALUES (?,?,?)').run(newCourseId, u.title, u.position);
    unitMap[u.id] = nu.lastInsertRowid;
    for (const l of await db.prepare('SELECT * FROM lessons WHERE unit_id=? ORDER BY position').all(u.id)) {
      const nl = await db.prepare('INSERT INTO lessons (unit_id, title, body_html, body_es, position, status) VALUES (?,?,?,?,?,?)')
        .run(nu.lastInsertRowid, l.title, l.body_html, l.body_es, l.position, l.status);
      lessonMap[l.id] = nl.lastInsertRowid;
    }
  }
  for (const m of await db.prepare('SELECT * FROM materials WHERE course_id=?').all(courseId)) {
    await db.prepare(`INSERT INTO materials (course_id, unit_id, lesson_id, title, kind, file_path, external_url, downloadable, tags)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(newCourseId,
      m.unit_id ? unitMap[m.unit_id] || null : null,
      m.lesson_id ? lessonMap[m.lesson_id] || null : null,
      m.title, m.kind, m.file_path, m.external_url, m.downloadable, m.tags);
  }
  const assignMap = {};
  for (const a of await db.prepare('SELECT * FROM assignments WHERE course_id=?').all(courseId)) {
    const na = await db.prepare(`INSERT INTO assignments (course_id, title, instructions, due_at, max_points, rubric_text, submission_formats_json, late_policy, resubmission_allowed, category, weight)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(newCourseId, a.title, a.instructions, a.due_at, a.max_points, a.rubric_text,
      a.submission_formats_json, a.late_policy, a.resubmission_allowed, a.category, a.weight);
    assignMap[a.id] = na.lastInsertRowid;
  }
  const quizMap = {};
  for (const q of await db.prepare('SELECT * FROM quizzes WHERE course_id=?').all(courseId)) {
    const nq = await db.prepare(`INSERT INTO quizzes (course_id, title, instructions, time_limit_min, attempts_allowed, randomize, passing_score, due_at, available_from, available_until, category, weight)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(newCourseId, q.title, q.instructions, q.time_limit_min, q.attempts_allowed,
      q.randomize, q.passing_score, q.due_at, q.available_from, q.available_until, q.category, q.weight);
    quizMap[q.id] = nq.lastInsertRowid;
    for (const qu of await db.prepare('SELECT * FROM questions WHERE quiz_id=?').all(q.id)) {
      await db.prepare('INSERT INTO questions (quiz_id, bank_id, qtype, prompt, options_json, correct_json, points) VALUES (?,?,?,?,?,?,?)')
        .run(nq.lastInsertRowid, qu.bank_id, qu.qtype, qu.prompt, qu.options_json, qu.correct_json, qu.points);
    }
  }
  return newCourseId;
}

// ---- course builder (units/lessons, drag-drop reorder) ------------------------------
router.get('/courses/:id/builder', async (req, res) => {
  const c = await db.prepare('SELECT * FROM courses WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).render('errors/404', { title: 'Course not found' });
  const units = await db.prepare('SELECT * FROM units WHERE course_id=? ORDER BY position').all(c.id);
  const tree = await Promise.all(units.map(async u => ({ ...u, lessons: (await db.prepare('SELECT * FROM lessons WHERE unit_id=? ORDER BY position').all(u.id)) })));
  res.render('admin/course-builder', { title: 'Course Builder: ' + c.title, c, tree });
});

router.post('/courses/:id/builder', async (req, res) => {
  const c = await db.prepare('SELECT * FROM courses WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).render('errors/404', { title: 'Course not found' });
  const action = req.body.action;
  if (action === 'add_unit') {
    const pos = (await db.prepare('SELECT COUNT(*) c FROM units WHERE course_id=?').get(c.id)).c;
    await db.prepare('INSERT INTO units (course_id, title, position) VALUES (?,?,?)')
      .run(c.id, String(req.body.title || 'New Unit').slice(0, 200), pos);
  } else if (action === 'rename_unit') {
    await db.prepare('UPDATE units SET title=? WHERE id=? AND course_id=?')
      .run(String(req.body.title || '').slice(0, 200), Number(req.body.unit_id), c.id);
  } else if (action === 'delete_unit') {
    const lessonCount = (await db.prepare('SELECT COUNT(*) c FROM lessons WHERE unit_id=?').get(Number(req.body.unit_id))).c;
    if (lessonCount > 0) req.setFlash('error', 'Delete or move the lessons in this unit first.');
    else await db.prepare('DELETE FROM units WHERE id=? AND course_id=?').run(Number(req.body.unit_id), c.id);
  } else if (action === 'add_lesson') {
    const unitId = Number(req.body.unit_id);
    if (await db.prepare('SELECT id FROM units WHERE id=? AND course_id=?').get(unitId, c.id)) {
      const pos = (await db.prepare('SELECT COUNT(*) c FROM lessons WHERE unit_id=?').get(unitId)).c;
      await db.prepare('INSERT INTO lessons (unit_id, title, position, status) VALUES (?,?,?,?)')
        .run(unitId, String(req.body.title || 'New Lesson').slice(0, 200), pos, 'draft');
    }
  } else if (action === 'reorder') {
    // order JSON: {units:[ids in order], lessons:{unitId:[lessonIds]}}
    try {
      const order = JSON.parse(req.body.order_json || '{}');
      await db.transaction(async (tx) => {
        for (const [i, uid] of (order.units || []).entries()) {
          await tx.prepare('UPDATE units SET position=? WHERE id=? AND course_id=?').run(i, Number(uid), c.id);
        }
        for (const [unitId, lessonIds] of Object.entries(order.lessons || {})) {
          for (const [i, lid] of lessonIds.entries()) {
            await tx.prepare('UPDATE lessons SET position=?, unit_id=? WHERE id=?').run(i, Number(unitId), Number(lid));
          }
        }
      });
      audit(req.user.id, 'course.reordered', `course=${c.id}`);
      return res.json({ ok: true });
    } catch (e) { return res.status(400).json({ ok: false, error: 'Invalid order data' }); }
  }
  audit(req.user.id, 'course.builder', `course=${c.id} action=${action}`);
  res.redirect(`/admin/courses/${c.id}/builder`);
});

// ---- lesson editor ----------------------------------------------------------------------
router.get('/lessons/:id/edit', async (req, res) => {
  const l = await db.prepare(`SELECT l.*, u.course_id, c.title AS course_title FROM lessons l
    JOIN units u ON u.id=l.unit_id JOIN courses c ON c.id=u.course_id WHERE l.id=?`).get(req.params.id);
  if (!l) return res.status(404).render('errors/404', { title: 'Lesson not found' });
  res.render('admin/lesson-edit', { title: 'Edit Lesson', l, preview: req.query.preview === '1' });
});

router.post('/lessons/:id/edit', async (req, res) => {
  const l = await db.prepare('SELECT * FROM lessons WHERE id=?').get(req.params.id);
  if (!l) return res.status(404).render('errors/404', { title: 'Lesson not found' });
  // body_html is teacher-authored rich text; sanitize minimally (strip scripts).
  const clean = String(req.body.body_html || '').replace(/<script[\s\S]*?<\/script>/gi, '');
  await db.prepare('UPDATE lessons SET title=?, body_html=?, body_es=?, status=? WHERE id=?').run(
    String(req.body.title || l.title).slice(0, 200), clean,
    String(req.body.body_es || '').replace(/<script[\s\S]*?<\/script>/gi, ''),
    req.body.status === 'published' ? 'published' : 'draft', l.id);
  audit(req.user.id, 'lesson.updated', `lesson=${l.id}`);
  req.setFlash('success', 'Lesson saved.');
  const unit = await db.prepare('SELECT course_id FROM units WHERE id=?').get(l.unit_id);
  res.redirect(`/admin/courses/${unit.course_id}/builder`);
});

router.post('/lessons/:id/delete', async (req, res) => {
  const l = await db.prepare('SELECT l.*, u.course_id FROM lessons l JOIN units u ON u.id=l.unit_id WHERE l.id=?').get(req.params.id);
  if (!l) return res.status(404).render('errors/404', { title: 'Lesson not found' });
  await db.prepare('DELETE FROM lessons WHERE id=?').run(l.id);
  audit(req.user.id, 'lesson.deleted', `lesson=${l.id}`);
  req.setFlash('success', 'Lesson deleted.');
  res.redirect(`/admin/courses/${l.course_id}/builder`);
});

// ---- materials library ----------------------------------------------------------------------
router.get('/materials', async (req, res) => {
  const q = (req.query.q || '').trim();
  const kind = req.query.kind || '';
  const conds = []; const params = [];
  if (q) { conds.push('(m.title LIKE ? OR m.tags LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  if (kind) { conds.push('m.kind=?'); params.push(kind); }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const materials = await db.prepare(`SELECT m.*, c.title AS course_title FROM materials m
    LEFT JOIN courses c ON c.id=m.course_id ${where} ORDER BY m.created_at DESC LIMIT 100`).all(...params);
  const courses = await db.prepare('SELECT id, title FROM courses ORDER BY title').all();
  res.render('admin/materials', { title: 'Material Library', materials, courses, q, kind });
});

router.post('/materials', matUpload.single('file'), async (req, res) => {
  const title = String(req.body.title || (req.file ? req.file.originalname : req.body.external_url || 'Untitled')).slice(0, 200);
  const kind = ['document', 'audio', 'video', 'worksheet', 'presentation', 'image', 'link', 'other'].includes(req.body.kind) ? req.body.kind : 'document';
  const courseId = req.body.course_id ? Number(req.body.course_id) : null;
  const external = String(req.body.external_url || '').trim().slice(0, 500);
  if (!req.file && !external) { req.setFlash('error', 'Upload a file or provide an external URL.'); return res.redirect('/admin/materials'); }
  let file_path = null;
  if (req.file) {
    const ext = path.extname(req.file.originalname).toLowerCase();
    const safe = `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
    try {
      file_path = await storage.uploadBuffer('materials', safe, req.file.buffer, req.file.mimetype);
    } catch (e) {
      console.error('[storage] material upload failed:', e.message);
      req.setFlash('error', 'Upload failed (storage error). Please try again.');
      return res.redirect('/admin/materials');
    }
  }
  await db.prepare(`INSERT INTO materials (course_id, title, kind, file_path, external_url, downloadable, tags)
    VALUES (?,?,?,?,?,?,?)`).run(courseId, title, kind, file_path, external || null,
    req.body.downloadable ? 1 : 0, String(req.body.tags || '').slice(0, 300));
  audit(req.user.id, 'material.uploaded', `title=${title}`);
  req.setFlash('success', 'Material added to the library.');
  res.redirect('/admin/materials');
});

router.post('/materials/:id', async (req, res) => {
  const m = await db.prepare('SELECT * FROM materials WHERE id=?').get(req.params.id);
  if (!m) return res.status(404).render('errors/404', { title: 'Not found' });
  const action = req.body.action;
  if (action === 'delete') {
    if (m.file_path) { try { await storage.deleteObject(m.file_path); } catch (e) { console.error('[storage] material delete failed:', e.message); } }
    await db.prepare('DELETE FROM materials WHERE id=?').run(m.id);
    audit(req.user.id, 'material.deleted', `id=${m.id}`);
    req.setFlash('success', 'Material deleted.');
  } else if (action === 'assign') {
    const courseId = Number(req.body.course_id);
    if (await db.prepare('SELECT id FROM courses WHERE id=?').get(courseId)) {
      await db.prepare(`INSERT INTO materials (course_id, title, kind, file_path, external_url, downloadable, tags)
        SELECT ?, title, kind, file_path, external_url, downloadable, tags FROM materials WHERE id=?`)
        .run(courseId, m.id);
      audit(req.user.id, 'material.reused', `material=${m.id} course=${courseId}`);
      req.setFlash('success', 'Material reused in the selected course (no duplicate upload).');
    }
  } else if (action === 'update') {
    await db.prepare('UPDATE materials SET title=?, kind=?, downloadable=?, tags=? WHERE id=?').run(
      String(req.body.title || m.title).slice(0, 200),
      ['document', 'audio', 'video', 'worksheet', 'presentation', 'image', 'link', 'other'].includes(req.body.kind) ? req.body.kind : m.kind,
      req.body.downloadable ? 1 : 0, String(req.body.tags || '').slice(0, 300), m.id);
    req.setFlash('success', 'Material updated.');
  }
  res.redirect('/admin/materials');
});

// ---- assignments ------------------------------------------------------------------------------
router.get('/assignments', async (req, res) => {
  const courseId = req.query.course_id ? Number(req.query.course_id) : null;
  const cond = courseId ? 'WHERE a.course_id=?' : '';
  const params = courseId ? [courseId] : [];
  const list = await db.prepare(`SELECT a.*, c.title AS course_title,
    (SELECT COUNT(*) FROM submissions s WHERE s.assignment_id=a.id AND s.status IN ('submitted','under_review')) AS pending
    FROM assignments a JOIN courses c ON c.id=a.course_id ${cond} ORDER BY a.due_at`).all(...params);
  const courses = await db.prepare('SELECT id, title FROM courses ORDER BY title').all();
  res.render('admin/assignments', { title: 'Assignments', list, courses, courseId });
});

router.get('/assignments/new', async (req, res) => {
  const courses = await db.prepare('SELECT id, title FROM courses ORDER BY title').all();
  res.render('admin/assignment-form', { title: 'New Assignment', a: null, courses });
});

router.post('/assignments', async (req, res) => {
  const courseId = Number(req.body.course_id);
  if (!await db.prepare('SELECT id FROM courses WHERE id=?').get(courseId)) { req.setFlash('error', 'Choose a course.'); return res.redirect('/admin/assignments/new'); }
  const formats = ['text', 'file', 'audio'].filter(f => (req.body['fmt_' + f] ? true : false));
  const r = await db.prepare(`INSERT INTO assignments
    (course_id, title, instructions, due_at, max_points, rubric_text, submission_formats_json, late_policy, resubmission_allowed, category, weight)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(courseId, String(req.body.title || 'Untitled').slice(0, 200),
    String(req.body.instructions || ''), req.body.due_at || null,
    Math.max(1, parseFloat(req.body.max_points) || 100), String(req.body.rubric_text || ''),
    JSON.stringify(formats.length ? formats : ['text']), String(req.body.late_policy || ''),
    req.body.resubmission_allowed ? 1 : 0,
    String(req.body.category || 'assignments').slice(0, 40),
    req.body.weight ? parseFloat(req.body.weight) : null);
  audit(req.user.id, 'assignment.created', `assignment=${r.lastInsertRowid}`);
  // notify enrolled students
  const students = await db.prepare('SELECT user_id FROM enrollments WHERE course_id=? AND status=\'active\'').all(courseId);
  students.forEach(s => notify(s.user_id, 'assignment', 'New assignment', `"${req.body.title}" was assigned.`));
  req.setFlash('success', 'Assignment created and students notified.');
  res.redirect('/admin/assignments?course_id=' + courseId);
});

router.get('/assignments/:id', async (req, res) => {
  const a = await db.prepare(`SELECT a.*, c.title AS course_title FROM assignments a JOIN courses c ON c.id=a.course_id WHERE a.id=?`).get(req.params.id);
  if (!a) return res.status(404).render('errors/404', { title: 'Not found' });
  const subs = await db.prepare(`SELECT s.*, u.name AS student_name, u.email FROM submissions s
    JOIN users u ON u.id=s.user_id WHERE s.assignment_id=? ORDER BY s.updated_at DESC`).all(a.id);
  const formats = JSON.parse(a.submission_formats_json || '["text"]');
  res.render('admin/assignment-grade', { title: 'Grade: ' + a.title, a, subs, formats });
});

router.post('/assignments/:id/grade', async (req, res) => {
  const sub = await db.prepare(`SELECT s.*, a.max_points, a.title FROM submissions s JOIN assignments a ON a.id=s.assignment_id WHERE s.id=?`).get(req.body.submission_id);
  if (!sub) return res.status(404).render('errors/404', { title: 'Submission not found' });
  const grade = Math.max(0, Math.min(Number(sub.max_points), parseFloat(req.body.grade)));
  if (isNaN(grade)) { req.setFlash('error', 'Enter a valid grade.'); return res.redirect('/admin/assignments/' + sub.assignment_id); }
  const status = req.body.action === 'needs_revision' ? 'needs_revision' : 'graded';
  const history = JSON.parse((await db.prepare('SELECT history_json FROM submissions WHERE id=?').get(sub.id)).history_json || '[]');
  history.push({ status: 'graded', at: new Date().toISOString(), grade, by: req.user.id });
  await db.prepare(`UPDATE submissions SET grade=?, feedback=?, status=?, history_json=?, updated_at=datetime('now') WHERE id=?`)
    .run(grade, String(req.body.feedback || '').slice(0, 10000), status, JSON.stringify(history), sub.id);
  audit(req.user.id, 'assignment.graded', `submission=${sub.id} grade=${grade}/${sub.max_points} status=${status}`);
  notify(sub.user_id, 'grade', status === 'graded' ? 'Assignment graded' : 'Revision requested',
    `"${sub.title}": ${grade}/${sub.max_points}. ${String(req.body.feedback || '').slice(0, 200)}`);
  req.setFlash('success', 'Grade saved and student notified.');
  res.redirect('/admin/assignments/' + sub.assignment_id);
});

router.post('/assignments/:id/delete', async (req, res) => {
  const a = await db.prepare('SELECT * FROM assignments WHERE id=?').get(req.params.id);
  if (!a) return res.status(404).render('errors/404', { title: 'Not found' });
  const n = (await db.prepare('SELECT COUNT(*) c FROM submissions WHERE assignment_id=?').get(a.id)).c;
  if (n > 0) { req.setFlash('error', `Cannot delete: ${n} submission(s) exist. Submissions are academic records.`); return res.redirect('/admin/assignments'); }
  await db.prepare('DELETE FROM assignments WHERE id=?').run(a.id);
  audit(req.user.id, 'assignment.deleted', `assignment=${a.id}`);
  req.setFlash('success', 'Assignment deleted.');
  res.redirect('/admin/assignments');
});

// ---- quizzes -------------------------------------------------------------------------------------
router.get('/quizzes', async (req, res) => {
  const courseId = req.query.course_id ? Number(req.query.course_id) : null;
  const cond = courseId ? 'WHERE q.course_id=?' : '';
  const params = courseId ? [courseId] : [];
  const list = await db.prepare(`SELECT q.*, c.title AS course_title, (SELECT COUNT(*) FROM questions qu WHERE qu.quiz_id=q.id) AS qcount
    FROM quizzes q JOIN courses c ON c.id=q.course_id ${cond} ORDER BY q.created_at DESC`).all(...params);
  const courses = await db.prepare('SELECT id, title FROM courses ORDER BY title').all();
  res.render('admin/quizzes', { title: 'Quizzes & Exams', list, courses, courseId });
});

router.get('/quizzes/new', async (req, res) => {
  const courses = await db.prepare('SELECT id, title FROM courses ORDER BY title').all();
  const banks = await db.prepare('SELECT * FROM question_banks ORDER BY name').all();
  res.render('admin/quiz-form', { title: 'New Quiz', quiz: null, courses, banks, questions: [] });
});

router.post('/quizzes', async (req, res) => {
  const courseId = Number(req.body.course_id);
  if (!await db.prepare('SELECT id FROM courses WHERE id=?').get(courseId)) { req.setFlash('error', 'Choose a course.'); return res.redirect('/admin/quizzes/new'); }
  const r = await db.prepare(`INSERT INTO quizzes
    (course_id, title, instructions, time_limit_min, attempts_allowed, randomize, passing_score, due_at, available_from, available_until, category, weight)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(courseId, String(req.body.title || 'Untitled Quiz').slice(0, 200),
    String(req.body.instructions || ''), req.body.time_limit_min ? parseInt(req.body.time_limit_min, 10) : null,
    Math.max(1, parseInt(req.body.attempts_allowed || '1', 10)), req.body.randomize ? 1 : 0,
    req.body.passing_score ? parseFloat(req.body.passing_score) : null,
    req.body.due_at || null, req.body.available_from || null, req.body.available_until || null,
    String(req.body.category || 'quizzes').slice(0, 40), req.body.weight ? parseFloat(req.body.weight) : null);
  audit(req.user.id, 'quiz.created', `quiz=${r.lastInsertRowid}`);
  req.setFlash('success', 'Quiz created. Now add questions.');
  res.redirect(`/admin/quizzes/${r.lastInsertRowid}/edit`);
});

router.get('/quizzes/:id/edit', async (req, res) => {
  const quiz = await db.prepare('SELECT * FROM quizzes WHERE id=?').get(req.params.id);
  if (!quiz) return res.status(404).render('errors/404', { title: 'Quiz not found' });
  const questions = await db.prepare('SELECT * FROM questions WHERE quiz_id=? ORDER BY id').all(quiz.id);
  const banks = await db.prepare('SELECT * FROM question_banks ORDER BY name').all();
  const courses = await db.prepare('SELECT id, title FROM courses WHERE id != ? ORDER BY title').all(quiz.course_id);
  res.render('admin/quiz-form', { title: 'Edit Quiz', quiz, courses, banks, questions });
});

router.post('/quizzes/:id', async (req, res) => {
  const quiz = await db.prepare('SELECT * FROM quizzes WHERE id=?').get(req.params.id);
  if (!quiz) return res.status(404).render('errors/404', { title: 'Quiz not found' });
  const action = req.body.action || 'update';
  if (action === 'update') {
    await db.prepare(`UPDATE quizzes SET title=?, instructions=?, time_limit_min=?, attempts_allowed=?, randomize=?,
      passing_score=?, due_at=?, available_from=?, available_until=?, category=?, weight=? WHERE id=?`).run(
      String(req.body.title || quiz.title).slice(0, 200), String(req.body.instructions || ''),
      req.body.time_limit_min ? parseInt(req.body.time_limit_min, 10) : null,
      Math.max(1, parseInt(req.body.attempts_allowed || '1', 10)), req.body.randomize ? 1 : 0,
      req.body.passing_score ? parseFloat(req.body.passing_score) : null,
      req.body.due_at || null, req.body.available_from || null, req.body.available_until || null,
      String(req.body.category || 'quizzes').slice(0, 40), req.body.weight ? parseFloat(req.body.weight) : null, quiz.id);
    audit(req.user.id, 'quiz.updated', `quiz=${quiz.id}`);
    req.setFlash('success', 'Quiz updated.');
    res.redirect('/admin/quizzes/' + quiz.id + '/edit');
  } else if (action === 'add_question') {
    const qtype = ['multiple_choice', 'multiple_select', 'true_false', 'fill_blank', 'short_answer', 'essay'].includes(req.body.qtype)
      ? req.body.qtype : 'multiple_choice';
    const options = String(req.body.options || '').split('\n').map(s => s.trim()).filter(Boolean);
    let correct = null;
    if (qtype === 'multiple_choice' || qtype === 'true_false') correct = String(req.body.correct_single || '').trim();
    else if (qtype === 'multiple_select') correct = String(req.body.correct_multi || '').split(',').map(s => s.trim()).filter(Boolean);
    else if (qtype === 'fill_blank') correct = String(req.body.correct_text || '').split('|').map(s => s.trim()).filter(Boolean);
    const bankId = req.body.bank_id ? Number(req.body.bank_id) : null;
    // save to bank optionally
    let savedBankId = (bankId && await db.prepare('SELECT id FROM question_banks WHERE id=?').get(bankId)) ? bankId : null;
    if (req.body.save_to_bank && req.body.bank_name) {
      const b = await db.prepare('INSERT INTO question_banks (name, level, topic) VALUES (?,?,?)')
        .run(String(req.body.bank_name).slice(0, 120), String(req.body.bank_level || '').slice(0, 10), String(req.body.bank_topic || '').slice(0, 120));
      savedBankId = b.lastInsertRowid;
    }
    await db.prepare(`INSERT INTO questions (quiz_id, bank_id, qtype, prompt, options_json, correct_json, points)
      VALUES (?,?,?,?,?,?,?)`).run(quiz.id, savedBankId, qtype, String(req.body.prompt || '').slice(0, 5000),
      JSON.stringify(options), JSON.stringify(correct), Math.max(0.5, parseFloat(req.body.points) || 1));
    audit(req.user.id, 'question.added', `quiz=${quiz.id}`);
    req.setFlash('success', 'Question added.');
    res.redirect('/admin/quizzes/' + quiz.id + '/edit');
  } else if (action === 'delete_question') {
    await db.prepare('DELETE FROM questions WHERE id=? AND quiz_id=?').run(Number(req.body.question_id), quiz.id);
    audit(req.user.id, 'question.deleted', `quiz=${quiz.id}`);
    res.redirect('/admin/quizzes/' + quiz.id + '/edit');
  } else if (action === 'delete') {
    await db.prepare('DELETE FROM quizzes WHERE id=?').run(quiz.id);
    audit(req.user.id, 'quiz.deleted', `quiz=${quiz.id}`);
    req.setFlash('success', 'Quiz deleted.');
    res.redirect('/admin/quizzes');
  } else if (action === 'copy_to_course') {
    const targetId = Number(req.body.target_course_id);
    if (await db.prepare('SELECT id FROM courses WHERE id=?').get(targetId)) {
      const nq = await db.prepare(`INSERT INTO quizzes (course_id, title, instructions, time_limit_min, attempts_allowed, randomize, passing_score, due_at, available_from, available_until, category, weight)
        SELECT ?, title, instructions, time_limit_min, attempts_allowed, randomize, passing_score, due_at, available_from, available_until, category, weight FROM quizzes WHERE id=?`)
        .run(targetId, quiz.id);
      for (const qu of await db.prepare('SELECT * FROM questions WHERE quiz_id=?').all(quiz.id)) {
        await db.prepare('INSERT INTO questions (quiz_id, bank_id, qtype, prompt, options_json, correct_json, points) VALUES (?,?,?,?,?,?,?)')
          .run(nq.lastInsertRowid, qu.bank_id, qu.qtype, qu.prompt, qu.options_json, qu.correct_json, qu.points);
      }
      audit(req.user.id, 'quiz.copied', `quiz=${quiz.id} to course=${targetId}`);
      req.setFlash('success', 'Quiz copied to the selected course.');
    }
    res.redirect('/admin/quizzes/' + quiz.id + '/edit');
  } else {
    res.redirect('/admin/quizzes');
  }
});

// question banks
router.get('/banks', async (req, res) => {
  const banks = await db.prepare('SELECT b.*, (SELECT COUNT(*) FROM questions q WHERE q.bank_id=b.id) AS qcount FROM question_banks b ORDER BY b.name').all();
  res.render('admin/banks', { title: 'Question Banks', banks });
});
router.post('/banks', async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 120);
  if (!name) { req.setFlash('error', 'Bank name required.'); return res.redirect('/admin/banks'); }
  await db.prepare('INSERT INTO question_banks (name, level, topic) VALUES (?,?,?)')
    .run(name, String(req.body.level || '').slice(0, 10), String(req.body.topic || '').slice(0, 120));
  req.setFlash('success', 'Question bank created.');
  res.redirect('/admin/banks');
});

// manual grading of open-ended quiz answers
router.get('/quizzes/:id/attempts', async (req, res) => {
  const quiz = await db.prepare('SELECT * FROM quizzes WHERE id=?').get(req.params.id);
  if (!quiz) return res.status(404).render('errors/404', { title: 'Quiz not found' });
  const attempts = await db.prepare(`SELECT at.*, u.name AS student_name FROM attempts at
    JOIN users u ON u.id=at.user_id WHERE at.quiz_id=? AND at.status != 'in_progress' ORDER BY at.submitted_at DESC`).all(quiz.id);
  res.render('admin/quiz-attempts', { title: 'Attempts: ' + quiz.title, quiz, attempts });
});

router.get('/attempts/:id/grade', async (req, res) => {
  const attempt = await db.prepare(`SELECT at.*, u.name AS student_name, q.title AS quiz_title FROM attempts at
    JOIN users u ON u.id=at.user_id JOIN quizzes q ON q.id=at.quiz_id WHERE at.id=?`).get(req.params.id);
  if (!attempt) return res.status(404).render('errors/404', { title: 'Attempt not found' });
  const questions = await db.prepare('SELECT * FROM questions WHERE quiz_id=? ORDER BY id').all(attempt.quiz_id);
  const answers = JSON.parse(attempt.answers_json || '{}');
  res.render('admin/attempt-grade', { title: 'Grade Attempt', attempt, questions, answers });
});

router.post('/attempts/:id/grade', async (req, res) => {
  const attempt = await db.prepare('SELECT * FROM attempts WHERE id=?').get(req.params.id);
  if (!attempt) return res.status(404).render('errors/404', { title: 'Attempt not found' });
  const questions = await db.prepare('SELECT * FROM questions WHERE quiz_id=?').all(attempt.quiz_id);
  let score = 0, max = 0;
  for (const q of questions) {
    max += Number(q.points);
    const key = 'score_' + q.id;
    if (['short_answer', 'essay', 'fill_blank'].includes(q.qtype) && req.body[key] !== undefined) {
      score += Math.max(0, Math.min(Number(q.points), parseFloat(req.body[key]) || 0));
    } else {
      // keep auto-graded portion from the stored attempt score proportionally is complex;
      // recompute auto part from answers
      const answers = JSON.parse(attempt.answers_json || '{}');
      const given = answers['q' + q.id];
      const correct = JSON.parse(q.correct_json);
      let earned = 0;
      if (q.qtype === 'multiple_choice' || q.qtype === 'true_false') earned = String(given || '') === String(correct) ? Number(q.points) : 0;
      else if (q.qtype === 'multiple_select') {
        const g = Array.isArray(given) ? given.map(String).sort() : [];
        const c = (Array.isArray(correct) ? correct : []).map(String).sort();
        earned = JSON.stringify(g) === JSON.stringify(c) ? Number(q.points) : 0;
      } else if (q.qtype === 'fill_blank') {
        const acc = Array.isArray(correct) ? correct : [correct];
        earned = acc.some(a => String(given || '').trim().toLowerCase() === String(a).trim().toLowerCase()) ? Number(q.points) : 0;
      }
      score += earned;
    }
  }
  await db.prepare(`UPDATE attempts SET score=?, max_score=?, status='graded' WHERE id=?`).run(score, max, attempt.id);
  audit(req.user.id, 'quiz.graded', `attempt=${attempt.id} score=${score}/${max}`);
  notify(attempt.user_id, 'grade', 'Quiz graded', `Your quiz attempt was graded: ${score}/${max}.`);
  req.setFlash('success', 'Attempt graded.');
  res.redirect(`/admin/quizzes/${attempt.quiz_id}/attempts`);
});

// ---- gradebook ------------------------------------------------------------------------------
router.get('/gradebook/:course_id', async (req, res) => {
  const course = await db.prepare('SELECT * FROM courses WHERE id=?').get(req.params.course_id);
  if (!course) return res.status(404).render('errors/404', { title: 'Course not found' });
  const students = await db.prepare(`SELECT u.id, u.name, u.email FROM enrollments e
    JOIN users u ON u.id=e.user_id WHERE e.course_id=? AND e.status IN ('active','completed') ORDER BY u.name`).all(course.id);
  const rows = await Promise.all(students.map(async s => ({ student: s, book: await computeGradebook(course.id, s.id) })));
  const cfg = (() => { try { return JSON.parse(course.grading_config_json || '{}'); } catch { return {}; } })();
  res.render('admin/gradebook', { title: 'Gradebook: ' + course.title, course, rows, cfg });
});

router.get('/gradebook/:course_id/export.csv', async (req, res) => {
  const course = await db.prepare('SELECT * FROM courses WHERE id=?').get(req.params.course_id);
  if (!course) return res.status(404).render('errors/404', { title: 'Not found' });
  const students = await db.prepare(`SELECT u.id, u.name, u.email FROM enrollments e
    JOIN users u ON u.id=e.user_id WHERE e.course_id=? AND e.status IN ('active','completed') ORDER BY u.name`).all(course.id);
  const lines = ['student_id,name,email,overall_pct,graded_items,missing_items'];
  for (const s of students) {
    const b = await computeGradebook(course.id, s.id);
    lines.push([s.id, `"${s.name.replace(/"/g, '""')}"`, s.email,
      b.overall == null ? '' : b.overall, b.gradedCount, b.missingCount].join(','));
  }
  audit(req.user.id, 'gradebook.exported', `course=${course.id}`);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="gradebook-course-${course.id}.csv"`);
  res.send(lines.join('\n'));
});

router.post('/gradebook/:course_id/override', async (req, res) => {
  const courseId = Number(req.params.course_id);
  const userId = Number(req.body.user_id);
  const points = parseFloat(req.body.points);
  const max = parseFloat(req.body.max_points);
  if (!(await db.prepare('SELECT id FROM enrollments WHERE user_id=? AND course_id=?').get(userId, courseId)) || isNaN(points) || isNaN(max) || max <= 0) {
    req.setFlash('error', 'Invalid grade entry.');
    return res.redirect('/admin/gradebook/' + courseId);
  }
  await db.prepare(`INSERT INTO grade_overrides (course_id, user_id, item_type, item_id, points, max_points, note, created_by)
    VALUES (?,?,?,?,?,?,?,?)`).run(courseId, userId, 'manual', null, points, max, String(req.body.note || '').slice(0, 300), req.user.id);
  audit(req.user.id, 'grade.override', `course=${courseId} user=${userId} ${points}/${max} note=${req.body.note}`);
  notify(userId, 'grade', 'Grade updated', 'Your teacher recorded a grade adjustment.');
  req.setFlash('success', 'Manual grade recorded (audit-logged).');
  res.redirect('/admin/gradebook/' + courseId);
});

// ---- certificates -----------------------------------------------------------------------------
router.get('/certificates', async (req, res) => {
  const certs = await db.prepare(`SELECT c.*, u.name AS student_name, co.title AS course_title FROM certificates c
    JOIN users u ON u.id=c.user_id JOIN courses co ON co.id=c.course_id ORDER BY c.issued_at DESC LIMIT 100`).all();
  const courses = await db.prepare('SELECT id, title FROM courses ORDER BY title').all();
  res.render('admin/certificates', { title: 'Certificates', certs, courses });
});

async function eligibleForCertificate(userId, courseId) {
  const pct = await updateProgress(userId, courseId);
  const book = await computeGradebook(courseId, userId);
  return { pct, overall: book.overall };
}

router.post('/certificates/issue', async (req, res) => {
  const userId = Number(req.body.user_id);
  const courseId = Number(req.body.course_id);
  const force = req.body.force === '1';
  const enr = await db.prepare('SELECT * FROM enrollments WHERE user_id=? AND course_id=?').get(userId, courseId);
  if (!enr) { req.setFlash('error', 'Student is not enrolled in that course.'); return res.redirect('/admin/certificates'); }
  const { pct, overall } = await eligibleForCertificate(userId, courseId);
  if (!force && (pct < 100 || (overall != null && overall < 70))) {
    req.setFlash('error', `Requirements not met (progress ${pct}%, grade ${overall == null ? 'n/a' : overall + '%'}). Tick "issue anyway" to override -- this will be audit-logged.`);
    return res.redirect('/admin/certificates');
  }
  issueCertificate(userId, courseId, req.user.id, `${req.protocol}://${req.get('host')}`)
    .then(cert => {
      if (force) audit(req.user.id, 'certificate.forced', `code=${cert.code} pct=${pct} grade=${overall}`);
      req.setFlash('success', `Certificate issued: ${cert.code}`);
      res.redirect('/admin/certificates');
    })
    .catch(e => { console.error(e); req.setFlash('error', 'Could not issue certificate: ' + e.message); res.redirect('/admin/certificates'); });
});

router.post('/certificates/:id/revoke', async (req, res) => {
  const cert = await db.prepare('SELECT * FROM certificates WHERE id=?').get(req.params.id);
  if (!cert) return res.status(404).render('errors/404', { title: 'Not found' });
  await db.prepare(`UPDATE certificates SET status='revoked' WHERE id=?`).run(cert.id);
  audit(req.user.id, 'certificate.revoked', `code=${cert.code}`);
  notify(cert.user_id, 'certificate', 'Certificate revoked', `Certificate ${cert.code} has been revoked. Contact the academy with questions.`);
  req.setFlash('success', 'Certificate revoked (audit-logged).');
  res.redirect('/admin/certificates');
});

router.post('/certificates/:id/reissue', async (req, res) => {
  const cert = await db.prepare('SELECT * FROM certificates WHERE id=?').get(req.params.id);
  if (!cert) return res.status(404).render('errors/404', { title: 'Not found' });
  await db.prepare(`UPDATE certificates SET status='revoked' WHERE id=?`).run(cert.id);
  audit(req.user.id, 'certificate.revoked', `code=${cert.code} (reissue)`);
  issueCertificate(cert.user_id, cert.course_id, req.user.id, `${req.protocol}://${req.get('host')}`)
    .then(nc => { req.setFlash('success', `Reissued: ${nc.code} (old code revoked).`); res.redirect('/admin/certificates'); })
    .catch(e => { req.setFlash('error', e.message); res.redirect('/admin/certificates'); });
});

// ---- announcements ------------------------------------------------------------------------------
router.get('/announcements', async (req, res) => {
  const list = await db.prepare(`SELECT a.*, u.name AS author, c.title AS course_title FROM announcements a
    LEFT JOIN users u ON u.id=a.created_by LEFT JOIN courses c ON c.id=a.course_id
    ORDER BY a.created_at DESC LIMIT 50`).all();
  const courses = await db.prepare('SELECT id, title FROM courses ORDER BY title').all();
  res.render('admin/announcements', { title: 'Announcements', list, courses });
});

router.post('/announcements', async (req, res) => {
  const audience = ['all', 'course'].includes(req.body.audience) ? req.body.audience : 'all';
  const courseId = audience === 'course' ? Number(req.body.course_id) : null;
  const title = String(req.body.title || '').trim().slice(0, 200);
  const body = String(req.body.body || '').slice(0, 10000);
  if (!title) { req.setFlash('error', 'Title is required.'); return res.redirect('/admin/announcements'); }
  await db.prepare('INSERT INTO announcements (audience, course_id, title, body, created_by) VALUES (?,?,?,?,?)')
    .run(audience, courseId, title, body, req.user.id);
  let targets = [];
  if (audience === 'all') targets = await db.prepare(`SELECT id FROM users WHERE role='student' AND status='active'`).all();
  else targets = await db.prepare(`SELECT user_id AS id FROM enrollments WHERE course_id=? AND status='active'`).all(courseId);
  targets.forEach(t => notify(t.id, 'announcement', title, body.slice(0, 200)));
  audit(req.user.id, 'announcement.posted', `audience=${audience} course=${courseId}`);
  req.setFlash('success', `Announcement published to ${targets.length} student(s).`);
  res.redirect('/admin/announcements');
});

// ---- messages ---------------------------------------------------------------------------------------
router.get('/messages', async (req, res) => {
  const students = await db.prepare(`SELECT id, name, email FROM users WHERE role='student' ORDER BY name`).all();
  const withId = req.query.with ? Number(req.query.with) : null;
  let thread = [];
  if (withId) {
    thread = await db.prepare(`SELECT m.*, u.name AS from_name FROM messages m JOIN users u ON u.id=m.from_user_id
      WHERE (m.from_user_id=? AND m.to_user_id=?) OR (m.from_user_id=? AND m.to_user_id=?) ORDER BY m.created_at`)
      .all(req.user.id, withId, withId, req.user.id);
    await db.prepare('UPDATE messages SET read=1 WHERE to_user_id=? AND from_user_id=?').run(req.user.id, withId);
  }
  const convos = await db.prepare(`SELECT u.id, u.name,
      (SELECT body FROM messages m WHERE (m.from_user_id=u.id AND m.to_user_id=?) OR (m.from_user_id=? AND m.to_user_id=u.id) ORDER BY created_at DESC LIMIT 1) AS last_body,
      (SELECT COUNT(*) FROM messages m WHERE m.from_user_id=u.id AND m.to_user_id=? AND m.read=0) AS unread
    FROM users u WHERE u.id IN (SELECT DISTINCT CASE WHEN from_user_id=? THEN to_user_id ELSE from_user_id END FROM messages WHERE from_user_id=? OR to_user_id=?)
    ORDER BY u.name`).all(req.user.id, req.user.id, req.user.id, req.user.id, req.user.id, req.user.id);
  res.render('admin/messages', { title: 'Messages', students, convos, thread, withId });
});

router.post('/messages', async (req, res) => {
  const toId = Number(req.body.to_user_id);
  const body = String(req.body.body || '').trim().slice(0, 5000);
  const courseId = req.body.course_id ? Number(req.body.course_id) : null;
  if (!(await db.prepare('SELECT id FROM users WHERE id=?').get(toId)) || !body) {
    req.setFlash('error', 'Message could not be sent.');
    return res.redirect('/admin/messages');
  }
  await db.prepare('INSERT INTO messages (from_user_id, to_user_id, course_id, body) VALUES (?,?,?,?)')
    .run(req.user.id, toId, courseId, body);
  notify(toId, 'message', 'New message from your teacher', body.slice(0, 200));
  audit(req.user.id, 'message.sent', `to=${toId}`);
  res.redirect('/admin/messages?with=' + toId);
});

// ---- reports ------------------------------------------------------------------------------------------
router.get('/reports', async (req, res) => {
  const courseId = req.query.course_id ? Number(req.query.course_id) : null;
  const from = req.query.from || ''; const to = req.query.to || '';
  const econd = courseId ? 'AND e.course_id=?' : '';
  const eparams = courseId ? [courseId] : [];
  const report = {
    totalEnrolled: (await db.prepare(`SELECT COUNT(*) c FROM enrollments e WHERE e.status='active' ${econd}`).get(...eparams)).c,
    completed: (await db.prepare(`SELECT COUNT(*) c FROM enrollments e WHERE e.status='completed' ${econd}`).get(...eparams)).c,
    avgProgress: (await db.prepare(`SELECT AVG(progress_pct) a FROM enrollments e WHERE e.status='active' ${econd}`).get(...eparams)).a,
    submissions: (await db.prepare(`SELECT COUNT(*) c FROM submissions s JOIN assignments a ON a.id=s.assignment_id WHERE 1=1 ${courseId ? 'AND a.course_id=?' : ''}`).get(...eparams)).c,
    avgQuiz: (await db.prepare(`SELECT AVG(score*100.0/max_score) a FROM attempts at JOIN quizzes q ON q.id=at.quiz_id WHERE at.status='graded' AND at.max_score>0 ${courseId ? 'AND q.course_id=?' : ''}`).get(...eparams)).a,
  };
  const byCourse = await db.prepare(`SELECT c.id, c.title, COUNT(e.id) AS enrolled,
      AVG(e.progress_pct) AS avg_progress FROM courses c LEFT JOIN enrollments e ON e.course_id=c.id AND e.status='active'
    GROUP BY c.id ORDER BY c.title`).all();
  const atRisk = await db.prepare(`SELECT u.id, u.name, u.email, c.title AS course_title, e.progress_pct,
      (SELECT COUNT(*) FROM submissions s JOIN assignments a ON a.id=s.assignment_id
        WHERE s.user_id=u.id AND a.course_id=e.course_id AND s.status IN ('submitted','under_review')) AS pending
    FROM enrollments e JOIN users u ON u.id=e.user_id JOIN courses c ON c.id=e.course_id
    WHERE e.status='active' ${courseId ? 'AND e.course_id=?' : ''}
    ORDER BY e.progress_pct LIMIT 25`).all(...eparams);
  const courses = await db.prepare('SELECT id, title FROM courses ORDER BY title').all();
  res.render('admin/reports', { title: 'Academic Reports', report, byCourse, atRisk, courses, courseId, from, to });
});

// ---- contact messages --------------------------------------------------------------------------------------
router.get('/contact-messages', async (req, res) => {
  const list = await db.prepare('SELECT * FROM contact_messages ORDER BY created_at DESC LIMIT 100').all();
  res.render('admin/contact-messages', { title: 'Contact Messages', list });
});
router.post('/contact-messages/:id', async (req, res) => {
  await db.prepare('UPDATE contact_messages SET handled=1 WHERE id=?').run(req.params.id);
  res.redirect('/admin/contact-messages');
});

// ---- audit log ---------------------------------------------------------------------------------------------------
router.get('/audit', async (req, res) => {
  const q = (req.query.q || '').trim();
  const cond = q ? 'WHERE a.action LIKE ? OR a.details LIKE ? OR u.name LIKE ?' : '';
  const params = q ? [`%${q}%`, `%${q}%`, `%${q}%`] : [];
  const total = (await db.prepare(`SELECT COUNT(*) c FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id ${cond}`).get(...params)).c;
  const { page, perPage, offset, pages } = (function () {
    const p = Math.max(1, parseInt(req.query.page || '1', 10) || 1);
    const pp = 30; return { page: p, perPage: pp, offset: (p - 1) * pp, pages: Math.max(1, Math.ceil(total / pp)) };
  })();
  const logs = await db.prepare(`SELECT a.*, u.name AS actor FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id
    ${cond} ORDER BY a.created_at DESC LIMIT ? OFFSET ?`).all(...params, perPage, offset);
  res.render('admin/audit', { title: 'Audit Log', logs, q, page, pages });
});

// ---- settings (admin only) ----------------------------------------------------------------------------------------------
router.get('/settings', requireAdmin, async (req, res) => {
  const keys = ['site_name', 'tagline', 'contact_email', 'contact_phone', 'address',
    'homepage_hero_headline', 'homepage_hero_sub', 'homepage_mission', 'homepage_values',
    'smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'smtp_from'];
  const settings = {};
  for (const k of keys) settings[k] = await getSetting(k, '');
  res.render('admin/settings', { title: 'Academy Settings', settings });
});

router.post('/settings', requireAdmin, async (req, res) => {
  const keys = ['site_name', 'tagline', 'contact_email', 'contact_phone', 'address',
    'homepage_hero_headline', 'homepage_hero_sub', 'homepage_mission', 'homepage_values',
    'smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'smtp_from'];
  for (const k of keys) await setSetting(k, String(req.body[k] || '').slice(0, 2000));
  audit(req.user.id, 'settings.updated', keys.join(','));
  req.setFlash('success', 'Settings saved.');
  res.redirect('/admin/settings');
});

module.exports = router;
