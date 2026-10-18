// Student portal: dashboard, learning, assignments, quizzes, grades,
// certificates, profile, notifications, messages. Every route requires the
// student role and ownership is checked per record.
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { db } = require('../lib/db');
const { requireStudent, ownsOrStaff } = require('../lib/auth');
const { audit, notify, updateProgress, courseLessons, computeGradebook, fmtDate,
  sessionTimes, canJoinSession, sessionDisplayTime, toDbTs, parseDbTs,
  getCalendarEvents, buildMonthGrid } = require('../lib/helpers');
const storage = require('../lib/storage');

const router = express.Router();
// NOTE: applied per-path (not router-wide) so this router -- mounted at '/'
// -- never intercepts /admin/* or other public routes.
router.use(
  ['/dashboard', '/enroll', '/courses', '/lessons', '/materials', '/assignments',
   '/quiz', '/grades', '/certificates', '/profile', '/notifications', '/messages',
   '/sessions', '/calendar'],
  requireStudent
);

// ---- file uploads (student submissions) -------------------------------------
// memoryStorage: after permission checks the buffer is pushed to Supabase Storage
// (or local disk when Supabase is not configured) via lib/storage.js.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    // Block executables/scripts; allow docs, images, audio, video, archives.
    const bad = /\.(exe|bat|cmd|sh|js|php|py|rb|pl|cgi|dll|msi|com|scr|jar)$/i;
    if (bad.test(file.originalname)) return cb(new Error('File type not allowed'));
    cb(null, true);
  },
});

async function enrolledCourseOr404(req, courseId) {
  const course = await db.prepare('SELECT * FROM courses WHERE id=?').get(courseId);
  if (!course) return null;
  const enr = await db.prepare(`SELECT * FROM enrollments WHERE user_id=? AND course_id=? AND status IN ('active','completed')`)
    .get(req.user.id, courseId);
  if (!enr && req.user.role === 'student') return null;
  return course;
}

// ---- dashboard ----------------------------------------------------------------
router.get('/dashboard', async (req, res) => {
  const enrollments = await db.prepare(`SELECT e.*, c.title, c.slug, c.level, c.instructor
    FROM enrollments e JOIN courses c ON c.id=e.course_id
    WHERE e.user_id=? ORDER BY e.enrolled_at DESC`).all(req.user.id);
  const courseIds = enrollments.map(e => e.course_id);

  let upcomingAssignments = [], upcomingQuizzes = [];
  if (courseIds.length) {
    const ph = courseIds.map(() => '?').join(',');
    upcomingAssignments = await db.prepare(`SELECT a.*, c.title AS course_title FROM assignments a
      JOIN courses c ON c.id=a.course_id
      WHERE a.course_id IN (${ph}) AND (a.due_at IS NULL OR a.due_at >= datetime('now'))
      AND NOT EXISTS (SELECT 1 FROM submissions s WHERE s.assignment_id=a.id AND s.user_id=? AND s.status IN ('submitted','under_review','graded'))
      ORDER BY a.due_at LIMIT 8`).all(...courseIds, req.user.id);
    upcomingQuizzes = await db.prepare(`SELECT q.*, c.title AS course_title FROM quizzes q
      JOIN courses c ON c.id=q.course_id
      WHERE q.course_id IN (${ph})
      AND (q.available_until IS NULL OR q.available_until >= datetime('now'))
      AND (SELECT COUNT(*) FROM attempts at WHERE at.quiz_id=q.id AND at.user_id=? AND at.status IN ('submitted','graded','needs_grading')) < q.attempts_allowed
      ORDER BY q.due_at LIMIT 8`).all(...courseIds, req.user.id);
  }
  const announcements = await db.prepare(`SELECT a.*, u.name AS author FROM announcements a
    LEFT JOIN users u ON u.id=a.created_by
    WHERE a.audience='all' ${courseIds.length ? `OR (a.audience='course' AND a.course_id IN (${courseIds.map(() => '?').join(',')}))` : ''}
    ORDER BY a.created_at DESC LIMIT 6`).all(...courseIds);
  const unread = (await db.prepare('SELECT COUNT(*) c FROM notifications WHERE user_id=? AND read=0').get(req.user.id)).c;
  const unreadMsgs = (await db.prepare('SELECT COUNT(*) c FROM messages WHERE to_user_id=? AND read=0').get(req.user.id)).c;
  let upcomingSessions = [];
  if (courseIds.length) {
    const ph = courseIds.map(() => '?').join(',');
    const cutoff = toDbTs(new Date(Date.now() - 6 * 3600 * 1000));
    const raw = await db.prepare(`SELECT s.*, c.title AS course_title FROM live_sessions s
      JOIN courses c ON c.id=s.course_id
      WHERE s.course_id IN (${ph}) AND s.status='scheduled' AND s.starts_at >= ?
      ORDER BY s.starts_at LIMIT 8`).all(...courseIds, cutoff);
    const nowMs = Date.now();
    upcomingSessions = raw.filter(ss => {
      const { end } = sessionTimes(ss);
      return end && end.getTime() >= nowMs;
    });
  }
  res.render('student/dashboard', { title: 'My Dashboard', enrollments, upcomingAssignments,
    upcomingQuizzes, announcements, unread, unreadMsgs, upcomingSessions,
    sessionDisplayTime, canJoinSession, now: new Date() });
});

// ---- enroll -------------------------------------------------------------------
router.post('/enroll/:id', async (req, res) => {
  const course = await db.prepare('SELECT * FROM courses WHERE id=? AND status=\'published\'').get(req.params.id);
  if (!course) return res.status(404).render('errors/404', { title: 'Course not found' });
  if (course.enrollment_mode !== 'open') {
    req.setFlash('error', 'This course requires an invitation or approval. Please contact the academy.');
    return res.redirect('/courses/' + course.slug);
  }
  if (course.price_cents > 0) {
    req.setFlash('error', 'This is a paid course. Online payments are not enabled yet -- please contact the academy to enroll.');
    return res.redirect('/courses/' + course.slug);
  }
  await db.prepare('INSERT INTO enrollments (user_id, course_id) VALUES (?,?) ON CONFLICT (user_id, course_id) DO NOTHING').run(req.user.id, course.id);
  audit(req.user.id, 'enrollment.self', `course=${course.id}`);
  notify(req.user.id, 'enrollment', 'Enrolled', `You are now enrolled in "${course.title}".`);
  req.setFlash('success', `You are enrolled in "${course.title}".`);
  res.redirect('/courses/' + course.slug + '/learn');
});

// ---- learn: resume from last position ------------------------------------------
router.get('/courses/:slug/learn', async (req, res) => {
  const course = await db.prepare('SELECT * FROM courses WHERE slug=?').get(req.params.slug);
  const ok = course && await enrolledCourseOr404(req, course.id);
  if (!ok) return res.status(404).render('errors/404', { title: 'Course not found' });
  const lessons = courseLessons(course.id);
  if (!lessons.length) {
    req.setFlash('info', 'This course has no published lessons yet.');
    return res.redirect('/dashboard');
  }
  // Resume: first lesson not marked complete, else the first lesson.
  const done = new Set((await db.prepare(`SELECT lesson_id FROM lesson_progress lp
    JOIN lessons l ON l.id=lp.lesson_id JOIN units u ON u.id=l.unit_id
    WHERE lp.user_id=? AND u.course_id=? AND lp.completed=1`).all(req.user.id, course.id)).map(r => r.lesson_id));
  const next = lessons.find(l => !done.has(l.id)) || lessons[0];
  res.redirect(`/lessons/${next.id}`);
});

router.get('/lessons/:id', async (req, res) => {
  const lesson = await db.prepare(`SELECT l.*, u.course_id, u.title AS unit_title, c.title AS course_title, c.slug AS course_slug
    FROM lessons l JOIN units u ON u.id=l.unit_id JOIN courses c ON c.id=u.course_id
    WHERE l.id=?`).get(req.params.id);
  if (!lesson || lesson.status !== 'published') return res.status(404).render('errors/404', { title: 'Lesson not found' });
  if (!await enrolledCourseOr404(req, lesson.course_id)) return res.status(403).render('errors/403', { title: 'Not enrolled' });

  const lessons = courseLessons(lesson.course_id);
  const idx = lessons.findIndex(l => l.id === lesson.id);
  const prev = idx > 0 ? lessons[idx - 1] : null;
  const next = idx < lessons.length - 1 ? lessons[idx + 1] : null;
  const progress = await db.prepare('SELECT completed FROM lesson_progress WHERE user_id=? AND lesson_id=?')
    .get(req.user.id, lesson.id);
  const materials = await db.prepare('SELECT * FROM materials WHERE lesson_id=? OR (course_id=? AND lesson_id IS NULL AND unit_id IS NULL) ORDER BY title')
    .all(lesson.id, lesson.course_id);
  res.render('student/lesson', { title: lesson.title, lesson, lessons, prev, next,
    completed: !!(progress && progress.completed), materials,
    showEs: req.user.preferred_lang === 'es' });
});

router.post('/lessons/:id/complete', async (req, res) => {
  const lesson = await db.prepare(`SELECT l.*, u.course_id FROM lessons l JOIN units u ON u.id=l.unit_id WHERE l.id=?`).get(req.params.id);
  if (!lesson || !await enrolledCourseOr404(req, lesson.course_id)) return res.status(403).render('errors/403', { title: 'Forbidden' });
  const completed = req.body.completed === '1' ? 1 : 0;
  await db.prepare(`INSERT INTO lesson_progress (user_id, lesson_id, completed) VALUES (?,?,?)
    ON CONFLICT(user_id, lesson_id) DO UPDATE SET completed=excluded.completed, updated_at=datetime('now')`)
    .run(req.user.id, lesson.id, completed);
  const pct = updateProgress(req.user.id, lesson.course_id);
  audit(req.user.id, 'lesson.progress', `lesson=${lesson.id} completed=${completed}`);
  // Check certificate eligibility quietly -- admin issues, but notify student at 100%.
  if (pct >= 100) notify(req.user.id, 'progress', 'Course complete!', 'You finished all lessons. Your teacher will review and issue your certificate.');
  res.redirect('/lessons/' + lesson.id);
});

// ---- materials library ----------------------------------------------------------
router.get('/materials', async (req, res) => {
  const courseIds = (await db.prepare('SELECT course_id FROM enrollments WHERE user_id=? AND status IN (\'active\',\'completed\')')
    .all(req.user.id)).map(r => r.course_id);
  let materials = [];
  if (courseIds.length) {
    const ph = courseIds.map(() => '?').join(',');
    materials = await db.prepare(`SELECT m.*, c.title AS course_title FROM materials m
      JOIN courses c ON c.id=m.course_id WHERE m.course_id IN (${ph}) ORDER BY c.title, m.title`).all(...courseIds);
  }
  res.render('student/materials', { title: 'My Learning Materials', materials });
});

router.get('/materials/:id/download', async (req, res) => {
  const m = await db.prepare('SELECT * FROM materials WHERE id=?').get(req.params.id);
  if (!m || !m.file_path) return res.status(404).render('errors/404', { title: 'File not found' });
  if (!await enrolledCourseOr404(req, m.course_id)) return res.status(403).render('errors/403', { title: 'Forbidden' });
  if (!m.downloadable) return res.status(403).render('errors/403', { title: 'View-only material' });
  if (storage.backend() === 'supabase') {
    const url = await storage.getSignedUrl(m.file_path, 300);
    return res.redirect(url);
  }
  const abs = path.join(__dirname, '..', m.file_path);
  if (!abs.startsWith(path.join(__dirname, '..', 'uploads'))) return res.status(403).render('errors/403', { title: 'Forbidden' });
  if (!fs.existsSync(abs)) return res.status(404).render('errors/404', { title: 'File not found' });
  res.download(abs, m.title);
});

// ---- assignments ------------------------------------------------------------------
router.get('/assignments', async (req, res) => {
  const courseIds = (await db.prepare('SELECT course_id FROM enrollments WHERE user_id=? AND status IN (\'active\',\'completed\')')
    .all(req.user.id)).map(r => r.course_id);
  let assignments = [];
  if (courseIds.length) {
    const ph = courseIds.map(() => '?').join(',');
    assignments = await db.prepare(`SELECT a.*, c.title AS course_title,
      (SELECT status FROM submissions s WHERE s.assignment_id=a.id AND s.user_id=? ORDER BY updated_at DESC LIMIT 1) AS my_status,
      (SELECT grade FROM submissions s WHERE s.assignment_id=a.id AND s.user_id=? ORDER BY updated_at DESC LIMIT 1) AS my_grade
      FROM assignments a JOIN courses c ON c.id=a.course_id
      WHERE a.course_id IN (${ph}) ORDER BY a.due_at`).all(req.user.id, req.user.id, ...courseIds);
  }
  res.render('student/assignments', { title: 'My Assignments', assignments });
});

router.get('/assignments/:id', async (req, res) => {
  const a = await db.prepare(`SELECT a.*, c.title AS course_title FROM assignments a JOIN courses c ON c.id=a.course_id WHERE a.id=?`)
    .get(req.params.id);
  if (!a || !await enrolledCourseOr404(req, a.course_id)) return res.status(404).render('errors/404', { title: 'Assignment not found' });
  const sub = await db.prepare('SELECT * FROM submissions WHERE assignment_id=? AND user_id=? ORDER BY updated_at DESC LIMIT 1')
    .get(a.id, req.user.id);
  const history = sub ? JSON.parse(sub.history_json || '[]') : [];
  const formats = JSON.parse(a.submission_formats_json || '["text"]');
  res.render('student/assignment-detail', { title: a.title, a, sub, history, formats });
});

router.post('/assignments/:id/submit', upload.fields([{ name: 'file', maxCount: 1 }, { name: 'audio', maxCount: 1 }]), async (req, res) => {
  const a = await db.prepare('SELECT * FROM assignments WHERE id=?').get(req.params.id);
  if (!a || !await enrolledCourseOr404(req, a.course_id)) return res.status(404).render('errors/404', { title: 'Assignment not found' });
  const formats = JSON.parse(a.submission_formats_json || '["text"]');
  let sub = await db.prepare('SELECT * FROM submissions WHERE assignment_id=? AND user_id=? ORDER BY updated_at DESC LIMIT 1')
    .get(a.id, req.user.id);
  if (sub && ['submitted', 'under_review', 'graded'].includes(sub.status) && !a.resubmission_allowed) {
    req.setFlash('error', 'Resubmission is not allowed for this assignment.');
    return res.redirect('/assignments/' + a.id);
  }
  const body_text = formats.includes('text') ? String(req.body.body_text || '').slice(0, 100000) : '';
  let file_path = sub ? sub.file_path : null;
  let audio_path = sub ? sub.audio_path : null;
  try {
    if (req.files && req.files.file) {
      const f = req.files.file[0];
      const ext = path.extname(f.originalname).toLowerCase();
      file_path = await storage.uploadBuffer('submissions',
        `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`, f.buffer, f.mimetype);
    }
    if (req.files && req.files.audio) {
      const f = req.files.audio[0];
      const ext = path.extname(f.originalname).toLowerCase();
      audio_path = await storage.uploadBuffer('submissions',
        `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`, f.buffer, f.mimetype);
    }
  } catch (e) {
    console.error('[storage] submission upload failed:', e.message);
    req.setFlash('error', 'File upload failed (storage error). Please try again.');
    return res.redirect('/assignments/' + a.id);
  }
  const action = req.body.action === 'save_draft' ? 'draft' : 'submitted';
  const history = sub ? JSON.parse(sub.history_json || '[]') : [];
  if (sub && sub.status !== 'draft') history.push({ status: sub.status, at: sub.updated_at, grade: sub.grade });
  const now = new Date().toISOString();
  if (sub) {
    await db.prepare(`UPDATE submissions SET body_text=?, file_path=?, audio_path=?, status=?,
      submitted_at=CASE WHEN ?='submitted' THEN ? ELSE submitted_at END,
      history_json=?, updated_at=datetime('now') WHERE id=?`)
      .run(body_text, file_path, audio_path, action, action, now, JSON.stringify(history), sub.id);
  } else {
    await db.prepare(`INSERT INTO submissions (assignment_id, user_id, body_text, file_path, audio_path, status, submitted_at, history_json)
      VALUES (?,?,?,?,?,?,?,?)`).run(a.id, req.user.id, body_text, file_path, audio_path, action,
        action === 'submitted' ? now : null, JSON.stringify(history));
  }
  if (action === 'submitted') {
    audit(req.user.id, 'assignment.submitted', `assignment=${a.id}`);
    // notify staff
    const staff = await db.prepare(`SELECT id FROM users WHERE role IN ('admin','teacher') AND status='active'`).all();
    staff.forEach(s => notify(s.id, 'submission', 'New submission', `${req.user.name} submitted "${a.title}".`));
  }
  req.setFlash('success', action === 'submitted' ? 'Assignment submitted.' : 'Draft saved.');
  res.redirect('/assignments/' + a.id);
});

// ---- quizzes ------------------------------------------------------------------------
router.get('/quiz/:id', async (req, res) => {
  const quiz = await db.prepare(`SELECT q.*, c.title AS course_title FROM quizzes q JOIN courses c ON c.id=q.course_id WHERE q.id=?`)
    .get(req.params.id);
  if (!quiz || !await enrolledCourseOr404(req, quiz.course_id)) return res.status(404).render('errors/404', { title: 'Quiz not found' });
  const now = new Date();
  if (quiz.available_from && new Date(quiz.available_from) > now) { req.setFlash('error', 'This quiz is not available yet.'); return res.redirect('/dashboard'); }
  if (quiz.available_until && new Date(quiz.available_until) < now) { req.setFlash('error', 'This quiz is no longer available.'); return res.redirect('/dashboard'); }
  const used = (await db.prepare(`SELECT COUNT(*) c FROM attempts WHERE quiz_id=? AND user_id=? AND status IN ('submitted','graded','needs_grading')`)
    .get(quiz.id, req.user.id)).c;
  if (used >= quiz.attempts_allowed) {
    const past = await db.prepare('SELECT * FROM attempts WHERE quiz_id=? AND user_id=? ORDER BY submitted_at DESC').all(quiz.id, req.user.id);
    return res.render('student/quiz-result', { title: quiz.title, quiz, attempts: past, blocked: true });
  }
  let questions = await db.prepare('SELECT * FROM questions WHERE quiz_id=?').all(quiz.id);
  if (quiz.randomize) questions = questions.sort(() => Math.random() - 0.5);
  const att = await db.prepare('INSERT INTO attempts (quiz_id, user_id, attempt_no) VALUES (?,?,?)')
    .run(quiz.id, req.user.id, used + 1);
  res.render('student/quiz-take', { title: quiz.title, quiz, questions, attemptId: att.lastInsertRowid });
});

async function gradeAttempt(quizId, answers) {
  const questions = await db.prepare('SELECT * FROM questions WHERE quiz_id=?').all(quizId);
  let score = 0, max = 0, needsGrading = false;
  const detail = [];
  for (const q of questions) {
    max += Number(q.points);
    const given = answers['q' + q.id];
    const correct = JSON.parse(q.correct_json);
    let earned = 0, auto = true;
    if (q.qtype === 'multiple_choice' || q.qtype === 'true_false') {
      earned = String(given || '') === String(correct) ? Number(q.points) : 0;
    } else if (q.qtype === 'multiple_select') {
      const g = Array.isArray(given) ? given.map(String).sort() : [];
      const c = (Array.isArray(correct) ? correct : []).map(String).sort();
      earned = JSON.stringify(g) === JSON.stringify(c) ? Number(q.points) : 0;
    } else if (q.qtype === 'fill_blank') {
      const acceptable = Array.isArray(correct) ? correct : [correct];
      earned = acceptable.some(a => String(given || '').trim().toLowerCase() === String(a).trim().toLowerCase()) ? Number(q.points) : 0;
    } else {
      auto = false; needsGrading = true;
    }
    score += earned;
    detail.push({ question_id: q.id, earned, max: Number(q.points), auto });
  }
  return { score, max_score: max, needsGrading, detail };
}

router.post('/quiz/:id/submit', async (req, res) => {
  const quiz = await db.prepare('SELECT * FROM quizzes WHERE id=?').get(req.params.id);
  if (!quiz || !await enrolledCourseOr404(req, quiz.course_id)) return res.status(404).render('errors/404', { title: 'Quiz not found' });
  const attemptId = Number(req.body.attempt_id);
  const attempt = await db.prepare('SELECT * FROM attempts WHERE id=? AND user_id=? AND status=\'in_progress\'').get(attemptId, req.user.id);
  if (!attempt || attempt.quiz_id !== quiz.id) return res.status(403).render('errors/403', { title: 'Invalid attempt' });
  const answers = req.body.answers || {};
  const { score, max_score, needsGrading } = await gradeAttempt(quiz.id, answers);
  const status = needsGrading ? 'needs_grading' : 'graded';
  await db.prepare(`UPDATE attempts SET answers_json=?, score=?, max_score=?, status=?, submitted_at=datetime('now') WHERE id=?`)
    .run(JSON.stringify(answers), score, max_score, status, attemptId);
  audit(req.user.id, 'quiz.submitted', `quiz=${quiz.id} score=${score}/${max_score}`);
  if (needsGrading) {
    const staff = await db.prepare(`SELECT id FROM users WHERE role IN ('admin','teacher') AND status='active'`).all();
    staff.forEach(s => notify(s.id, 'grading', 'Quiz needs grading', `${req.user.name} submitted "${quiz.title}" with open-ended answers.`));
  }
  res.redirect(`/quiz/${quiz.id}/result/${attemptId}`);
});

router.get('/quiz/:id/result/:attemptId', async (req, res) => {
  const quiz = await db.prepare('SELECT * FROM quizzes WHERE id=?').get(req.params.id);
  const attempt = await db.prepare('SELECT * FROM attempts WHERE id=?').get(req.params.attemptId);
  if (!quiz || !attempt || attempt.quiz_id !== quiz.id) return res.status(404).render('errors/404', { title: 'Not found' });
  if (!ownsOrStaff(req, attempt.user_id)) return res.status(403).render('errors/403', { title: 'Forbidden' });
  const questions = await db.prepare('SELECT * FROM questions WHERE quiz_id=?').all(quiz.id);
  const answers = JSON.parse(attempt.answers_json || '{}');
  res.render('student/quiz-result', { title: quiz.title + ' — Result', quiz, attempt, questions, answers, blocked: false });
});

// ---- grades ---------------------------------------------------------------------------
router.get('/grades', async (req, res) => {
  const enrollments = await db.prepare(`SELECT e.*, c.title, c.slug FROM enrollments e
    JOIN courses c ON c.id=e.course_id WHERE e.user_id=? ORDER BY c.title`).all(req.user.id);
  const books = await Promise.all(enrollments.map(async e => ({ enrollment: e, book: await computeGradebook(e.course_id, req.user.id) })));
  res.render('student/grades', { title: 'My Grades', books });
});

// ---- certificates -----------------------------------------------------------------------
router.get('/certificates', async (req, res) => {
  const certs = await db.prepare(`SELECT c.*, co.title AS course_title, co.level AS course_level
    FROM certificates c JOIN courses co ON co.id=c.course_id
    WHERE c.user_id=? ORDER BY c.issued_at DESC`).all(req.user.id);
  res.render('student/certificates', { title: 'My Certificates', certs });
});

router.get('/certificates/:id/download', async (req, res) => {
  const cert = await db.prepare('SELECT * FROM certificates WHERE id=?').get(req.params.id);
  if (!cert || !ownsOrStaff(req, cert.user_id)) return res.status(404).render('errors/404', { title: 'Certificate not found' });
  if (storage.backend() === 'supabase') {
    const url = await storage.getSignedUrl(cert.pdf_path, 300);
    return res.redirect(url);
  }
  const abs = path.join(__dirname, '..', cert.pdf_path);
  if (!fs.existsSync(abs)) return res.status(404).render('errors/404', { title: 'PDF not found' });
  res.download(abs, `certificate-${cert.code}.pdf`);
});

// ---- profile ------------------------------------------------------------------------------
router.get('/profile', async (req, res) => {
  res.render('student/profile', { title: 'My Profile' });
});

router.post('/profile', async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 120);
  const lang = ['en', 'es'].includes(req.body.preferred_lang) ? req.body.preferred_lang : 'en';
  if (!name) { req.setFlash('error', 'Name cannot be empty.'); return res.redirect('/profile'); }
  await db.prepare('UPDATE users SET name=?, preferred_lang=? WHERE id=?').run(name, lang, req.user.id);
  audit(req.user.id, 'profile.updated', '');
  req.setFlash('success', 'Profile updated.');
  res.redirect('/profile');
});

// ---- notifications --------------------------------------------------------------------------
router.get('/notifications', async (req, res) => {
  const notes = await db.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 50').all(req.user.id);
  await db.prepare('UPDATE notifications SET read=1 WHERE user_id=?').run(req.user.id);
  res.render('student/notifications', { title: 'Notifications', notes });
});

// ---- messages ---------------------------------------------------------------------------------
router.get('/messages', async (req, res) => {
  const staff = await db.prepare(`SELECT id, name, role FROM users WHERE role IN ('admin','teacher') AND status='active' ORDER BY name`).all();
  const withId = req.query.with ? Number(req.query.with) : null;
  let thread = [];
  if (withId) {
    const other = await db.prepare('SELECT id FROM users WHERE id=?').get(withId);
    if (other) {
      thread = await db.prepare(`SELECT m.*, u.name AS from_name FROM messages m JOIN users u ON u.id=m.from_user_id
        WHERE (m.from_user_id=? AND m.to_user_id=?) OR (m.from_user_id=? AND m.to_user_id=?)
        ORDER BY m.created_at`).all(req.user.id, withId, withId, req.user.id);
      await db.prepare('UPDATE messages SET read=1 WHERE to_user_id=? AND from_user_id=?').run(req.user.id, withId);
    }
  }
  // conversations list
  const convos = await db.prepare(`SELECT u.id, u.name,
      (SELECT body FROM messages m WHERE (m.from_user_id=u.id AND m.to_user_id=?) OR (m.from_user_id=? AND m.to_user_id=u.id) ORDER BY created_at DESC LIMIT 1) AS last_body,
      (SELECT COUNT(*) FROM messages m WHERE m.from_user_id=u.id AND m.to_user_id=? AND m.read=0) AS unread
    FROM users u WHERE u.id IN (SELECT DISTINCT CASE WHEN from_user_id=? THEN to_user_id ELSE from_user_id END FROM messages WHERE from_user_id=? OR to_user_id=?)
    ORDER BY u.name`).all(req.user.id, req.user.id, req.user.id, req.user.id, req.user.id, req.user.id);
  res.render('student/messages', { title: 'Messages', staff, convos, thread, withId });
});

router.post('/messages', async (req, res) => {
  const toId = Number(req.body.to_user_id);
  const body = String(req.body.body || '').trim().slice(0, 5000);
  const other = await db.prepare(`SELECT id FROM users WHERE id=? AND role IN ('admin','teacher','ta') AND status='active'`).get(toId);
  if (!other || !body) { req.setFlash('error', 'Message could not be sent.'); return res.redirect('/messages'); }
  await db.prepare('INSERT INTO messages (from_user_id, to_user_id, body) VALUES (?,?,?)').run(req.user.id, toId, body);
  notify(toId, 'message', 'New message', `${req.user.name} sent you a message.`);
  audit(req.user.id, 'message.sent', `to=${toId}`);
  res.redirect('/messages?with=' + toId);
});

// ---- live class sessions (student view) -----------------------------------------
router.get('/sessions', async (req, res) => {
  const enrollments = await db.prepare(`SELECT course_id FROM enrollments WHERE user_id=? AND status IN ('active','completed')`).all(req.user.id);
  const courseIds = enrollments.map(e => e.course_id);
  let upcoming = [], past = [];
  if (courseIds.length) {
    const ph = courseIds.map(() => '?').join(',');
    const rows = await db.prepare(`SELECT s.*, c.title AS course_title,
        (SELECT a.status FROM attendance a WHERE a.session_id=s.id AND a.user_id=?) AS my_mark
      FROM live_sessions s JOIN courses c ON c.id=s.course_id
      WHERE s.course_id IN (${ph}) AND s.status != 'cancelled'
      ORDER BY s.starts_at DESC LIMIT 60`).all(req.user.id, ...courseIds);
    const nowMs = Date.now();
    for (const r of rows) {
      const { end } = sessionTimes(r);
      ((end && end.getTime() >= nowMs && r.status === 'scheduled') ? upcoming : past).push(r);
    }
    upcoming.reverse();
  }
  res.render('student/sessions', { title: 'Live Class Sessions', upcoming, past,
    sessionDisplayTime, canJoinSession, now: new Date() });
});

// ---- calendar (student): sessions + quiz windows + assignment due dates ----------
router.get('/calendar', async (req, res) => {
  const now = new Date();
  const year = Math.min(2100, Math.max(2000, parseInt(req.query.year || now.getUTCFullYear(), 10) || now.getUTCFullYear()));
  const month = Math.min(12, Math.max(1, parseInt(req.query.month || (now.getUTCMonth() + 1), 10) || (now.getUTCMonth() + 1)));
  const view = req.query.view === 'agenda' ? 'agenda' : 'month';
  const enrollments = await db.prepare(`SELECT course_id FROM enrollments WHERE user_id=? AND status IN ('active','completed')`).all(req.user.id);
  const events = await getCalendarEvents(year, month, enrollments.map(e => e.course_id));
  const weeks = buildMonthGrid(year, month, events);
  const monthName = new Date(Date.UTC(year, month - 1, 1)).toLocaleString('en-US', { month: 'long', year: 'numeric' });
  const prev = month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
  const next = month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
  res.render('student/calendar', { title: 'My Calendar', weeks, events, year, month, monthName, view, prev, next });
});

module.exports = router;
