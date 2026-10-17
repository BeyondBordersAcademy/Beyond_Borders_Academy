// Authentication + authorization middleware.
// Sessions are server-side (Postgres store via connect-pg-simple). Permissions are enforced
// here on every protected route -- never rely on hidden UI buttons.
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
  res.locals.isAdmin = !!(req.user && (req.user.role === 'admin' || req.user.role === 'teacher'));
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

// Admin OR teacher (Phase 1: Charlie is admin; teacher role reserved for staff).
const requireStaff = requireRole('admin', 'teacher');
// Admin only (site settings, destructive config).
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
  if (req.user.role === 'admin' || req.user.role === 'teacher') return true;
  return Number(req.user.id) === Number(userId);
}

module.exports = { attachUser, requireLogin, requireRole, requireStaff, requireAdmin, requireStudent, ownsOrStaff, currentUser };
