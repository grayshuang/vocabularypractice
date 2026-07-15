const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

// ── 双模式数据库引擎 ──
// DATABASE_URL 环境变量存在 → PostgreSQL（生产/Railway）
// 否则 → 本地 JSON 文件（开发）

const USE_PG = !!process.env.DATABASE_URL;

let pool = null;
let pgReady = false;

// ── 表名常量（与 JSON 字段名一一对应） ──
const TABLES = [
  'admins', 'teachers', 'students', 'rooms',
  'student_rooms', 'practice_sessions', 'practice_answers',
  'word_stats', 'word_bank', 'student_progress', 'mode_usage'
];

if (USE_PG) {
  try {
    const { Pool } = require('pg');
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
    });
    pool.on('error', (err) => console.error('PostgreSQL 连接池意外错误:', err.message));
  } catch (e) {
    console.error('加载 pg 模块失败，回退到 JSON 文件模式:', e.message);
    // fallback 到 JSON
  }
}

// ==================== PostgreSQL 引擎 ====================

/**
 * 执行原始 SQL（自动重连）
 */
async function pgQuery(sql, params = []) {
  if (!pool) throw new Error('PG 未初始化');
  const client = await pool.connect();
  try {
    const res = await client.query(sql, params);
    return res.rows;
  } finally {
    client.release();
  }
}

/**
 * 建表（幂等，重复执行不报错）
 * 所有字段用 JSONB 存储复杂对象（vocabulary_list, mode_word_map 等）
 * id 用 SERIAL 自增
 */
async function ensureTables() {
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS admins (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL
    )
  `);
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS teachers (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      is_active BOOLEAN DEFAULT true
    )
  `);
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS students (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      student_type TEXT NOT NULL,
      class_code TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS rooms (
      id SERIAL PRIMARY KEY,
      room_code TEXT NOT NULL UNIQUE,
      teacher_id INTEGER NOT NULL,
      vocabulary_list JSONB,
      practice_modes JSONB DEFAULT '[]',
      mode_word_map JSONB DEFAULT '{}',
      level TEXT DEFAULT '6',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS student_rooms (
      id SERIAL PRIMARY KEY,
      student_id INTEGER NOT NULL,
      room_id INTEGER NOT NULL,
      joined_at TIMESTAMPTZ DEFAULT NOW(),
      note TEXT DEFAULT '',
      UNIQUE(student_id, room_id)
    )
  `);
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS practice_sessions (
      id SERIAL PRIMARY KEY,
      student_id INTEGER NOT NULL,
      room_id INTEGER NOT NULL,
      mode_type TEXT,
      score REAL,
      total_questions INTEGER DEFAULT 0,
      correct_count INTEGER DEFAULT 0,
      elapsed_time INTEGER DEFAULT 0,
      pause_count INTEGER DEFAULT 0,
      started_at TIMESTAMPTZ DEFAULT NOW(),
      finished_at TIMESTAMPTZ
    )
  `);
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS practice_answers (
      id SERIAL PRIMARY KEY,
      session_id INTEGER NOT NULL,
      question JSONB,
      student_answer TEXT,
      correct_answer TEXT,
      word TEXT,
      uid TEXT,
      is_correct SMALLINT DEFAULT 0,
      answered_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS word_stats (
      id SERIAL PRIMARY KEY,
      student_id INTEGER NOT NULL,
      room_id INTEGER NOT NULL,
      word TEXT NOT NULL,
      pos TEXT,
      error_count INTEGER DEFAULT 0,
      total_attempts INTEGER DEFAULT 1,
      error_rate REAL DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(student_id, room_id, word)
    )
  `);
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS word_bank (
      id SERIAL PRIMARY KEY,
      word TEXT NOT NULL,
      level TEXT DEFAULT '6',
      pos TEXT,
      sentence TEXT,
      options JSONB,
      correct_answer TEXT,
      topic TEXT,
      template TEXT,
      chinese TEXT,
      definition TEXT,
      option_defs JSONB,
      topic_category TEXT,
      UNIQUE(word, level)
    )
  `);
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS student_progress (
      id SERIAL PRIMARY KEY,
      student_id INTEGER NOT NULL,
      room_id INTEGER NOT NULL,
      word TEXT NOT NULL,
      mode TEXT,
      is_correct SMALLINT DEFAULT 0,
      answered_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS mode_usage (
      key TEXT PRIMARY KEY,
      count INTEGER DEFAULT 1
    )
  `);

  // 初始化默认管理员（如果不存在）
  const admins = await pgQuery('SELECT * FROM admins LIMIT 1');
  if (admins.length === 0) {
    const hash = bcrypt.hashSync('admin123456', 10);
    await pgQuery("INSERT INTO admins (username, password_hash) VALUES ($1, $2)", ['admin', hash]);
  }

  console.log('✅ PostgreSQL 表结构就绪（所有表已创建/验证）');
}

// 行→对象转换辅助函数
function rowToAdmin(r) { return { id: r.id, username: r.username, password_hash: r.password_hash }; }
function rowToTeacher(r) { return { id: r.id, name: r.name, username: r.username, password_hash: r.password_hash, email: r.email, created_at: r.created_at, is_active: r.is_active }; }
function rowToStudent(r) { return { id: r.id, name: r.name, username: r.username, password_hash: r.password_hash, email: r.email, student_type: r.student_type, class_code: r.class_code, created_at: r.created_at }; }
function rowToRoom(r) { return { id: r.id, room_code: r.room_code, teacher_id: r.teacher_id, vocabulary_list: r.vocabulary_list, practice_modes: r.practice_modes, mode_word_map: r.mode_word_map, level: r.level, created_at: r.created_at }; }
function rowToStudentRoom(r) { return { id: r.id, student_id: r.student_id, room_id: r.room_id, joined_at: r.joined_at, note: r.note }; }
function rowToSession(r) { return { id: r.id, student_id: r.student_id, room_id: r.room_id, mode_type: r.mode_type, score: r.score, total_questions: r.total_questions, correct_count: r.correct_count, elapsed_time: r.elapsed_time, pause_count: r.pause_count, started_at: r.started_at, finished_at: r.finished_at, note: r.note }; }
function rowToAnswer(r) { return { id: r.id, session_id: r.session_id, question: r.question, student_answer: r.student_answer, correct_answer: r.correct_answer, word: r.word, uid: r.uid, is_correct: r.is_correct, answered_at: r.answered_at }; }
function rowToWordStat(r) { return { id: r.id, student_id: r.student_id, room_id: r.room_id, word: r.word, pos: r.pos, error_count: r.error_count, total_attempts: r.total_attempts, error_rate: r.error_rate, updated_at: r.updated_at }; }
function rowToWordBank(r) { return { id: r.id, word: r.word, level: r.level, pos: r.pos, sentence: r.sentence, options: r.options, correct_answer: r.correct_answer, topic: r.topic, template: r.template, chinese: r.chinese, definition: r.definition, option_defs: r.option_defs, topic_category: r.topic_category }; }
function rowToProgress(r) { return { id: r.id, student_id: r.student_id, room_id: r.room_id, word: r.word, mode: r.mode, is_correct: r.is_correct, answered_at: r.answered_at }; }

/**
 * PG 模式：从所有表读取数据，组装成与 JSON 文件格式一致的对象
 */
async function pgReadAll() {
  const [admins, teachers, students, rooms, studentRooms, sessions, answers, wordStats, wordBank, progress, modeUsageRows] = await Promise.all([
    pgQuery('SELECT * FROM admins ORDER BY id'),
    pgQuery('SELECT * FROM teachers ORDER BY id'),
    pgQuery('SELECT * FROM students ORDER BY id'),
    pgQuery('SELECT * FROM rooms ORDER BY id'),
    pgQuery('SELECT * FROM student_rooms ORDER BY id'),
    pgQuery('SELECT * FROM practice_sessions ORDER BY id'),
    pgQuery('SELECT * FROM practice_answers ORDER BY id'),
    pgQuery('SELECT * FROM word_stats ORDER BY id'),
    pgQuery('SELECT * FROM word_bank ORDER BY id'),
    pgQuery('SELECT * FROM student_progress ORDER BY id'),
    pgQuery('SELECT * FROM mode_usage'),
  ]);

  const modeUsage = {};
  for (const r of modeUsageRows) modeUsage[r.key] = r.count;

  return {
    admins: admins.map(rowToAdmin),
    teachers: teachers.map(rowToTeacher),
    students: students.map(rowToStudent),
    rooms: rooms.map(rowToRoom),
    studentRooms: studentRooms.map(rowToStudentRoom),
    practiceSessions: sessions.map(rowToSession),
    practiceAnswers: answers.map(rowToAnswer),
    wordStats: wordStats.map(rowToWordStat),
    wordBank: wordBank.map(rowToWordBank),
    studentProgress: progress.map(rowToProgress),
    modeUsage
  };
}

/**
 * PG 模式：将完整数据对象写入所有表（全量同步）
 * 策略：truncate 每张表后批量插入（简单可靠，数据量不大时够用）
 */
async function pgWriteAll(data) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 清空所有数据表
    for (const t of TABLES) {
      await client.query(`TRUNCATE TABLE ${t} CASCADE`);
    }

    // 批量插入 admins
    for (const r of (data.admins || [])) {
      await client.query(
        'INSERT INTO admins (id, username, password_hash) VALUES ($1, $2, $3)',
        [r.id, r.username, r.password_hash]
      );
    }

    // 重置自增序列
    await client.query("SELECT setval('admins_id_seq', COALESCE((SELECT MAX(id) FROM admins), 0))");
    await client.query("SELECT setval('teachers_id_seq', COALESCE((SELECT MAX(id) FROM teachers), 0))");
    await client.query("SELECT setval('students_id_seq', COALESCE((SELECT MAX(id) FROM students), 0))");
    await client.query("SELECT setval('rooms_id_seq', COALESCE((SELECT MAX(id) FROM rooms), 0))");
    await client.query("SELECT setval('student_rooms_id_seq', COALESCE((SELECT MAX(id) FROM student_rooms), 0))");
    await client.query("SELECT setval('practice_sessions_id_seq', COALESCE((SELECT MAX(id) FROM practice_sessions), 0))");
    await client.query("SELECT setval('practice_answers_id_seq', COALESCE((SELECT MAX(id) FROM practice_answers), 0))");
    await client.query("SELECT setval('word_stats_id_seq', COALESCE((SELECT MAX(id) FROM word_stats), 0))");
    await client.query("SELECT setval('word_bank_id_seq', COALESCE((SELECT MAX(id) FROM word_bank), 0))");
    await client.query("SELECT setval('student_progress_id_seq', COALESCE((SELECT MAX(id) FROM student_progress), 0))");

    for (const r of (data.teachers || [])) {
      await client.query(
        `INSERT INTO teachers (id, name, username, password_hash, email, created_at, is_active)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [r.id, r.name, r.username, r.password_hash, r.email, r.created_at, r.is_active ?? true]
      );
    }
    for (const r of (data.students || [])) {
      await client.query(
        `INSERT INTO students (id, name, username, password_hash, email, student_type, class_code, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [r.id, r.name, r.username, r.password_hash, r.email, r.student_type, r.class_code, r.created_at]
      );
    }
    for (const r of (data.rooms || [])) {
      await client.query(
        `INSERT INTO rooms (id, room_code, teacher_id, vocabulary_list, practice_modes, mode_word_map, level, created_at)
         VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,$8)`,
        [r.id, r.room_code, r.teacher_id, JSON.stringify(r.vocabulary_list), JSON.stringify(r.practice_modes), JSON.stringify(r.mode_word_map || {}), r.level || '6', r.created_at]
      );
    }
    for (const r of (data.studentRooms || [])) {
      await client.query(
        `INSERT INTO student_rooms (id, student_id, room_id, joined_at, note)
         VALUES ($1,$2,$3,$4,$5)`,
        [r.id, r.student_id, r.room_id, r.joined_at, r.note || '']
      );
    }
    for (const r of (data.practiceSessions || [])) {
      await client.query(
        `INSERT INTO practice_sessions (id, student_id, room_id, mode_type, score, total_questions, correct_count, elapsed_time, pause_count, started_at, finished_at, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [r.id, r.student_id, r.room_id, r.mode_type, r.score, r.total_questions, r.correct_count, r.elapsed_time, r.pause_count, r.started_at, r.finished_at, r.note]
      );
    }
    for (const r of (data.practiceAnswers || [])) {
      await client.query(
        `INSERT INTO practice_answers (id, session_id, question, student_answer, correct_answer, word, uid, is_correct, answered_at)
         VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9)`,
        [r.id, r.session_id, JSON.stringify(r.question), r.student_answer, r.correct_answer, r.word, r.uid, r.is_correct, r.answered_at]
      );
    }
    for (const r of (data.wordStats || [])) {
      await client.query(
        `INSERT INTO word_stats (id, student_id, room_id, word, pos, error_count, total_attempts, error_rate, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (student_id, room_id, word) DO UPDATE SET
           error_count=EXCLUDED.error_count, total_attempts=EXCLUDED.total_attempts,
           error_rate=EXCLUDED.error_rate, updated_at=EXCLUDED.updated_at`,
        [r.id, r.student_id, r.room_id, r.word, r.pos, r.error_count, r.total_attempts, r.error_rate, r.updated_at]
      );
    }
    for (const r of (data.wordBank || [])) {
      await client.query(
        `INSERT INTO word_bank (id, word, level, pos, sentence, options, correct_answer, topic, template, chinese, definition, option_defs, topic_category)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12::jsonb,$13)
         ON CONFLICT (word, level) DO NOTHING`,
        [r.id, r.word, r.level, r.pos, r.sentence, JSON.stringify(r.options), r.correct_answer, r.topic, r.template, r.chinese, r.definition, JSON.stringify(r.option_defs), r.topic_category]
      );
    }
    for (const r of (data.studentProgress || [])) {
      await client.query(
        `INSERT INTO student_progress (id, student_id, room_id, word, mode, is_correct, answered_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [r.id, r.student_id, r.room_id, r.word, r.mode, r.is_correct, r.answered_at]
      );
    }
    const mu = data.modeUsage || {};
    for (const [key, count] of Object.entries(mu)) {
      await client.query(
        `INSERT INTO mode_usage (key, count) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET count = EXCLUDED.count`,
        [key, count]
      );
    }

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ==================== JSON 文件引擎（原有逻辑） ====================

const jsonDbPath = path.join(__dirname, 'db.json');

function jsonRead() {
  if (!fs.existsSync(jsonDbPath)) {
    const defaultData = {
      admins: [{ id: 1, username: 'admin', password_hash: bcrypt.hashSync('admin123456', 10) }],
      teachers: [],
      students: [],
      rooms: [],
      studentRooms: [],
      practiceSessions: [],
      practiceAnswers: [],
      wordStats: [],
      wordBank: [],
      studentProgress: [],
      modeUsage: {}
    };
    fs.writeFileSync(jsonDbPath, JSON.stringify(defaultData, null, 2));
    return defaultData;
  }
  return JSON.parse(fs.readFileSync(jsonDbPath, 'utf8'));
}

function jsonWrite(data) {
  fs.writeFileSync(jsonDbPath, JSON.stringify(data, null, 2));
}


// ==================== 统一对外接口（与原 API 完全兼容）====================

function readDB() {
  // 同步读取（兼容现有代码），PG 模式下返回缓存
  if (pgReady && _cachedDB) return _cachedDB;
  return jsonRead();
}

async function readDBAsync() {
  if (pgReady && pool) {
    _cachedDB = await pgReadAll();
    return _cachedDB;
  }
  return jsonRead();
}

function writeDB(data) {
  // 同步写入（兼容现有代码），PG 模式下标记脏数据异步刷盘
  if (pgReady && pool) {
    _dirtyData = data;
    _cachedDB = data; // 立即更新缓存，确保同一次请求内后续 readDB 拿到最新
    _scheduleFlush();
    return;
  }
  jsonWrite(data);
}

function genId(arr) {
  if (!arr || arr.length === 0) return 1;
  return Math.max(...arr.map(x => x.id)) + 1;
}

let _cachedDB = null;
let _dirtyData = null;
let _flushTimer = null;

function _scheduleFlush() {
  if (_flushTimer) return; // 已有定时器等待中
  _flushTimer = setTimeout(async () => {
    _flushTimer = null;
    if (_dirtyData && pool) {
      try {
        await pgWriteAll(_dirtyData);
        _dirtyData = null;
      } catch (e) {
        console.error('PostgreSQL 写入失败:', e.message);
      }
    }
  }, 100); // 100ms 批量合并写入
}

// 强制立即刷新（用于关键操作后确保持久化）
async function flushDB() {
  if (_flushTimer) {
    clearTimeout(_flushTimer);
    _flushTimer = null;
  }
  if (_dirtyData && pool) {
    await pgWriteAll(_dirtyData);
    _dirtyData = null;
  }
}

async function initDB() {
  if (USE_PG && pool) {
    try {
      await ensureTables();
      pgReady = true;
      _cachedDB = await pgReadAll();
      console.log(`✅ 数据库已连接（PostgreSQL），缓存 ${Object.keys(_cachedDB).length} 张表`);
      console.log('超级管理员账号: admin / admin123456');
    } catch (e) {
      console.error('❌ PostgreSQL 连接失败，回退到 JSON 文件:', e.message);
      pgReady = false;
      console.log('数据库连接成功（JSON文件）');
      console.log('超级管理员账号: admin / admin123456');
    }
  } else {
    jsonRead(); // 触发初始化
    console.log('数据库连接成功（JSON文件）');
    console.log('超级管理员账号: admin / admin123456');
  }
}

module.exports = { readDB, readDBAsync, writeDB, genId, initDB, flushDB, isPG: () => pgReady };
