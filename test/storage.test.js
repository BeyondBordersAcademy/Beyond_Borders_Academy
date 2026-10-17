// Storage migration test: exercises lib/storage.js against the LOCAL fallback
// and (with a mocked fetch) the SUPABASE path — upload/download/delete
// roundtrips, backend auto-detect, and the certificate PDF buffer builder.
// Run: STORAGE_BACKEND unset; node test/storage.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Dummy DATABASE_URL so requiring lib/certificates.js (which requires lib/db)
// doesn't throw; no DB connection is ever made.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://dummy:dummy@localhost:1/dummy';

function resetEnv() {
  delete process.env.STORAGE_BACKEND;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_KEY;
  delete process.env.SUPABASE_STORAGE_BUCKET;
}

async function main() {
  // ---------------------------------------------------------------- local --
  resetEnv();
  delete require.cache[require.resolve('../lib/storage')];
  let storage = require('../lib/storage');

  assert.strictEqual(storage.backend(), 'local', 'auto-detect without Supabase env -> local');
  console.log('[test] backend auto-detect -> local OK');

  process.env.STORAGE_BACKEND = 'local';
  assert.strictEqual(storage.backend(), 'local', 'explicit STORAGE_BACKEND=local');
  delete process.env.STORAGE_BACKEND;

  // upload -> download roundtrip
  const payload = Buffer.from('hello storage test ' + Date.now());
  const p = await storage.uploadBuffer('materials', 'roundtrip-test.txt', payload, 'text/plain');
  assert.strictEqual(p, 'uploads/materials/roundtrip-test.txt', 'storage path format');
  const abs = path.join(__dirname, '..', p);
  assert.ok(fs.existsSync(abs), 'file written to local disk');
  const back = await storage.downloadBuffer(p);
  assert.ok(back.equals(payload), 'download roundtrip matches');
  console.log('[test] local upload/download roundtrip OK:', p);

  // signed URL on local backend -> null (route serves via sendFile)
  assert.strictEqual(await storage.getSignedUrl(p), null, 'local getSignedUrl -> null');
  console.log('[test] local getSignedUrl -> null OK');

  // delete (idempotent)
  await storage.deleteObject(p);
  assert.ok(!fs.existsSync(abs), 'file deleted from disk');
  await storage.deleteObject(p); // second delete must not throw
  console.log('[test] local deleteObject idempotent OK');

  // filename sanitization
  const p2 = await storage.uploadBuffer('avatars', '../../evil/x.png', Buffer.from('x'), 'image/png');
  assert.strictEqual(p2, 'uploads/avatars/x.png', 'filename reduced to basename: ' + p2);
  await storage.deleteObject(p2);
  console.log('[test] filename sanitization OK');

  // unsafe paths rejected
  await assert.rejects(require('../lib/storage').downloadBuffer('../secret'),
    /Refusing/, 'path escape rejected (local read)');
  console.log('[test] path-escape guards OK');

  // unknown prefix rejected
  await assert.rejects(storage.uploadBuffer('nope', 'a.txt', Buffer.from('x')),
    /Unknown prefix/, 'unknown prefix rejected');
  console.log('[test] prefix whitelist OK');

  // STORAGE_BACKEND=supabase without credentials -> clear error
  process.env.STORAGE_BACKEND = 'supabase';
  assert.throws(() => storage.backend(), /not set/, 'forced supabase without env throws');
  delete process.env.STORAGE_BACKEND;
  console.log('[test] forced-supabase-without-env throws OK');

  // ------------------------------------------------------------- supabase --
  resetEnv();
  process.env.SUPABASE_URL = 'https://xyzcompany.supabase.co';
  process.env.SUPABASE_SERVICE_KEY = 'service-key-123';
  delete require.cache[require.resolve('../lib/storage')];
  storage = require('../lib/storage');
  assert.strictEqual(storage.backend(), 'supabase', 'auto-detect with Supabase env -> supabase');

  // explicit local override wins even with Supabase env present
  process.env.STORAGE_BACKEND = 'local';
  assert.strictEqual(storage.backend(), 'local', 'STORAGE_BACKEND=local overrides');
  delete process.env.STORAGE_BACKEND;
  assert.strictEqual(storage.bucket(), 'academy-uploads', 'default bucket');
  console.log('[test] supabase auto-detect + overrides OK');

  // mock fetch: record calls, return canned Storage API responses
  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body });
    if (url.includes('/object/sign/')) {
      return { ok: true, status: 200, json: async () => ({ signedURL: '/object/sign/academy-uploads/materials/a.pdf?token=t' }) };
    }
    if ((opts.method || 'GET') === 'GET') {
      return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode('supabase-bytes').buffer };
    }
    return { ok: true, status: 200, text: async () => '', json: async () => ({}) };
  };

  try {
    const sp = await storage.uploadBuffer('submissions', 'hw1.pdf', Buffer.from('pdf-bytes'), 'application/pdf');
    assert.strictEqual(sp, 'uploads/submissions/hw1.pdf');
    const up = calls[calls.length - 1];
    assert.strictEqual(up.method, 'POST');
    assert.strictEqual(up.url, 'https://xyzcompany.supabase.co/storage/v1/object/academy-uploads/submissions/hw1.pdf');
    assert.strictEqual(up.headers.apikey, 'service-key-123', 'apikey header');
    assert.strictEqual(up.headers.Authorization, 'Bearer service-key-123', 'auth header');
    assert.strictEqual(up.headers['x-upsert'], 'true', 'upsert header');
    assert.strictEqual(up.headers['Content-Type'], 'application/pdf', 'content-type header');
    assert.ok(Buffer.isBuffer(up.body) && up.body.toString() === 'pdf-bytes', 'buffer body');
    console.log('[test] supabase uploadBuffer OK:', up.url);

    const dl = await storage.downloadBuffer('uploads/submissions/hw1.pdf');
    const g = calls[calls.length - 1];
    assert.strictEqual(g.method, 'GET');
    assert.strictEqual(g.url, 'https://xyzcompany.supabase.co/storage/v1/object/academy-uploads/submissions/hw1.pdf');
    assert.ok(Buffer.isBuffer(dl) && dl.toString() === 'supabase-bytes', 'downloaded bytes');
    console.log('[test] supabase downloadBuffer OK');

    await storage.deleteObject('uploads/submissions/hw1.pdf');
    const d = calls[calls.length - 1];
    assert.strictEqual(d.method, 'DELETE');
    assert.strictEqual(d.url, 'https://xyzcompany.supabase.co/storage/v1/object/academy-uploads/submissions/hw1.pdf');
    console.log('[test] supabase deleteObject OK');

    const signed = await storage.getSignedUrl('uploads/materials/a.pdf', 300);
    const s = calls[calls.length - 1];
    assert.strictEqual(s.method, 'POST');
    assert.ok(s.url.endsWith('/object/sign/academy-uploads/materials/a.pdf'), 'sign endpoint');
    assert.deepStrictEqual(JSON.parse(s.body), { expiresIn: 300 }, 'expiresIn payload');
    assert.strictEqual(signed,
      'https://xyzcompany.supabase.co/storage/v1/object/sign/academy-uploads/materials/a.pdf?token=t',
      'full signed URL');
    console.log('[test] supabase getSignedUrl OK:', signed);

    // supabase rejects unknown prefixes too (no request made)
    const before = calls.length;
    await assert.rejects(storage.uploadBuffer('uploads', 'a.txt', Buffer.from('x')), /Unknown|unexpected/i);
    assert.strictEqual(calls.length, before, 'no request for bad prefix');
    console.log('[test] supabase prefix guard OK');
  } finally {
    global.fetch = realFetch;
  }

  // ------------------------------------------------- certificate PDF buffer --
  // Requiring lib/certificates.js pulls in lib/db, whose `ready` starts
  // migrations against the dummy DATABASE_URL above. That connection will
  // fail (expected — we never use the DB here), so mark it handled.
  const dbmod = require('../lib/db');
  dbmod.ready.catch(() => {});
  process.on('unhandledRejection', (err) => {
    if (err && (err.code === 'ECONNREFUSED' || (err.errors || []).some(e => e.code === 'ECONNREFUSED'))) return;
    console.error('UNEXPECTED unhandledRejection:', err);
    process.exit(1);
  });
  const { buildCertificatePDF } = require('../lib/certificates');
  const pdf = await buildCertificatePDF({
    code: 'TEST-001', studentName: 'Test Student', courseTitle: 'English A1',
    level: 'A1', issuedDate: 'October 17, 2026', verifyUrl: 'https://example.com/verify/TEST-001',
  });
  assert.ok(Buffer.isBuffer(pdf), 'buildCertificatePDF returns a Buffer');
  assert.ok(pdf.slice(0, 5).toString() === '%PDF-', 'buffer is a real PDF');
  assert.ok(pdf.length > 5000, 'PDF has content (' + pdf.length + ' bytes)');
  console.log('[test] buildCertificatePDF buffer OK (%d bytes)', pdf.length);

  // and the buffer uploads through storage (local fallback)
  resetEnv();
  delete require.cache[require.resolve('../lib/storage')];
  storage = require('../lib/storage');
  const cp = await storage.uploadBuffer('certificates', 'TEST-001.pdf', pdf, 'application/pdf');
  assert.strictEqual(cp, 'uploads/certificates/TEST-001.pdf');
  assert.ok(fs.existsSync(path.join(__dirname, '..', cp)));
  await storage.deleteObject(cp);
  console.log('[test] certificate buffer -> storage upload OK');

  console.log('\nALL STORAGE TESTS PASSED');
}

main().catch(err => { console.error('\nSTORAGE TEST FAILED:', err); process.exit(1); });
