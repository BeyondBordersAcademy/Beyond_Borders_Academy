// Authentication + authorization middleware.
// Sessions are server-side (Postgres store via connect-pg-simple). Permissions are enforced
// here on every protected route -- never rely on hidden UI buttons.
//
// Roles (Phase 2):
//   admin   - everything, including site settings and user management.
//   teacher - full control of ASSIGNED courses (content, grading, sessions,
//             attendance); no site settings, no user admin, no other courses.
//   ta      - grading + attendance + messaging for ASSIGNED courses only;
//             no content editing, no settings, no user admin.
//   student - own learning data only.
const { db } = require('./db');

async function currentUser(req) {
  if (!req.session || !req.session.userId) return null;
  const u = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!u || u.status === 'suspended') return null;
  return u;
}

async function attachUser(req, res, next) {
  try {
    req.user = await currentUser(req);
  } catch (e) {
    return next(e);
  }
  res.locals.user = req.user;
  // Any staff member (used for the staff-portal nav link).
  res.locals.isAdmin = !!(req.user && ['admin', 'teacher', 'ta'].includes(req.user.role));
  next();
}

function requireLogin(req, res, next) {
  if (!req.user) {
    req.session.returnTo = req.originalUrl;
    return res.redirect('/login');
  }
  next();
}

function requireRole(...roles) {
  return async (req, res, next) => {
    if (!req.user) {
      req.session.returnTo = req.originalUrl;
      return res.redirect('/login');
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).render('errors/403', { title: 'Forbidden' });
    }
    next();
  };
}

// Any staff member: admin, teacher, or TA (whole staff portal gate).
const requireStaff = requireRole('admin', 'teacher', 'ta');
// Content editors: admin + teacher. TAs may grade and mark attendance but
// must never create/edit/delete course content.
const requireContent = requireRole('admin', 'teacher');
// Admin only (site settings, user management, destructive config).
const requireAdmin = requireRole('admin');

function requireStudent(req, res, next) {
  if (!req.user) {
    req.session.returnTo = req.originalUrl;
    return res.redirect('/login');
  }
  if (req.user.role !== 'student') {
    return res.status(403).render('errors/403', { title: 'Forbidden' });
  }
  next();
}

// Ownership guard: students may only touch their own user-scoped records.
function ownsOrStaff(req, userId) {
  if (!req.user) return false;
  if (['admin', 'teacher', 'ta'].includes(req.user.role)) return true;
  return Number(req.user.id) === Number(userId);
}

// ---- course-scoped staff access -------------------------------------------
// Teachers and TAs only see and touch courses explicitly assigned to them in
// staff_courses. Admins bypass the check.

async function staffCourseIds(userId) {
  const rows = await db.prepare('SELECT course_id FROM staff_courses WHERE user_id=?').all(userId);
  return rows.map(r => r.course_id);
}

async function canAccessCourse(user, courseId) {
  if (!user || !courseId) return false;
  if (user.role === 'admin') return true;
  if (user.role !== 'teacher' && user.role !== 'ta') return false;
  const row = await db.prepare('SELECT 1 FROM staff_courses WHERE user_id=? AND course_id=?')
    .get(user.id, Number(courseId));
  return !!row;
}

async function assignCourse(userId, courseId) {
  await db.prepare('INSERT INTO staff_courses (user_id, course_id) VALUES (?,?) ON CONFLICT (user_id, course_id) DO NOTHING')
    .run(userId, courseId);
}

async function unassignCourse(userId, courseId) {
  await db.prepare('DELETE FROM staff_courses WHERE user_id=? AND course_id=?').run(userId, courseId);
}

// Middleware factory: resolveCourseId(req) may be sync or async and must
// return the course id the route operates on (or null). Non-admin staff
// without an assignment get 403; missing course gets 404.
function requireCourseAccess(resolveCourseId) {
  return async (req, res, next) => {
    let courseId = null;
    try {
      courseId = await resolveCourseId(req);
    } catch (e) { return next(e); }
    courseId = Number(courseId);
    if (!courseId) return res.status(404).render('errors/404', { title: 'Course not found' });
    const course = await db.prepare('SELECT * FROM courses WHERE id=?').get(courseId);
    if (!course) return res.status(404).render('errors/404', { title: 'Course not found' });
    if (!await canAccessCourse(req.user, courseId)) {
      return res.status(403).render('errors/403', { title: 'Forbidden' });
    }
    req.courseId = courseId;
    req.course = course;
    next();
  };
}

// For list pages: returns null for admins (no filter) or an array of assigned
// course ids for teachers/TAs. Callers add `WHERE course_id IN (...)` when
// the return is an array.
async function courseFilter(user) {
  if (!user) return [];
  if (user.role === 'admin') return null;
  return await staffCourseIds(user.id);
}

module.exports = { attachUser, requireLogin, requireRole, requireStaff, requireContent,
  requireAdmin, requireStudent, ownsOrStaff, currentUser,
  staffCourseIds, canAccessCourse, assignCourse, unassignCourse,
  requireCourseAccess, courseFilter };
