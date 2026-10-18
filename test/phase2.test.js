// Phase 2 tests: migrations, role/course authorization, live sessions,
// attendance, calendar, email honesty, and HTTP integration proofs that a TA
// cannot reach admin-only routes and a teacher cannot touch unassigned courses.
// Needs Postgres on 127.0.0.1:55433 (trust auth, user postgres) -- uses a
// scratch database `phase2test`, never touches production/Supabase.
// Run: node test/phase2.test.js
const assert = require('assert');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

function fakeReq(user, params = {}, query = {}, body = {}) {
  return { user, params, query, body, session: {}, originalUrl: '/x-test', get: () => 'test' };
}
function fakeRes() {
  const r = { statusCode: 200, rendered: null, redirected: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.render = (v) => { r.rendered = v; return r; };
  r.redirect = (u) => { r.redirected = u; return r; };
  return r;
}
const nextCalled = () => { let c = false; const n = () => { c = true; }; n.wasCalled = () => c; return n; };

async function main() {
  // --- scratch database ------------------------------------------------------
  const adminPool = new Pool({ host: '127.0.0.1', port: 55433, user: 'postgres', database: 'postgres' });
  await adminPool.query('DROP DATABASE IF EXISTS phase2test');
  await adminPool.query('CREATE DATABASE phase2test');
  await adminPool.end();

  process.env.DATABASE_URL = 'postgres://postgres@127.0.0.1:55433/phase2test?sslmode=disable';
  process.env.SESSION_SECRET = 'phase2-test-secret';

  const { createLayer } = require('../lib/db');
  const pool = new Pool({ host: '127.0.0.1', port: 55433, user: 'postgres', database: 'phase2test' });
  const layer = createLayer(pool);
  await layer.ready; // migrations + seed
  const { db, getSetting, setSetting } = layer;
  console.log('[test] migrations + seed OK');

  const tables = (await db.prepare(
    `SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename IN ('live_sessions','attendance','staff_courses')`).all())
    .map(r => r.tablename).sort();
  assert.deepStrictEqual(tables, ['attendance', 'live_sessions', 'staff_courses'], 'phase 2 tables exist');
  console.log('[test] phase-2 tables OK:', tables.join(','));

  const { requireAdmin, requireContent, requireStaff, requireCourseAccess, canAccessCourse,
    assignCourse, staffCourseIds } = require('../lib/auth');
  const H = require('../lib/helpers');

  // --- fixtures: teacher, ta, student, two courses -----------------------------
  const hash = bcrypt.hashSync('password123', 4);
  const mk = async (name, email, role) =>
    (await db.prepare(`INSERT INTO users (name, email, password_hash, role, status) VALUES (?,?,?,?,?)`)
      .run(name, email, hash, role, 'active')).lastInsertRowid;
  const teacherId = await mk('Tina Teacher', 'teacher2@test.com', 'teacher');
  const taId = await mk('Tom TA', 'ta2@test.com', 'ta');
  const studentId = await mk('Sam Student', 'student2@test.com', 'student');
  const adminRow = await db.prepare(`SELECT * FROM users WHERE email='admin@beyondborders.academy'`).get();
  assert.ok(adminRow, 'seed admin exists');

  const courseA = (await db.prepare(`INSERT INTO courses (title, slug, status) VALUES (?,?,?)`)
    .run('Course A', 'course-a-p2', 'published')).lastInsertRowid;
  const courseB = (await db.prepare(`INSERT INTO courses (title, slug, status) VALUES (?,?,?)`)
    .run('Course B', 'course-b-p2', 'published')).lastInsertRowid;
  await db.prepare('INSERT INTO enrollments (user_id, course_id) VALUES (?,?)').run(studentId, courseA);
  await assignCourse(teacherId, courseA);
  await assignCourse(taId, courseA);
  assert.deepStrictEqual(await staffCourseIds(teacherId), [courseA]);
  console.log('[test] fixtures OK');

  const admin = { id: adminRow.id, role: 'admin' };
  const teacher = { id: teacherId, role: 'teacher' };
  const ta = { id: taId, role: 'ta' };
  const student = { id: studentId, role: 'student' };

  // --- canAccessCourse -----------------------------------------------------------
  assert.strictEqual(await canAccessCourse(admin, courseB), true, 'admin bypasses');
  assert.strictEqual(await canAccessCourse(teacher, courseA), true, 'teacher assigned');
  assert.strictEqual(await canAccessCourse(teacher, courseB), false, 'teacher NOT assigned');
  assert.strictEqual(await canAccessCourse(ta, courseA), true, 'ta assigned');
  assert.strictEqual(await canAccessCourse(ta, courseB), false, 'ta NOT assigned');
  assert.strictEqual(await canAccessCourse(student, courseA), false, 'student never');
  assert.strictEqual(await canAccessCourse(teacher, 999999), false, 'missing course');
  console.log('[test] canAccessCourse OK');

  // --- role middleware -------------------------------------------------------------
  let res = fakeRes(); let nx = nextCalled();
  await requireAdmin(fakeReq(ta), res, nx);
  assert.strictEqual(res.statusCode, 403, 'TA blocked from admin-only');
  assert.strictEqual(nx.wasCalled(), false);
  res = fakeRes(); nx = nextCalled();
  await requireAdmin(fakeReq(teacher), res, nx);
  assert.strictEqual(res.statusCode, 403, 'teacher blocked from admin-only');
  res = fakeRes(); nx = nextCalled();
  await requireAdmin(fakeReq(admin), res, nx);
  assert.strictEqual(nx.wasCalled(), true, 'admin passes requireAdmin');
  res = fakeRes(); nx = nextCalled();
  await requireContent(fakeReq(ta), res, nx);
  assert.strictEqual(res.statusCode, 403, 'TA blocked from content routes');
  res = fakeRes(); nx = nextCalled();
  await requireContent(fakeReq(teacher), res, nx);
  assert.strictEqual(nx.wasCalled(), true, 'teacher passes requireContent');
  res = fakeRes(); nx = nextCalled();
  await requireStaff(fakeReq(ta), res, nx);
  assert.strictEqual(nx.wasCalled(), true, 'TA passes requireStaff (staff portal)');
  console.log('[test] role middleware OK');

  // --- requireCourseAccess middleware ------------------------------------------------
  res = fakeRes(); nx = nextCalled();
  await requireCourseAccess(() => courseB)(fakeReq(teacher, { id: String(courseB) }), res, nx);
  assert.strictEqual(res.statusCode, 403, 'teacher blocked from unassigned course');
  res = fakeRes(); nx = nextCalled();
  const reqA = fakeReq(teacher, { id: String(courseA) });
  await requireCourseAccess(() => courseA)(reqA, res, nx);
  assert.strictEqual(nx.wasCalled(), true, 'teacher passes for assigned course');
  assert.strictEqual(reqA.courseId, courseA, 'req.courseId set');
  console.log('[test] requireCourseAccess OK');

  // --- sessions: timezone conversion + join window -----------------------------------
  const utc = H.zonedTimeToUtc('2026-11-02', '14:30', 'America/New_York');
  assert.ok(utc instanceof Date, 'zonedTimeToUtc returns Date');
  assert.strictEqual(utc.getUTCHours(), 19, 'EDT->EST: 14:30 New York = 19:30 UTC on Nov 2');
  assert.strictEqual(H.toDbTs(utc), '2026-11-02 19:30:00');
  const parts = H.zonedDateTimeParts('2026-11-02 19:30:00', 'America/New_York');
  assert.deepStrictEqual(parts, { date: '2026-11-02', time: '14:30' }, 'round-trip wall time');
  assert.strictEqual(H.zonedTimeToUtc('bad', 'xx', 'UTC'), null, 'invalid input -> null');
  console.log('[test] timezone helpers OK');

  const future = new Date(Date.now() + 2 * 3600 * 1000);
  const sessId = (await db.prepare(`INSERT INTO live_sessions
    (course_id, title, starts_at, duration_min, timezone, meeting_url, created_by)
    VALUES (?,?,?,?,?,?,?)`).run(courseA, 'Live Practice', H.toDbTs(future), 60, 'UTC',
    'https://meet.example.com/abc', adminRow.id)).lastInsertRowid;
  const sess = await db.prepare('SELECT * FROM live_sessions WHERE id=?').get(sessId);
  assert.strictEqual(H.canJoinSession(sess, new Date(future.getTime() - 10 * 60000)), true, 'joinable 10 min before');
  assert.strictEqual(H.canJoinSession(sess, new Date(future.getTime() - 20 * 60000)), false, 'not joinable 20 min before');
  assert.strictEqual(H.canJoinSession(sess, new Date(future.getTime() + 61 * 60000)), false, 'not joinable after end');
  assert.strictEqual(H.canJoinSession({ ...sess, status: 'cancelled' }, new Date(future.getTime())), false, 'cancelled never joinable');
  assert.strictEqual(H.canJoinSession({ ...sess, meeting_url: '' }, new Date(future.getTime())), false, 'no URL never joinable');
  console.log('[test] session join window OK');

  // --- attendance ----------------------------------------------------------------------
  await db.prepare(`INSERT INTO attendance (session_id, user_id, status, marked_by) VALUES (?,?,?,?)`)
    .run(sessId, studentId, 'present', teacherId);
  const summary = await H.attendanceSummary(courseA);
  assert.strictEqual(summary.length, 1, 'one enrolled student in summary');
  assert.strictEqual(summary[0].pct, 100, 'present => 100%');
  assert.strictEqual(summary[0].present, 1);
  console.log('[test] attendance summary OK');

  // --- calendar --------------------------------------------------------------------------
  const y = 2027, mo = 3;
  await db.prepare(`INSERT INTO quizzes (course_id, title, due_at, available_from, available_until) VALUES (?,?,?,?,?)`)
    .run(courseA, 'March Quiz', '2027-03-15 23:59:00', '2027-03-10 00:00:00', '2027-03-15 23:59:00');
  await db.prepare(`INSERT INTO assignments (course_id, title, due_at) VALUES (?,?,?)`)
    .run(courseA, 'March Essay', '2027-03-20 23:59:00');
  await db.prepare(`INSERT INTO live_sessions (course_id, title, starts_at, duration_min, timezone, meeting_url)
    VALUES (?,?,?,?,?,?)`).run(courseA, 'March Live', '2027-03-12 15:00:00', 60, 'UTC', 'https://x.example/');
  const events = await H.getCalendarEvents(y, mo, [courseA]);
  const kinds = new Set(events.map(e => e.kind));
  assert.ok(kinds.has('session') && kinds.has('quiz') && kinds.has('assignment'),
    'calendar merges sessions+quizzes+assignments, got: ' + [...kinds].join(','));
  assert.ok(events.some(e => e.kind === 'session' && e.date === '2027-03-12'), 'session event on right date');
  const weeks = H.buildMonthGrid(y, mo, events);
  assert.strictEqual(weeks.length >= 4 && weeks.every(w => w.length === 7), true, 'month grid weeks x 7');
  const inMonth = weeks.flat().filter(c => c.inMonth).length;
  assert.strictEqual(inMonth, 31, 'March 2027 has 31 day cells');
  const scopedOut = await H.getCalendarEvents(y, mo, [courseB]);
  assert.strictEqual(scopedOut.length, 0, 'course scoping excludes other courses');
  console.log('[test] calendar OK:', events.length, 'events');

  // --- email honesty -----------------------------------------------------------------------
  let r = await H.sendEmail('x@test.com', 'Hello', 'body');
  assert.strictEqual(r.sent, false, 'not configured => sent=false');
  assert.match(r.reason, /SMTP not configured/, 'honest reason');
  // misconfigured SMTP must fail gracefully, never throw
  await setSetting('smtp_host', '127.0.0.1');
  await setSetting('smtp_port', '1');
  H._resetEmailTransport();
  r = await H.sendEmail('x@test.com', 'Hello', 'body');
  assert.strictEqual(r.sent, false, 'bad SMTP => sent=false');
  assert.match(r.reason, /^Email failed:/, 'failure reason surfaced');
  await setSetting('smtp_host', '');
  await setSetting('smtp_port', '');
  H._resetEmailTransport();
  assert.strictEqual(await H.emailConfigured(), false, 'emailConfigured false when unset');
  console.log('[test] email honesty OK');

  // --- reminder worker -----------------------------------------------------------------------
  const soon = new Date(Date.now() + 23 * 3600 * 1000);
  const rsId = (await db.prepare(`INSERT INTO live_sessions (course_id, title, starts_at, duration_min, timezone, meeting_url)
    VALUES (?,?,?,?,?,?)`).run(courseA, 'Reminder Class', H.toDbTs(soon), 60, 'UTC', 'https://x.example/')).lastInsertRowid;
  const pastStart = new Date(Date.now() - 3 * 3600 * 1000);
  const pastId = (await db.prepare(`INSERT INTO live_sessions (course_id, title, starts_at, duration_min, timezone)
    VALUES (?,?,?,?,?)`).run(courseA, 'Old Class', H.toDbTs(pastStart), 60, 'UTC')).lastInsertRowid;
  const wr = await H.runSessionReminders(new Date());
  assert.strictEqual(wr.reminded, 2, 'two sessions in the 24h window reminded (Live Practice + Reminder Class)');
  assert.strictEqual(wr.completed, 1, 'one past session completed');
  const rs = await db.prepare('SELECT reminder_sent_at FROM live_sessions WHERE id=?').get(rsId);
  assert.ok(rs.reminder_sent_at, 'reminder timestamp set');
  const notif = await db.prepare(`SELECT * FROM notifications WHERE user_id=? AND kind='session'`).get(studentId);
  assert.ok(notif, 'student got in-app reminder notification');
  const past = await db.prepare('SELECT status FROM live_sessions WHERE id=?').get(pastId);
  assert.strictEqual(past.status, 'completed', 'past session auto-completed');
  const wr2 = await H.runSessionReminders(new Date());
  assert.strictEqual(wr2.reminded, 0, 'reminders are idempotent');
  console.log('[test] reminder worker OK');

  // --- HTTP integration ----------------------------------------------------------------------
  const app = require('../app');
  await new Promise((resolve, reject) => {
    const srv = app.listen(0, () => {
      (async () => {
        try {
          const base = `http://127.0.0.1:${srv.address().port}`;
          const login = async (email) => {
            const res = await fetch(base + '/login', { method: 'POST', redirect: 'manual',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: `email=${encodeURIComponent(email)}&password=password123` });
            assert.strictEqual(res.status, 302, 'login redirects, got ' + res.status);
            const cookie = res.headers.get('set-cookie');
            assert.ok(cookie, 'session cookie set');
            return cookie.split(';')[0];
          };
          const get = (cookie, path) => fetch(base + path, { redirect: 'manual',
            headers: cookie ? { Cookie: cookie } : {} });
          const post = (cookie, path, body) => fetch(base + path, { method: 'POST', redirect: 'manual',
            headers: { ...(cookie ? { Cookie: cookie } : {}), 'Content-Type': 'application/x-www-form-urlencoded' }, body });

          // TA cannot reach admin-only settings
          const taCookie = await login('ta2@test.com');
          let resp = await get(taCookie, '/admin/settings');
          assert.strictEqual(resp.status, 403, 'TA -> /admin/settings is 403, got ' + resp.status);
          resp = await get(taCookie, '/admin');
          assert.strictEqual(resp.status, 200, 'TA can open staff portal');
          resp = await get(taCookie, '/admin/sessions/new');
          assert.strictEqual(resp.status, 403, 'TA cannot open session scheduler (content role)');
          resp = await get(taCookie, `/admin/sessions/${sessId}/attendance`);
          assert.strictEqual(resp.status, 200, 'TA CAN mark attendance for assigned course');
          resp = await post(taCookie, `/admin/sessions/${sessId}/attendance`, `status_${studentId}=late&note_${studentId}=Traffic`);
          assert.strictEqual(resp.status, 302, 'attendance POST redirects');
          const mark = await db.prepare('SELECT status, note FROM attendance WHERE session_id=? AND user_id=?').get(sessId, studentId);
          assert.strictEqual(mark.status, 'late', 'attendance mark updated by TA');
          assert.strictEqual(mark.note, 'Traffic', 'attendance note saved');
          console.log('[test] HTTP: TA restrictions OK');

          // Teacher cannot touch another teacher's course
          const teacherCookie = await login('teacher2@test.com');
          resp = await get(teacherCookie, '/admin/courses');
          assert.strictEqual(resp.status, 200, 'teacher course list 200');
          const listHtml = await resp.text();
          assert.ok(listHtml.includes('>Course A<') && !listHtml.includes('>Course B<'),
            'teacher sees only assigned courses');
          resp = await get(teacherCookie, `/admin/courses/${courseB}/edit`);
          assert.strictEqual(resp.status, 403, 'teacher -> other course edit is 403, got ' + resp.status);
          resp = await post(teacherCookie, `/admin/courses/${courseB}`, 'action=update&title=Hacked');
          assert.strictEqual(resp.status, 403, 'teacher POST to other course is 403, got ' + resp.status);
          const stillB = await db.prepare('SELECT title FROM courses WHERE id=?').get(courseB);
          assert.strictEqual(stillB.title, 'Course B', 'no mutation happened');
          resp = await get(teacherCookie, `/admin/courses/${courseA}/builder`);
          assert.strictEqual(resp.status, 200, 'teacher CAN open assigned course builder');
          console.log('[test] HTTP: teacher course scoping OK');

          // Admin keeps full access
          const adminCookie = await login('admin@beyondborders.academy');
          // admin must_change_password=1 in seed -> forced to password page
          resp = await get(adminCookie, '/admin/settings');
          assert.ok([200, 302].includes(resp.status), 'admin settings reachable, got ' + resp.status);
          console.log('[test] HTTP: admin access OK');

          // Student views
          const studentCookie = await login('student2@test.com');
          resp = await get(studentCookie, '/sessions');
          assert.strictEqual(resp.status, 200, 'student sessions page 200');
          const sessHtml = await resp.text();
          assert.ok(sessHtml.includes('Live Practice'), 'student sees upcoming session');
          resp = await get(studentCookie, '/calendar');
          assert.strictEqual(resp.status, 200, 'student calendar 200');
          resp = await get(studentCookie, '/admin');
          assert.strictEqual(resp.status, 403, 'student blocked from staff portal');
          console.log('[test] HTTP: student views OK');

          // Anonymous
          resp = await get(null, '/admin/sessions');
          assert.strictEqual(resp.status, 302, 'anon -> staff portal redirects to login');
          console.log('[test] HTTP: anonymous OK');

          srv.close(resolve);
        } catch (e) { srv.close(() => reject(e)); }
      })();
    });
  });

  await pool.end();
  console.log('\nALL PHASE-2 TESTS PASSED');
}

main().catch(e => { console.error('TEST FAILED:', e); process.exit(1); });
