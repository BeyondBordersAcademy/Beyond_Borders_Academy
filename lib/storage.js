// File storage abstraction: Supabase Storage (production — Render's disk is
// ephemeral) or local disk (dev fallback).
//
// Backend selection (first match wins):
//   STORAGE_BACKEND=supabase|local   — explicit override
//   SUPABASE_URL + SUPABASE_SERVICE_KEY both set  — supabase
//   otherwise                        — local
//
// Path semantics are backend-agnostic: the value stored in DB columns
// (file_path / audio_path / pdf_path) is always "uploads/<prefix>/<filename>".
// On Supabase the leading "uploads/" is stripped and the rest becomes the
// object key inside SUPABASE_STORAGE_BUCKET (default "academy-uploads").
// Local mode keeps the exact historical layout under ./uploads/.
//
// Only the raw fetch API is used — no extra dependency.
const fs = require('fs');
const path = require('path');

const UPLOADS_ROOT = path.join(__dirname, '..', 'uploads');
const PREFIXES = new Set(['materials', 'submissions', 'certificates', 'avatars']);

function env(name) {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : '';
}

function supabaseConfigured() {
  return !!(env('SUPABASE_URL') && env('SUPABASE_SERVICE_KEY'));
}

// 'supabase' | 'local'
function backend() {
  const forced = env('STORAGE_BACKEND').toLowerCase();
  if (forced === 'supabase' || forced === 'local') {
    if (forced === 'supabase' && !supabaseConfigured()) {
      throw new Error('[storage] STORAGE_BACKEND=supabase but SUPABASE_URL/SUPABASE_SERVICE_KEY are not set');
    }
    return forced;
  }
  return supabaseConfigured() ? 'supabase' : 'local';
}

function bucket() {
  return env('SUPABASE_STORAGE_BUCKET') || 'academy-uploads';
}

function apiBase() {
  return env('SUPABASE_URL').replace(/\/+$/, '') + '/storage/v1';
}

function authHeaders(extra = {}) {
  const key = env('SUPABASE_SERVICE_KEY');
  return { apikey: key, Authorization: `Bearer ${key}`, ...extra };
}

// "uploads/materials/abc.pdf" -> "materials/abc.pdf" (bucket object key)
function toObjectKey(storagePath) {
  let rel = String(storagePath || '').replace(/\\/g, '/');
  rel = rel.replace(/^uploads\//, '');
  const [prefix] = rel.split('/');
  if (!PREFIXES.has(prefix)) {
    throw new Error(`[storage] Refusing unexpected storage path prefix: ${storagePath}`);
  }
  return rel;
}

// "uploads/materials/abc.pdf" -> absolute disk path under ./uploads
function toDiskPath(storagePath) {
  const rel = String(storagePath || '').replace(/\\/g, '/');
  if (rel.includes('..') || path.isAbsolute(rel)) {
    throw new Error(`[storage] Refusing unsafe storage path: ${storagePath}`);
  }
  const abs = path.join(UPLOADS_ROOT, rel.replace(/^uploads\//, ''));
  if (!abs.startsWith(UPLOADS_ROOT + path.sep)) {
    throw new Error(`[storage] Refusing path escape: ${storagePath}`);
  }
  return abs;
}

function safeFilename(filename) {
  return String(filename || 'file')
    .split('/').pop().split('\\').pop()
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 180) || 'file';
}

// Upload a buffer. Returns the DB-storable path "uploads/<prefix>/<filename>".
async function uploadBuffer(prefix, filename, buffer, mimetype) {
  if (!PREFIXES.has(prefix)) throw new Error(`[storage] Unknown prefix: ${prefix}`);
  const name = safeFilename(filename);
  const storagePath = `uploads/${prefix}/${name}`;
  if (backend() === 'local') {
    const abs = toDiskPath(storagePath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, buffer);
    return storagePath;
  }
  const key = toObjectKey(storagePath);
  const res = await fetch(`${apiBase()}/object/${bucket()}/${key}`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': mimetype || 'application/octet-stream', 'x-upsert': 'true' }),
    body: buffer,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`[storage] Supabase upload failed (${res.status}): ${body.slice(0, 200)}`);
  }
  return storagePath;
}

// Read a stored object into a Buffer.
async function downloadBuffer(storagePath) {
  if (backend() === 'local') {
    return fs.readFileSync(toDiskPath(storagePath));
  }
  const key = toObjectKey(storagePath);
  const res = await fetch(`${apiBase()}/object/${bucket()}/${key}`, {
    headers: authHeaders(),
  });
  if (!res.ok) {
    if (res.status === 404) throw Object.assign(new Error('[storage] Object not found'), { code: 'NOT_FOUND' });
    throw new Error(`[storage] Supabase download failed (${res.status})`);
  }
  return Buffer.from(await res.arrayBuffer());
}

// Delete a stored object. Missing objects are ignored (idempotent).
async function deleteObject(storagePath) {
  if (!storagePath) return;
  if (backend() === 'local') {
    try { fs.unlinkSync(toDiskPath(storagePath)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    return;
  }
  const key = toObjectKey(storagePath);
  const res = await fetch(`${apiBase()}/object/${bucket()}/${key}`, {
    method: 'DELETE',
    headers: authHeaders(),
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`[storage] Supabase delete failed (${res.status})`);
  }
}

// Short-lived signed URL for private objects. Returns null on the local
// backend (the /files route serves via sendFile instead).
async function getSignedUrl(storagePath, expiresIn = 300) {
  if (backend() === 'local') return null;
  const key = toObjectKey(storagePath);
  const res = await fetch(`${apiBase()}/object/sign/${bucket()}/${key}`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ expiresIn }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`[storage] Supabase sign failed (${res.status}): ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  if (!data.signedURL) throw new Error('[storage] Supabase sign returned no signedURL');
  return apiBase() + data.signedURL;
}

module.exports = {
  backend,
  bucket,
  supabaseConfigured,
  uploadBuffer,
  downloadBuffer,
  deleteObject,
  getSignedUrl,
};
