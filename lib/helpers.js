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

// Email via nodemailer + the SMTP settings in site settings (Phase 2).
// Until SMTP is configured, log to console and rely on in-app notifications.
// NEVER claim an email was delivered when it was not: every caller must check
// the returned { sent } flag and word its UI honestly.
let _transporter = null;
async function emailTransport() {
  const host = (await getSetting('smtp_host', '')).trim();
  if (!host) return null;
  // Rebuild when settings change (cheap: only on config change).
  const key = [host, await getSetting('smtp_port', ''), await getSetting('smtp_user', ''),
    await getSetting('smtp_pass', ''), await getSetting('smtp_from', '')].join('|');
  if (!_transporter || _transporter._cfgKey !== key) {
    const nodemailer = require('nodemailer');
    const port = parseInt(await getSetting('smtp_port', '587'), 10) || 587;
    const user = (await getSetting('smtp_user', '')).trim();
    const pass = await getSetting('smtp_pass', '');
    _transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465, // implicit TLS only on 465; otherwise STARTTLS
      auth: user ? { user, pass } : undefined,
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
    });
    _transporter._cfgKey = key;
  }
  return _transporter;
}

async function emailConfigured() {
  return !!((await getSetting('smtp_host', '')).trim());
}

async function sendEmail(to, subject, text) {
  const transport = await emailTransport();
  if (!transport) {
    console.log(`[email:NOT-CONFIGURED] to=${to} subject=${subject}\n${text}`);
    return { sent: false, reason: 'SMTP not configured -- logged to console; in-app notification used instead' };
  }
  const from = (await getSetting('smtp_from', '')).trim()
    || `${await getSetting('site_name', 'Beyond Borders English Academy')} <no-reply@localhost>`;
  try {
    await transport.sendMail({ from, to, subject, text });
    return { sent: true };
  } catch (e) {
    console.error(`[email:FAILED] to=${to} subject=${subject} error=${e.message}`);
    return { sent: false, reason: `Email failed: ${e.message}` };
  }
}

// Test hook: reset the cached transporter (used by tests after changing settings).
function _resetEmailTransport() { _transporter = null; }

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

module.exports = { audit, notify, sendEmail, emailConfigured, _resetEmailTransport,
  randomToken, certCode, esc, fmtDate, fmtDateTime,
  computeGradebook, updateProgress, courseLessons,
  zonedTimeToUtc, utcToZonedText, zonedDateTimeParts, toDbTs, parseDbTs, sessionTimes, canJoinSession, sessionDisplayTime,
  getCalendarEvents, buildMonthGrid, attendanceSummary, runSessionReminders };

// ---------------------------------------------------------------- Phase 2 ---
// Timezones: session wall-clock times are converted to UTC for storage with
// the Intl API (no extra dependency). Display converts back to the session's
// own timezone and labels it, so everyone sees the same moment.

// Offset of `tz` (ms) at the given instant.
function tzOffsetMs(tz, date) {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const parts = Object.fromEntries(dtf.formatToParts(date).map(p => [p.type, p.value]));
    const asUTC = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour) % 24, Number(parts.minute), Number(parts.second));
    return asUTC - date.getTime();
  } catch (e) { return 0; } // unknown zone -> treat as UTC
}

// "2026-11-02" + "14:30" in tz -> Date (UTC instant).
function zonedTimeToUtc(dateStr, timeStr, tz) {
  const [Y, M, D] = String(dateStr).split('-').map(Number);
  const [h, mi] = String(timeStr).split(':').map(Number);
  if (![Y, M, D, h, mi].every(Number.isFinite)) return null;
  const guess = new Date(Date.UTC(Y, M - 1, D, h, mi || 0));
  return new Date(guess.getTime() - tzOffsetMs(tz || 'UTC', guess));
}

function toDbTs(date) {
  const p = n => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}-${p(date.getUTCMonth() + 1)}-${p(date.getUTCDate())} ${p(date.getUTCHours())}:${p(date.getUTCMinutes())}:${p(date.getUTCSeconds())}`;
}

// UTC 'YYYY-MM-DD HH:MM:SS' -> Date.
function parseDbTs(ts) {
  if (!ts) return null;
  const d = new Date(ts.length <= 10 ? ts + 'T12:00:00Z' : ts.replace(' ', 'T') + 'Z');
  return isNaN(d) ? null : d;
}

// UTC 'YYYY-MM-DD HH24:MI:SS' -> { date:'YYYY-MM-DD', time:'HH:MM' } wall-clock
// parts in tz (for pre-filling edit forms).
function zonedDateTimeParts(utcText, tz) {
  const d = parseDbTs(utcText);
  if (!d) return { date: '', time: '' };
  try {
    const dtf = new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    const parts = Object.fromEntries(dtf.formatToParts(d).map(p => [p.type, p.value]));
    const hh = parts.hour === '24' ? '00' : parts.hour;
    return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${hh}:${parts.minute}` };
  } catch (e) { return { date: '', time: '' }; }
}

// UTC timestamp text -> readable text in the session's timezone, labeled.
function utcToZonedText(utcText, tz) {
  const d = parseDbTs(utcText);
  if (!d) return String(utcText || '—');
  try {
    return d.toLocaleString('en-US', { timeZone: tz || 'UTC', year: 'numeric', month: 'short',
      day: 'numeric', hour: 'numeric', minute: '2-digit' });
  } catch (e) { return d.toUTCString(); }
}

function sessionTimes(session) {
  const start = parseDbTs(session.starts_at);
  const end = start ? new Date(start.getTime() + (Number(session.duration_min) || 60) * 60000) : null;
  return { start, end };
}

// Join button: visible from 15 min before start until the session ends,
// only for scheduled sessions with a meeting URL.
function canJoinSession(session, now = new Date()) {
  if (!session || session.status !== 'scheduled' || !session.meeting_url) return false;
  const { start, end } = sessionTimes(session);
  if (!start || !end) return false;
  return now.getTime() >= start.getTime() - 15 * 60000 && now.getTime() <= end.getTime();
}

function sessionDisplayTime(session) {
  return utcToZonedText(session.starts_at, session.timezone) + ` (${session.timezone || 'UTC'})`;
}

// ---- calendar ---------------------------------------------------------------
// Events for a month: live sessions + quiz windows/due dates + assignment
// due dates. courseIds: null = all courses, [] = none.
async function getCalendarEvents(year, month, courseIds) {
  const pad = n => String(n).padStart(2, '0');
  const from = `${year}-${pad(month)}-01 00:00:00`;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const to = `${year}-${pad(month)}-${lastDay} 23:59:59`;
  const courseCond = courseIds === null ? '' : (courseIds.length
    ? `AND course_id IN (${courseIds.map(() => '?').join(',')})` : 'AND 1=0');
  const cp = courseIds === null ? [] : courseIds;
  const events = [];

  const sessions = await db.prepare(`SELECT s.*, c.title AS course_title FROM live_sessions s
    JOIN courses c ON c.id=s.course_id
    WHERE s.status != 'cancelled' AND s.starts_at >= ? AND s.starts_at <= ? ${courseCond}
    ORDER BY s.starts_at`).all(from, to, ...cp);
  for (const s of sessions) {
    events.push({ date: s.starts_at.slice(0, 10), time: utcToZonedText(s.starts_at, s.timezone),
      title: s.title, kind: 'session', course: s.course_title, url: null, id: s.id });
  }
  const quizzes = await db.prepare(`SELECT q.*, c.title AS course_title FROM quizzes q
    JOIN courses c ON c.id=q.course_id
    WHERE ((q.due_at >= ? AND q.due_at <= ?) OR (q.available_from >= ? AND q.available_from <= ?)
       OR (q.available_until >= ? AND q.available_until <= ?)) ${courseCond}`).all(from, to, from, to, from, to, ...cp);
  for (const q of quizzes) {
    if (q.due_at && q.due_at >= from && q.due_at <= to)
      events.push({ date: q.due_at.slice(0, 10), time: '', title: q.title + ' (due)', kind: 'quiz', course: q.course_title, url: null, id: q.id });
    if (q.available_from && q.available_from >= from && q.available_from <= to)
      events.push({ date: q.available_from.slice(0, 10), time: '', title: q.title + ' (opens)', kind: 'quiz', course: q.course_title, url: null, id: q.id });
  }
  const assigns = await db.prepare(`SELECT a.*, c.title AS course_title FROM assignments a
    JOIN courses c ON c.id=a.course_id
    WHERE a.due_at >= ? AND a.due_at <= ? ${courseCond}`).all(from, to, ...cp);
  for (const a of assigns) {
    events.push({ date: a.due_at.slice(0, 10), time: '', title: a.title + ' (due)', kind: 'assignment', course: a.course_title, url: null, id: a.id });
  }
  events.sort((x, y) => (x.date + x.time).localeCompare(y.date + y.time));
  return events;
}

// Weeks (arrays of 7 day-cells) for a month grid; each cell {date, inMonth, events}.
function buildMonthGrid(year, month, events) {
  const byDate = {};
  for (const e of events) { (byDate[e.date] = byDate[e.date] || []).push(e); }
  const first = new Date(Date.UTC(year, month - 1, 1));
  const startOffset = first.getUTCDay(); // 0 = Sunday
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const pad = n => String(n).padStart(2, '0');
  const cells = [];
  for (let i = 0; i < startOffset; i++) cells.push({ date: null, inMonth: false, events: [] });
  for (let d = 1; d <= daysInMonth; d++) {
    const ds = `${year}-${pad(month)}-${pad(d)}`;
    cells.push({ date: ds, day: d, inMonth: true, events: byDate[ds] || [] });
  }
  while (cells.length % 7) cells.push({ date: null, inMonth: false, events: [] });
  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

// ---- attendance ---------------------------------------------------------------
async function attendanceSummary(courseId) {
  // Per-student attendance across scheduled+completed sessions of the course.
  const sessions = await db.prepare(`SELECT id FROM live_sessions WHERE course_id=? AND status IN ('scheduled','completed')`).all(courseId);
  const students = await db.prepare(`SELECT u.id, u.name, u.email FROM enrollments e
    JOIN users u ON u.id=e.user_id WHERE e.course_id=? AND e.status IN ('active','completed') ORDER BY u.name`).all(courseId);
  const marks = await db.prepare(`SELECT a.user_id, a.status FROM attendance a
    JOIN live_sessions s ON s.id=a.session_id WHERE s.course_id=?`).all(courseId);
  const byUser = {};
  for (const m of marks) { (byUser[m.user_id] = byUser[m.user_id] || []).push(m.status); }
  const total = sessions.length;
  return students.map(s => {
    const st = byUser[s.id] || [];
    const present = st.filter(x => x === 'present' || x === 'late').length;
    const excused = st.filter(x => x === 'excused').length;
    const pct = total ? Math.round((present / total) * 1000) / 10 : null;
    return { ...s, total, present, late: st.filter(x => x === 'late').length,
      absent: st.filter(x => x === 'absent').length, excused, pct };
  });
}

// ---- session reminders + auto-complete (in-process scheduler) -------------------
// Finds sessions starting within the next 24h that haven't been reminded yet,
// emails + notifies enrolled students, and marks them reminded. Also flips
// past sessions to 'completed'. Safe to run every few minutes; idempotent.
async function runSessionReminders(now = new Date()) {
  const out = { reminded: 0, completed: 0, errors: [] };
  const nowTs = toDbTs(now);
  const soonTs = toDbTs(new Date(now.getTime() + 24 * 3600 * 1000));
  try {
    const due = await db.prepare(`SELECT s.*, c.title AS course_title FROM live_sessions s
      JOIN courses c ON c.id=s.course_id
      WHERE s.status='scheduled' AND s.reminder_sent_at IS NULL
        AND s.starts_at > ? AND s.starts_at <= ?`).all(nowTs, soonTs);
    for (const s of due) {
      const students = await db.prepare(`SELECT u.id, u.name, u.email FROM enrollments e
        JOIN users u ON u.id=e.user_id
        WHERE e.course_id=? AND e.status='active' AND u.status='active' AND u.role='student'`).all(s.course_id);
      const when = sessionDisplayTime(s);
      for (const st of students) {
        notify(st.id, 'session', 'Live class tomorrow', `"${s.title}" (${s.course_title}) is on ${when}.`);
        const r = await sendEmail(st.email, `Reminder: live class "${s.title}" tomorrow`,
          `Hi ${st.name},\n\nThis is a reminder that your live class "${s.title}" (${s.course_title}) starts on ${when}.\n\n` +
          (s.meeting_url ? `Join here: ${s.meeting_url}\n\n` : '') +
          `— ${await getSetting('site_name', 'Beyond Borders English Academy')}`);
        if (!r.sent) out.errors.push(`session ${s.id} -> ${st.email}: ${r.reason}`);
      }
      await db.prepare('UPDATE live_sessions SET reminder_sent_at=? WHERE id=?').run(nowTs, s.id);
      out.reminded++;
      await audit(null, 'session.reminded', `session=${s.id} students=${students.length}`);
    }
    const done = await db.prepare(`SELECT id, starts_at, duration_min FROM live_sessions WHERE status='scheduled'`).all();
    for (const s of done) {
      const { end } = sessionTimes(s);
      if (end && end.getTime() < now.getTime()) {
        await db.prepare(`UPDATE live_sessions SET status='completed' WHERE id=?`).run(s.id);
        out.completed++;
      }
    }
  } catch (e) {
    out.errors.push('worker: ' + e.message);
    console.error('[reminders] failed:', e.message);
  }
  return out;
}
