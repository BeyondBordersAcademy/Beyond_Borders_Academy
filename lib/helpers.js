// Shared helpers: audit log, notifications, grading, misc.
const crypto = require('crypto');
const { db, getSetting } = require('./db');

async function audit(actorId, action, details = '') {
  try {
    await db.prepare('INSERT INTO audit_logs (actor_id, action, details) VALUES (?,?,?)')
      .run(actorId || null, action, String(details).slice(0, 4000));
  } catch (e) { console.error('[audit] failed:', e.message); }
}

async function notify(userId, kind, title, body = '') {
  try {
    await db.prepare('INSERT INTO notifications (user_id, kind, title, body) VALUES (?,?,?,?)')
      .run(userId, kind, title, body);
  } catch (e) { console.error('[notify] failed:', e.message); }
}

// Email: pluggable SMTP. Until configured, log to console (and rely on
// in-app notifications). Never claim an email was delivered when it was not.
async function sendEmail(to, subject, text) {
  const host = await getSetting('smtp_host', '');
  if (!host) {
    console.log(`[email:NOT-CONFIGURED] to=${to} subject=${subject}\n${text}`);
    return { sent: false, reason: 'SMTP not configured -- logged to console' };
  }
  // Phase 1: SMTP transport not bundled; log and report honestly.
  console.log(`[email:STUB] to=${to} subject=${subject} (SMTP host set but transport not bundled in Phase 1)`);
  return { sent: false, reason: 'Email transport not bundled in Phase 1; configure an email provider' };
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

function certCode() {
  // Human-readable unique code, e.g. BBEA-7F3K-9Q2D
  const part = () => crypto.randomBytes(2).toString('hex').toUpperCase();
  return `BBEA-${part()}-${part()}`;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso.length <= 10 ? iso + 'T12:00:00' : iso);
  return isNaN(d) ? String(iso) : d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d) ? String(iso) : d.toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// ---- grading ---------------------------------------------------------------
// Weighted gradebook: each assignment/quiz has a category + optional weight.
// Course grading_config_json may define e.g.
//   {"categories": {"assignments": 40, "quizzes": 30, "exams": 30}}
// Items without explicit weights share their category weight equally.
// Grade overrides (manual entries / corrections) are included.
async function computeGradebook(courseId, userId) {
  const cfg = await (async () => { try {
    return JSON.parse((await db.prepare('SELECT grading_config_json FROM courses WHERE id=?').get(courseId))?.grading_config_json || '{}');
  } catch { return {}; } })();
  const catWeights = (cfg && cfg.categories) || {};

  const assignments = await db.prepare('SELECT id, title, max_points, category, weight FROM assignments WHERE course_id=?').all(courseId);
  const quizzes = await db.prepare('SELECT id, title, category, weight FROM quizzes WHERE course_id=?').all(courseId);

  const items = [];
  for (const a of assignments) {
    const sub = await db.prepare(`SELECT grade, status FROM submissions
      WHERE assignment_id=? AND user_id=? ORDER BY updated_at DESC LIMIT 1`).get(a.id, userId);
    const max = Number(a.max_points) || 100;
    items.push({
      kind: 'assignment', id: a.id, title: a.title, category: a.category || 'assignments',
      weight: a.weight, earned: sub && sub.grade != null ? Number(sub.grade) : null,
      max, status: sub ? sub.status : 'not_submitted',
    });
  }
  for (const q of quizzes) {
    const att = await db.prepare(`SELECT score, max_score, status FROM attempts
      WHERE quiz_id=? AND user_id=? AND status IN ('submitted','graded','needs_grading')
      ORDER BY submitted_at DESC LIMIT 1`).get(q.id, userId);
    const max = att && att.max_score != null ? Number(att.max_score)
      : Number((await db.prepare('SELECT COALESCE(SUM(points),0) AS total FROM questions WHERE quiz_id=?').get(q.id)).total) || 1;
    items.push({
      kind: 'quiz', id: q.id, title: q.title, category: q.category || 'quizzes',
      weight: q.weight, earned: att && att.score != null ? Number(att.score) : null,
      max, status: att ? att.status : 'not_attempted',
    });
  }
  const overrides = await db.prepare('SELECT * FROM grade_overrides WHERE course_id=? AND user_id=?').all(courseId, userId);
  for (const o of overrides) {
    items.push({ kind: 'override', id: o.id, title: o.note || 'Manual grade entry',
      category: 'manual', weight: null, earned: Number(o.points), max: Number(o.max_points), status: 'graded' });
  }

  // Aggregate by category
  const cats = {};
  for (const it of items) {
    const c = it.category || 'uncategorized';
    cats[c] = cats[c] || { items: [], weight: catWeights[c] };
    cats[c].items.push(it);
  }
  let totalPct = 0, totalWeightUsed = 0, gradedCount = 0;
  const catResults = {};
  for (const [c, g] of Object.entries(cats)) {
    const graded = g.items.filter(i => i.earned != null);
    let catPct = null;
    if (graded.length) {
      // Per-item weights within category, else equal share
      const wsum = graded.reduce((s, i) => s + (Number(i.weight) > 0 ? Number(i.weight) : 1), 0);
      catPct = graded.reduce((s, i) =>
        s + (i.earned / i.max) * ((Number(i.weight) > 0 ? Number(i.weight) : 1) / wsum), 0) * 100;
    }
    catResults[c] = { pct: catPct, items: g.items, weight: g.weight };
    if (catPct != null && Number(g.weight) > 0) {
      totalPct += catPct * (Number(g.weight) / 100);
      totalWeightUsed += Number(g.weight);
    }
    if (catPct != null) gradedCount += graded.length;
  }
  // If no category weights configured, simple average of graded items
  let overall = null;
  if (totalWeightUsed > 0) overall = totalPct;
  else {
    const graded = items.filter(i => i.earned != null);
    if (graded.length) overall = graded.reduce((s, i) => s + (i.earned / i.max) * 100, 0) / graded.length;
  }
  const missing = items.filter(i => i.earned == null).length;
  return { items, categories: catResults, overall: overall != null ? Math.round(overall * 10) / 10 : null,
           gradedCount, missingCount: missing, totalCount: items.length };
}

// Course progress: % of published lessons marked complete.
async function updateProgress(userId, courseId) {
  const total = (await db.prepare(`SELECT COUNT(*) c FROM lessons l
    JOIN units u ON u.id = l.unit_id WHERE u.course_id=? AND l.status='published'`).get(courseId)).c;
  if (!total) { await db.prepare('UPDATE enrollments SET progress_pct=0 WHERE user_id=? AND course_id=?').run(userId, courseId); return 0; }
  const done = (await db.prepare(`SELECT COUNT(*) c FROM lesson_progress lp
    JOIN lessons l ON l.id=lp.lesson_id JOIN units u ON u.id=l.unit_id
    WHERE lp.user_id=? AND u.course_id=? AND lp.completed=1`).get(userId, courseId)).c;
  const pct = Math.round((done / total) * 1000) / 10;
  await db.prepare('UPDATE enrollments SET progress_pct=? WHERE user_id=? AND course_id=?').run(pct, userId, courseId);
  return pct;
}

// Ordered lesson list for a course (for resume / next-lesson logic).
async function courseLessons(courseId) {
  return await db.prepare(`SELECT l.id, l.title, u.id AS unit_id, u.title AS unit_title
    FROM lessons l JOIN units u ON u.id=l.unit_id
    WHERE u.course_id=? AND l.status='published'
    ORDER BY u.position, l.position, l.id`).all(courseId);
}

module.exports = { audit, notify, sendEmail, randomToken, certCode, esc, fmtDate, fmtDateTime,
  computeGradebook, updateProgress, courseLessons };
