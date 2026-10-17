// Migration test: runs the translated Postgres migrations + seed against a REAL
// PostgreSQL server, then exercises the db wrapper.
// The test expects a Postgres server on 127.0.0.1:55433 (trust auth, user
// postgres). In this environment it is started manually from the
// @embedded-postgres binaries before running the test.
// Run: node test/pg-migrate.test.js
const assert = require('assert');
const { Pool } = require('pg');

async function main() {
  const pool = new Pool({
    host: '127.0.0.1',
    port: 55433,
    user: 'postgres',
    database: 'postgres',
  });
  // sanity: real Postgres
  const v = await pool.query('SELECT version()');
  assert.match(v.rows[0].version, /PostgreSQL/, 'real postgres server');
  console.log('[test] connected to', v.rows[0].version.split(' ').slice(0, 2).join(' '));

  try {
    // createLayer bypasses the DATABASE_URL requirement (test hook).
    const { createLayer } = require('../lib/db');
    const layer = createLayer(pool);
    await layer.ready; // migrations + seed
    const { db, getSetting, setSetting } = layer;
    console.log('[test] migrations + seed OK');

    // --- insert / lastInsertRowid / changes
    const r = await db.prepare(
      'INSERT INTO users (name, email, password_hash, role) VALUES (?,?,?,?)'
    ).run('Test Student', 'student@test.com', 'hash', 'student');
    assert.ok(r.lastInsertRowid > 0, 'lastInsertRowid should be positive');
    assert.strictEqual(r.changes, 1, 'changes should be 1');
    console.log('[test] insert/run OK, id =', r.lastInsertRowid);

    // --- get (row + undefined)
    const u = await db.prepare('SELECT * FROM users WHERE id=?').get(r.lastInsertRowid);
    assert.strictEqual(u.email, 'student@test.com');
    assert.strictEqual(await db.prepare('SELECT * FROM users WHERE id=?').get(424242), undefined);
    console.log('[test] get OK');

    // --- all
    const all = await db.prepare('SELECT * FROM users ORDER BY id').all();
    assert.ok(all.length >= 2, 'seed admin + test user, got ' + all.length);
    console.log('[test] all OK, users =', all.length);

    // --- placeholder conversion ($1, $2)
    const two = await db.prepare('SELECT * FROM users WHERE role=? OR email=?').all('admin', 'student@test.com');
    assert.strictEqual(two.length, 2);
    console.log('[test] multi-placeholder OK');

    // --- ILIKE search (was LIKE in SQLite, case-insensitive)
    const found = await db.prepare('SELECT * FROM users WHERE name LIKE ?').all('%TEST%');
    assert.ok(found.length >= 1, 'ILIKE should match case-insensitively');
    console.log('[test] ILIKE OK');

    // --- transaction commit
    await db.transaction(async (tx) => {
      await tx.prepare('INSERT INTO users (name, email, password_hash) VALUES (?,?,?)')
        .run('Tx User', 'tx@test.com', 'h');
    });
    assert.ok(await db.prepare('SELECT id FROM users WHERE email=?').get('tx@test.com'), 'tx commit');
    console.log('[test] transaction commit OK');

    // --- transaction rollback
    try {
      await db.transaction(async (tx) => {
        await tx.prepare('INSERT INTO users (name, email, password_hash) VALUES (?,?,?)')
          .run('Rb User', 'rb@test.com', 'h');
        throw new Error('boom');
      });
      assert.fail('should have thrown');
    } catch (e) {
      assert.strictEqual(e.message, 'boom');
    }
    assert.strictEqual(await db.prepare('SELECT id FROM users WHERE email=?').get('rb@test.com'), undefined, 'tx rollback');
    console.log('[test] transaction rollback OK');

    // --- update / delete changes
    const up = await db.prepare('UPDATE users SET name=? WHERE email=?').run('Renamed', 'tx@test.com');
    assert.strictEqual(up.changes, 1);
    assert.strictEqual(up.lastInsertRowid, undefined);
    console.log('[test] update OK');

    // --- getSetting / setSetting (incl. ON CONFLICT upsert path)
    await setSetting('test_key', 'test_val');
    assert.strictEqual(await getSetting('test_key'), 'test_val');
    await setSetting('test_key', 'test_val2');
    assert.strictEqual(await getSetting('test_key'), 'test_val2');
    assert.strictEqual(await getSetting('no_such_key_xyz', 'dflt'), 'dflt');
    assert.strictEqual(await getSetting('site_name'), 'Beyond Borders English Academy');
    console.log('[test] getSetting/setSetting OK');

    // --- seed data present (sample draft course + quiz)
    const course = await db.prepare("SELECT * FROM courses WHERE slug='sample-beginner-english-a1'").get();
    assert.ok(course && course.status === 'draft', 'sample course seeded as draft');
    const units = await db.prepare('SELECT * FROM units WHERE course_id=?').all(course.id);
    assert.strictEqual(units.length, 1);
    const lessons = await db.prepare('SELECT * FROM lessons WHERE unit_id=? ORDER BY position').all(units[0].id);
    assert.strictEqual(lessons.length, 2);
    console.log('[test] seed data OK');

    // --- TEXT timestamp defaults keep the SQLite-compatible format
    assert.match(u.created_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, 'created_at format: ' + u.created_at);
    console.log('[test] timestamp format OK:', u.created_at);

    // --- UNIQUE violation surfaces as an error
    let dupErr = null;
    try {
      await db.prepare('INSERT INTO users (name, email, password_hash) VALUES (?,?,?)')
        .run('Dup', 'student@test.com', 'h');
    } catch (e) { dupErr = e; }
    assert.ok(dupErr, 'duplicate email should raise');
    console.log('[test] unique constraint OK');

    // --- CHECK constraint enforced
    let chkErr = null;
    try {
      await db.prepare("INSERT INTO users (name, email, password_hash, role) VALUES (?,?,?,'superadmin')")
        .run('Bad', 'bad@test.com', 'h');
    } catch (e) { chkErr = e; }
    assert.ok(chkErr, 'bad role should raise CHECK violation');
    console.log('[test] check constraint OK');

    console.log('\nALL PG-MIGRATE TESTS PASSED');
  } finally {
    await pool.end().catch(() => {});
  }
}

main().catch(e => { console.error('TEST FAILED:', e); process.exit(1); });
