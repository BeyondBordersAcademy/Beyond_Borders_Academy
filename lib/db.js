// Database layer: PostgreSQL via node-postgres (pg).
// connectionString comes from process.env.DATABASE_URL, with
// ssl { rejectUnauthorized: false } (required by Supabase).
//
// The exported `db` mirrors the old better-sqlite3 wrapper, but async:
//   db.prepare(sql) -> { get: async(...p), all: async(...p), run: async(...p) }
//   db.exec(sql)    -> runs multi-statement DDL
//   db.transaction(fn) -> await db.transaction(async (tx) => { ... })
// getSetting / setSetting are async.
// All queries are parameterized -- never interpolate user input into SQL strings.
const { Pool } = require('pg');

// SSL: required by Supabase (rejectUnauthorized:false). Disabled for local
// hosts and when the URL carries ?sslmode=disable (local dev / tests).
function sslFor(url) {
  if (/[?&]sslmode=disable/i.test(url)) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return false;
  } catch (_) { /* fall through to SSL */ }
  return { rejectUnauthorized: false };
}

// ---------------------------------------------------------------------------
// SQL translation (SQLite -> Postgres), applied inside prepare()/exec().
//  - `?` placeholders become $1, $2, ... (verified: no `?` occurs inside a
//    string literal in any SQL in this codebase)
//  - LIKE becomes ILIKE (SQLite LIKE is case-insensitive; all LIKE uses here
//    are search filters, so ILIKE preserves behavior)
//  - datetime('now') becomes TO_CHAR(NOW(), 'YYYY-MM-DD HH24:MI:SS'), keeping
//    the exact TEXT timestamp format the app already stores and compares.
function convertSql(sql) {
  let s = sql.replace(/datetime\('now'\)/g, "TO_CHAR(NOW(), 'YYYY-MM-DD HH24:MI:SS')");
  let out = '';
  let n = 0;
  let inStr = false;
  const isWordChar = c => /[A-Za-z0-9_$]/.test(c);
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "'") {
      if (inStr && s[i + 1] === "'") { out += "''"; i++; continue; }
      inStr = !inStr;
      out += ch;
      continue;
    }
    if (!inStr) {
      if (ch === '?') { n += 1; out += '$' + n; continue; }
      if ((ch === 'L' || ch === 'l') && s.slice(i, i + 4).toUpperCase() === 'LIKE') {
        const prev = i > 0 ? s[i - 1] : ' ';
        const next = s[i + 4] || ' ';
        if (!isWordChar(prev) && !isWordChar(next)) { out += 'ILIKE'; i += 3; continue; }
      }
    }
    out += ch;
  }
  return out;
}

// Tables without an `id` column: INSERTs there must not get `RETURNING id`.
const NO_ID_TABLES = new Set(['site_settings', 'lesson_progress', 'schema_migrations']);

function createLayer(pool) {
  function makeApi(queryFn, isTx) {
    const api = {
      prepare(sql) {
        const text = convertSql(sql);
        const isInsert = /^\s*INSERT\b/i.test(text);
        let wantId = false;
        if (isInsert && !/\bRETURNING\b/i.test(text)) {
          const m = /^\s*INSERT\s+INTO\s+"?([A-Za-z_][\w]*)"?/i.exec(text);
          const tbl = m && m[1].toLowerCase();
          wantId = !!tbl && !NO_ID_TABLES.has(tbl);
        }
        const finalText = wantId ? text + ' RETURNING id' : text;
        return {
          get: async (...params) => {
            const res = await queryFn(finalText, params);
            return res.rows[0];
          },
          all: async (...params) => {
            const res = await queryFn(finalText, params);
            return res.rows;
          },
          run: async (...params) => {
            const res = await queryFn(finalText, params);
            return {
              changes: res.rowCount == null ? 0 : res.rowCount,
              lastInsertRowid: wantId && res.rows[0] ? res.rows[0].id : undefined,
            };
          },
        };
      },
      exec: async (sql) => {
        const stmts = sql.split(';').map(x => x.trim()).filter(Boolean);
        for (const st of stmts) await queryFn(convertSql(st), []);
      },
    };
    if (!isTx) {
      api.transaction = async (fn) => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const txApi = makeApi((t, p) => client.query(t, p), true);
          const result = await fn(txApi);
          await client.query('COMMIT');
          return result;
        } catch (e) {
          try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
          throw e;
        } finally {
          client.release();
        }
      };
    }
    return api;
  }

  const db = makeApi((text, params) => pool.query(text, params), false);

  const getSetting = async (key, def = '') => {
    const row = await db.prepare('SELECT value FROM site_settings WHERE key = ?').get(key);
    return row ? row.value : def;
  };
  const setSetting = async (key, value) => {
    await db.prepare(`INSERT INTO site_settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, String(value));
  };

  const ready = (async () => {
    await migrate(db);
    await seed(db, getSetting, setSetting);
  })();

  return { db, getSetting, setSetting, ready, pool };
}

// ---------------------------------------------------------------- migrations
// Translated from SQLite: INTEGER PRIMARY KEY AUTOINCREMENT -> SERIAL PRIMARY KEY,
// datetime('now') -> TO_CHAR(NOW(), 'YYYY-MM-DD HH24:MI:SS') (same TEXT format),
// COLLATE NOCASE dropped (emails are lowercased by the app; searches use ILIKE),
// PRAGMAs dropped (Postgres enforces foreign keys by default).
const MIGRATIONS = [
  // 1: core tables
  `
  CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'student' CHECK (role IN ('admin','teacher','student','ta')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','pending')),
    cefr_level TEXT,
    preferred_lang TEXT NOT NULL DEFAULT 'en',
    admin_notes TEXT DEFAULT '',
    must_change_password INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (TO_CHAR(NOW(), 'YYYY-MM-DD HH24:MI:SS'))
  );
  CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
  CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

  CREATE TABLE IF NOT EXISTS password_resets (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token TEXT UNIQUE NOT NULL,
    expires_at TEXT NOT NULL,
    used INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS invitations (
    id SERIAL PRIMARY KEY,
    email TEXT NOT NULL,
    token TEXT UNIQUE NOT NULL,
    role TEXT NOT NULL DEFAULT 'student',
    course_id INTEGER,
    expires_at TEXT NOT NULL,
    used INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (TO_CHAR(NOW(), 'YYYY-MM-DD HH24:MI:SS'))
  );

  CREATE TABLE IF NOT EXISTS courses (
    id SERIAL PRIMARY KEY,
    title TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    description TEXT DEFAULT '',
    objectives TEXT DEFAULT '',
    level TEXT DEFAULT '',
    instructor TEXT DEFAULT '',
    format TEXT DEFAULT 'self-paced',
    price_cents INTEGER NOT NULL DEFAULT 0,
    enrollment_mode TEXT NOT NULL DEFAULT 'open' CHECK (enrollment_mode IN ('open','invite','approval')),
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
    grading_config_json TEXT DEFAULT '{}',
    completion_requirements TEXT DEFAULT '',
    certificate_requirements TEXT DEFAULT '',
    created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (TO_CHAR(NOW(), 'YYYY-MM-DD HH24:MI:SS'))
  );
  CREATE INDEX IF NOT EXISTS idx_courses_status ON courses(status);

  CREATE TABLE IF NOT EXISTS units (
    id SERIAL PRIMARY KEY,
    course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_units_course ON units(course_id);

  CREATE TABLE IF NOT EXISTS lessons (
    id SERIAL PRIMARY KEY,
    unit_id INTEGER NOT NULL REFERENCES units(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    body_html TEXT DEFAULT '',
    body_es TEXT DEFAULT '',
    position INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('draft','published'))
  );
  CREATE INDEX IF NOT EXISTS idx_lessons_unit ON lessons(unit_id);

  CREATE TABLE IF NOT EXISTS materials (
    id SERIAL PRIMARY KEY,
    course_id INTEGER REFERENCES courses(id) ON DELETE SET NULL,
    unit_id INTEGER REFERENCES units(id) ON DELETE SET NULL,
    lesson_id INTEGER REFERENCES lessons(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'document' CHECK (kind IN ('document','audio','video','worksheet','presentation','image','link','other')),
    file_path TEXT,
    external_url TEXT,
    downloadable INTEGER NOT NULL DEFAULT 1,
    tags TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (TO_CHAR(NOW(), 'YYYY-MM-DD HH24:MI:SS'))
  );
  CREATE INDEX IF NOT EXISTS idx_materials_course ON materials(course_id);

  CREATE TABLE IF NOT EXISTS enrollments (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','dropped','pending')),
    progress_pct REAL NOT NULL DEFAULT 0,
    enrolled_at TEXT NOT NULL DEFAULT (TO_CHAR(NOW(), 'YYYY-MM-DD HH24:MI:SS')),
    UNIQUE(user_id, course_id)
  );
  CREATE INDEX IF NOT EXISTS idx_enroll_user ON enrollments(user_id);
  CREATE INDEX IF NOT EXISTS idx_enroll_course ON enrollments(course_id);

  CREATE TABLE IF NOT EXISTS assignments (
    id SERIAL PRIMARY KEY,
    course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    instructions TEXT DEFAULT '',
    due_at TEXT,
    max_points REAL NOT NULL DEFAULT 100,
    rubric_text TEXT DEFAULT '',
    submission_formats_json TEXT DEFAULT '["text"]',
    late_policy TEXT DEFAULT '',
    resubmission_allowed INTEGER NOT NULL DEFAULT 0,
    category TEXT NOT NULL DEFAULT 'assignments',
    weight REAL,
    created_at TEXT NOT NULL DEFAULT (TO_CHAR(NOW(), 'YYYY-MM-DD HH24:MI:SS'))
  );

  CREATE TABLE IF NOT EXISTS submissions (
    id SERIAL PRIMARY KEY,
    assignment_id INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body_text TEXT DEFAULT '',
    file_path TEXT,
    audio_path TEXT,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','under_review','needs_revision','graded')),
    grade REAL,
    feedback TEXT DEFAULT '',
    submitted_at TEXT,
    history_json TEXT DEFAULT '[]',
    updated_at TEXT NOT NULL DEFAULT (TO_CHAR(NOW(), 'YYYY-MM-DD HH24:MI:SS'))
  );
  CREATE INDEX IF NOT EXISTS idx_sub_assign ON submissions(assignment_id);
  CREATE INDEX IF NOT EXISTS idx_sub_user ON submissions(user_id);

  CREATE TABLE IF NOT EXISTS question_banks (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    level TEXT DEFAULT '',
    topic TEXT DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS quizzes (
    id SERIAL PRIMARY KEY,
    course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    instructions TEXT DEFAULT '',
    time_limit_min INTEGER,
    attempts_allowed INTEGER NOT NULL DEFAULT 1,
    randomize INTEGER NOT NULL DEFAULT 0,
    passing_score REAL,
    due_at TEXT,
    available_from TEXT,
    available_until TEXT,
    category TEXT NOT NULL DEFAULT 'quizzes',
    weight REAL,
    created_at TEXT NOT NULL DEFAULT (TO_CHAR(NOW(), 'YYYY-MM-DD HH24:MI:SS'))
  );

  CREATE TABLE IF NOT EXISTS questions (
    id SERIAL PRIMARY KEY,
    quiz_id INTEGER REFERENCES quizzes(id) ON DELETE CASCADE,
    bank_id INTEGER REFERENCES question_banks(id) ON DELETE SET NULL,
    qtype TEXT NOT NULL CHECK (qtype IN ('multiple_choice','multiple_select','true_false','fill_blank','short_answer','essay')),
    prompt TEXT NOT NULL,
    options_json TEXT DEFAULT '[]',
    correct_json TEXT DEFAULT 'null',
    points REAL NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_questions_quiz ON questions(quiz_id);

  CREATE TABLE IF NOT EXISTS attempts (
    id SERIAL PRIMARY KEY,
    quiz_id INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    answers_json TEXT NOT NULL DEFAULT '{}',
    score REAL,
    max_score REAL,
    status TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','submitted','graded','needs_grading')),
    started_at TEXT NOT NULL DEFAULT (TO_CHAR(NOW(), 'YYYY-MM-DD HH24:MI:SS')),
    submitted_at TEXT,
    attempt_no INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_attempts_quiz_user ON attempts(quiz_id, user_id);

  CREATE TABLE IF NOT EXISTS grade_overrides (
    id SERIAL PRIMARY KEY,
    course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    item_type TEXT NOT NULL CHECK (item_type IN ('assignment','quiz','manual')),
    item_id INTEGER,
    points REAL NOT NULL,
    max_points REAL NOT NULL,
    note TEXT DEFAULT '',
    created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (TO_CHAR(NOW(), 'YYYY-MM-DD HH24:MI:SS'))
  );

  CREATE TABLE IF NOT EXISTS announcements (
    id SERIAL PRIMARY KEY,
    audience TEXT NOT NULL DEFAULT 'all' CHECK (audience IN ('all','course','users')),
    course_id INTEGER REFERENCES courses(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    body TEXT DEFAULT '',
    created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (TO_CHAR(NOW(), 'YYYY-MM-DD HH24:MI:SS'))
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'info',
    title TEXT NOT NULL,
    body TEXT DEFAULT '',
    read INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (TO_CHAR(NOW(), 'YYYY-MM-DD HH24:MI:SS'))
  );
  CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id);

  CREATE TABLE IF NOT EXISTS messages (
    id SERIAL PRIMARY KEY,
    from_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    to_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    course_id INTEGER REFERENCES courses(id) ON DELETE SET NULL,
    body TEXT NOT NULL,
    read INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (TO_CHAR(NOW(), 'YYYY-MM-DD HH24:MI:SS'))
  );
  CREATE INDEX IF NOT EXISTS idx_msg_users ON messages(from_user_id, to_user_id);

  CREATE TABLE IF NOT EXISTS certificates (
    id SERIAL PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    issued_at TEXT NOT NULL DEFAULT (TO_CHAR(NOW(), 'YYYY-MM-DD HH24:MI:SS')),
    status TEXT NOT NULL DEFAULT 'valid' CHECK (status IN ('valid','revoked')),
    pdf_path TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_cert_code ON certificates(code);
  CREATE INDEX IF NOT EXISTS idx_cert_user ON certificates(user_id);

  CREATE TABLE IF NOT EXISTS audit_logs (
    id SERIAL PRIMARY KEY,
    actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    details TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (TO_CHAR(NOW(), 'YYYY-MM-DD HH24:MI:SS'))
  );
  CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action);

  CREATE TABLE IF NOT EXISTS site_settings (
    key TEXT PRIMARY KEY,
    value TEXT DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS lesson_progress (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
    completed INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (TO_CHAR(NOW(), 'YYYY-MM-DD HH24:MI:SS')),
    UNIQUE(user_id, lesson_id)
  );

  CREATE TABLE IF NOT EXISTS contact_messages (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (TO_CHAR(NOW(), 'YYYY-MM-DD HH24:MI:SS')),
    handled INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS placement_results (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    name TEXT DEFAULT '',
    email TEXT DEFAULT '',
    score REAL NOT NULL,
    max_score REAL NOT NULL,
    cefr_estimate TEXT NOT NULL,
    recommended_course_id INTEGER REFERENCES courses(id) ON DELETE SET NULL,
    answers_json TEXT DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (TO_CHAR(NOW(), 'YYYY-MM-DD HH24:MI:SS'))
  );

  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (TO_CHAR(NOW(), 'YYYY-MM-DD HH24:MI:SS'))
  );
  `,
  // vN+1: listening audio support for quiz questions
  `ALTER TABLE questions ADD COLUMN IF NOT EXISTS audio_url TEXT;`,
];

async function migrate(db) {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (TO_CHAR(NOW(), 'YYYY-MM-DD HH24:MI:SS'))
  )`);
  const rows = await db.prepare('SELECT version FROM schema_migrations').all();
  const applied = new Set(rows.map(r => r.version));
  for (let i = 0; i < MIGRATIONS.length; i++) {
    const v = i + 1;
    if (!applied.has(v)) {
      await db.transaction(async (tx) => {
        await tx.exec(MIGRATIONS[i]);
        await tx.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(v);
      });
      console.log(`[db] applied migration ${v}`);
    }
  }
}

// ---------------------------------------------------------------- seed data
async function seed(db, getSetting, setSetting) {
  const bcrypt = require('bcryptjs');
  // Admin user (Charlie). Force password change on first login.
  const admin = await db.prepare('SELECT id FROM users WHERE email = ?').get('admin@beyondborders.academy');
  if (!admin) {
    const hash = bcrypt.hashSync('ChangeMe123!', 12);
    await db.prepare(`INSERT INTO users (name, email, password_hash, role, status, must_change_password)
      VALUES (?,?,?,?,?,1)`).run('Charlie', 'admin@beyondborders.academy', hash, 'admin', 'active');
    console.log('[db] seeded admin user admin@beyondborders.academy');
  }

  // Default site settings
  const defaults = {
    site_name: 'Beyond Borders English Academy',
    tagline: 'Breaking Barriers, Building Futures',
    contact_email: 'info@beyondborders.academy',
    contact_phone: '',
    address: '',
    homepage_hero_headline: 'Your Future Speaks English.',
    homepage_hero_sub: 'Learn English with confidence through practical lessons, personalized learning, and a supportive educational community.',
    homepage_mission: 'At Beyond Borders English Academy, we believe that language should open doors, not create barriers. Our mission is to help students develop the English skills they need to communicate confidently, pursue new opportunities, and build a better future.\n\nThrough structured lessons, practical exercises, reading, listening, writing, pronunciation practice, and personalized feedback, we help learners progress at their own pace.',
    homepage_values: 'Accessibility, Confidence, Communication, Personal growth, Cultural understanding, Educational opportunity, Lifelong learning',
    smtp_host: '', smtp_port: '', smtp_user: '', smtp_pass: '', smtp_from: '',
    stripe_status: 'not_configured',
    ai_status: 'not_configured',
    zoom_status: 'not_configured',
  };
  for (const [k, v] of Object.entries(defaults)) {
    if (await getSetting(k, null) === null) await setSetting(k, v);
  }

  // Sample draft course (clearly labeled, draft so it never shows publicly)
  const sample = await db.prepare('SELECT id FROM courses WHERE slug = ?').get('sample-beginner-english-a1');
  if (!sample) {
    const c = await db.prepare(`INSERT INTO courses
      (title, slug, description, objectives, level, instructor, format, status, created_by)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(
      'Sample: Beginner English A1',
      'sample-beginner-english-a1',
      'SAMPLE COURSE FOR TESTING ONLY. A short sample course used to demonstrate lessons, quizzes, and progress tracking. Not a real class.',
      'Greet people and introduce yourself.\nUse the verb "to be" in simple sentences.',
      'A1', 'Charlie', 'self-paced', 'draft', 1
    );
    const courseId = c.lastInsertRowid;
    const u = await db.prepare('INSERT INTO units (course_id, title, position) VALUES (?,?,?)').run(courseId, 'Unit 1: First Steps', 0);
    const unitId = u.lastInsertRowid;
    const lessons = [
      ['Lesson 1: Greetings and Introductions',
       '<h2>Greetings</h2><p>Common greetings in English: <strong>Hello</strong>, <strong>Hi</strong>, <strong>Good morning</strong>, <strong>Good evening</strong>.</p><h2>Introductions</h2><p><em>My name is...</em> / <em>I am from...</em></p><p>Example: "Hello! My name is Ana. I am from Mexico."</p>',
       '<h2>Saludos</h2><p>Saludos comunes en inglés: <strong>Hello</strong> (hola), <strong>Hi</strong> (hola, informal), <strong>Good morning</strong> (buenos días), <strong>Good evening</strong> (buenas noches).</p>'],
      ['Lesson 2: The Verb "To Be"',
       '<h2>The verb "to be"</h2><p><strong>I am</strong> a student.<br><strong>You are</strong> my friend.<br><strong>She is</strong> a teacher.</p><p>Negative: I am <strong>not</strong> tired.</p>',
       '<h2>El verbo "to be" (ser/estar)</h2><p><strong>I am</strong> = yo soy / yo estoy.</p>'],
    ];
    for (let li = 0; li < lessons.length; li++) {
      const [title, body_html, body_es] = lessons[li];
      await db.prepare('INSERT INTO lessons (unit_id, title, body_html, body_es, position, status) VALUES (?,?,?,?,?,?)')
        .run(unitId, title, body_html, body_es, li, 'published');
    }
    const q = await db.prepare(`INSERT INTO quizzes (course_id, title, instructions, attempts_allowed, passing_score)
      VALUES (?,?,?,?,?)`).run(courseId, 'Sample Quiz: Greetings', 'Answer all questions. This is a sample quiz.', 3, 60);
    const quizId = q.lastInsertRowid;
    const qs = [
      ['multiple_choice', 'How do you greet someone in the morning?', '["Good morning","Good night","Goodbye","See you"]', '"Good morning"', 1],
      ['true_false', '"My name is Ana" is a correct introduction.', '["True","False"]', '"True"', 1],
      ['fill_blank', 'Complete: "I ___ a student." (am/is/are)', '[]', '"am"', 1],
    ];
    for (const [qtype, prompt, options_json, correct_json, points] of qs) {
      await db.prepare('INSERT INTO questions (quiz_id, qtype, prompt, options_json, correct_json, points) VALUES (?,?,?,?,?,?)')
        .run(quizId, qtype, prompt, options_json, correct_json, points);
    }
    console.log('[db] seeded sample draft course');
  }
}

// ---------------------------------------------------------------------------
// Default layer: created lazily so `createLayer` stays usable in tests
// without a DATABASE_URL. The getters preserve the original export shape.
let _default = null;
function defaultLayer() {
  if (!_default) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error('[db] DATABASE_URL environment variable is required (Postgres connection string).');
    }
    _default = createLayer(new Pool({ connectionString: url, ssl: sslFor(url) }));
  }
  return _default;
}

module.exports = {
  createLayer, // test hook: createLayer(poolLike) -> { db, getSetting, setSetting, ready, pool }
  get db() { return defaultLayer().db; },
  get getSetting() { return defaultLayer().getSetting; },
  get setSetting() { return defaultLayer().setSetting; },
  get ready() { return defaultLayer().ready; },
  get pool() { return defaultLayer().pool; },
};
