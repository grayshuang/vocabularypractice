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


// ==================== 直接写入（绕过整库 TRUNCATE，用于注册等核心写操作）====================

/**
 * 直接插入/更新单条学生记录（不触发全表 TRUNCATE，立即落盘）。
 * 用于注册这类「绝不允许丢失」的核心写操作。
 */
async function pgDirectUpsertStudent(s) {
  if (!pool) throw new Error('PG 未初始化');
  const client = await pool.connect();
  try {
    const res = await client.query(
      `INSERT INTO students (id, name, username, password_hash, email, student_type, class_code, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (username) DO UPDATE SET
         name=EXCLUDED.name, password_hash=EXCLUDED.password_hash, email=EXCLUDED.email,
         student_type=EXCLUDED.student_type, class_code=EXCLUDED.class_code, created_at=EXCLUDED.created_at
       RETURNING id`,
      [s.id, s.name, s.username, s.password_hash, s.email, s.student_type, s.class_code, s.created_at]
    );
    return res.rows[0] ? res.rows[0].id : s.id;
  } finally {
    client.release();
  }
}

/**
 * 直接插入/更新单条教师记录（同上，绕过 TRUNCATE）。
 */
async function pgDirectUpsertTeacher(t) {
  if (!pool) throw new Error('PG 未初始化');
  const client = await pool.connect();
  try {
    const res = await client.query(
      `INSERT INTO teachers (id, name, username, password_hash, email, created_at, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (username) DO UPDATE SET
         name=EXCLUDED.name, password_hash=EXCLUDED.password_hash, email=EXCLUDED.email,
         created_at=EXCLUDED.created_at, is_active=EXCLUDED.is_active
       RETURNING id`,
      [t.id, t.name, t.username, t.password_hash, t.email, t.created_at, t.is_active ?? true]
    );
    return res.rows[0] ? res.rows[0].id : t.id;
  } finally {
    client.release();
  }
}

/**
 * 直接按邮箱更新教师密码（绕过 TRUNCATE 快照）。
 */
async function pgDirectUpdateTeacherPassword(email, hash) {
  if (!pool) throw new Error('PG 未初始化');
  const client = await pool.connect();
  try {
    await client.query('UPDATE teachers SET password_hash = $1 WHERE LOWER(TRIM(email)) = LOWER(TRIM($2))', [hash, email]);
  } finally {
    client.release();
  }
}

/**
 * 直接按邮箱更新学生密码（绕过 TRUNCATE 快照）。
 */
async function pgDirectUpdateStudentPassword(email, hash) {
  if (!pool) throw new Error('PG 未初始化');
  const client = await pool.connect();
  try {
    await client.query('UPDATE students SET password_hash = $1 WHERE LOWER(TRIM(email)) = LOWER(TRIM($2))', [hash, email]);
  } finally {
    client.release();
  }
}

/**
 * 直接插入单条 student_rooms 记录（绕过 TRUNCATE 快照）。
 */
async function pgDirectInsertStudentRoom(sr) {
  if (!pool) throw new Error('PG 未初始化');
  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO student_rooms (id, student_id, room_id, joined_at, note)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (student_id, room_id) DO NOTHING`,
      [sr.id, sr.student_id, sr.room_id, sr.joined_at, sr.note || '']
    );
  } finally {
    client.release();
  }
}

// ==================== 增量直写函数（持久化主力，绝不全表 TRUNCATE）====================
// 设计原则：每个写路径在修改内存缓存（writeDB）后，额外调用对应的增量直写函数，
// 把变更精确落地到 PG（UPSERT / INSERT / UPDATE / DELETE）。数据只增不减，
// 重新部署后从 PG 读回完整数据，账号/房间/练习记录永不丢失。

async function bumpSeq(client, table) {
  try {
    await client.query(`SELECT setval('${table}_id_seq', COALESCE((SELECT MAX(id) FROM ${table}), 0))`);
  } catch (e) { /* 序列不存在时忽略 */ }
}

async function pgDirectUpsertRoom(room) {
  if (!pool) throw new Error('PG 未初始化');
  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO rooms (id, room_code, teacher_id, vocabulary_list, practice_modes, mode_word_map, level, created_at)
       VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,$8)
       ON CONFLICT (id) DO UPDATE SET
         room_code=EXCLUDED.room_code, teacher_id=EXCLUDED.teacher_id,
         vocabulary_list=EXCLUDED.vocabulary_list, practice_modes=EXCLUDED.practice_modes,
         mode_word_map=EXCLUDED.mode_word_map, level=EXCLUDED.level
       RETURNING id`,
      [room.id, room.room_code, room.teacher_id, JSON.stringify(room.vocabulary_list), JSON.stringify(room.practice_modes || []), JSON.stringify(room.mode_word_map || {}), room.level || '6', room.created_at]
    );
    await bumpSeq(client, 'rooms');
  } finally { client.release(); }
}

async function pgDirectDeleteRoomCascade(roomId) {
  if (!pool) throw new Error('PG 未初始化');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM practice_answers WHERE session_id IN (SELECT id FROM practice_sessions WHERE room_id=$1)', [roomId]);
    await client.query('DELETE FROM practice_sessions WHERE room_id=$1', [roomId]);
    await client.query('DELETE FROM word_stats WHERE room_id=$1', [roomId]);
    await client.query('DELETE FROM student_progress WHERE room_id=$1', [roomId]);
    await client.query('DELETE FROM student_rooms WHERE room_id=$1', [roomId]);
    await client.query('DELETE FROM rooms WHERE id=$1', [roomId]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally { client.release(); }
}

async function pgDirectUpdateStudentRoomNote(student_id, room_id, note) {
  if (!pool) throw new Error('PG 未初始化');
  const client = await pool.connect();
  try {
    await client.query('UPDATE student_rooms SET note=$1 WHERE student_id=$2 AND room_id=$3', [note || '', student_id, room_id]);
  } finally { client.release(); }
}

async function pgDirectDeleteStudentRoom(student_id, room_id) {
  if (!pool) throw new Error('PG 未初始化');
  const client = await pool.connect();
  try {
    await client.query('DELETE FROM student_rooms WHERE student_id=$1 AND room_id=$2', [student_id, room_id]);
  } finally { client.release(); }
}

async function pgDirectInsertSession(session) {
  if (!pool) throw new Error('PG 未初始化');
  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO practice_sessions (id, student_id, room_id, mode_type, score, total_questions, correct_count, elapsed_time, pause_count, started_at, finished_at, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (id) DO UPDATE SET student_id=EXCLUDED.student_id, room_id=EXCLUDED.room_id, mode_type=EXCLUDED.mode_type, started_at=EXCLUDED.started_at
       RETURNING id`,
      [session.id, session.student_id, session.room_id, session.mode_type, session.score, session.total_questions, session.correct_count, session.elapsed_time, session.pause_count, session.started_at, session.finished_at, session.note || '']
    );
    await bumpSeq(client, 'practice_sessions');
  } finally { client.release(); }
}

async function pgDirectUpdateSessionFinish(session) {
  if (!pool) throw new Error('PG 未初始化');
  const client = await pool.connect();
  try {
    await client.query(
      `UPDATE practice_sessions SET score=$1, total_questions=$2, correct_count=$3, elapsed_time=$4, pause_count=$5, finished_at=$6 WHERE id=$7`,
      [session.score, session.total_questions, session.correct_count, session.elapsed_time, session.pause_count, session.finished_at, session.id]
    );
  } finally { client.release(); }
}

async function pgDirectUpdateSessionNote(sessionId, note) {
  if (!pool) throw new Error('PG 未初始化');
  const client = await pool.connect();
  try {
    await client.query('UPDATE practice_sessions SET note=$1 WHERE id=$2', [note || '', sessionId]);
  } finally { client.release(); }
}

async function pgDirectDeleteSession(sessionId) {
  if (!pool) throw new Error('PG 未初始化');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM practice_answers WHERE session_id=$1', [sessionId]);
    await client.query('DELETE FROM practice_sessions WHERE id=$1', [sessionId]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally { client.release(); }
}

async function pgDirectInsertAnswer(answer) {
  if (!pool) throw new Error('PG 未初始化');
  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO practice_answers (id, session_id, question, student_answer, correct_answer, word, uid, is_correct, answered_at)
       VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [answer.id, answer.session_id, JSON.stringify(answer.question), answer.student_answer, answer.correct_answer, answer.word, answer.uid, answer.is_correct, answer.answered_at]
    );
    await bumpSeq(client, 'practice_answers');
  } finally { client.release(); }
}

async function pgDirectUpsertWordStat(stat) {
  if (!pool) throw new Error('PG 未初始化');
  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO word_stats (id, student_id, room_id, word, pos, error_count, total_attempts, error_rate, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (student_id, room_id, word) DO UPDATE SET
         error_count=EXCLUDED.error_count, total_attempts=EXCLUDED.total_attempts, error_rate=EXCLUDED.error_rate, updated_at=EXCLUDED.updated_at
       RETURNING id`,
      [stat.id, stat.student_id, stat.room_id, stat.word, stat.pos, stat.error_count, stat.total_attempts, stat.error_rate, stat.updated_at]
    );
    await bumpSeq(client, 'word_stats');
  } finally { client.release(); }
}

async function pgDirectInsertProgress(progress) {
  if (!pool) throw new Error('PG 未初始化');
  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO student_progress (id, student_id, room_id, word, mode, is_correct, answered_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [progress.id, progress.student_id, progress.room_id, progress.word, progress.mode, progress.is_correct, progress.answered_at]
    );
    await bumpSeq(client, 'student_progress');
  } finally { client.release(); }
}

async function pgDirectUpsertWordBank(entry) {
  if (!pool) throw new Error('PG 未初始化');
  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO word_bank (id, word, level, pos, sentence, options, correct_answer, topic, template, chinese, definition, option_defs, topic_category)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12::jsonb,$13)
       ON CONFLICT (word, level) DO UPDATE SET
         pos=EXCLUDED.pos, sentence=EXCLUDED.sentence, options=EXCLUDED.options, correct_answer=EXCLUDED.correct_answer,
         topic=EXCLUDED.topic, template=EXCLUDED.template, chinese=EXCLUDED.chinese, definition=EXCLUDED.definition,
         option_defs=EXCLUDED.option_defs, topic_category=EXCLUDED.topic_category
       RETURNING id`,
      [entry.id, entry.word, entry.level, entry.pos, entry.sentence, JSON.stringify(entry.options), entry.correct_answer, entry.topic, entry.template, entry.chinese, entry.definition, JSON.stringify(entry.option_defs), entry.topic_category]
    );
    await bumpSeq(client, 'word_bank');
  } finally { client.release(); }
}

async function pgDirectUpsertModeUsage(key, count) {
  if (!pool) throw new Error('PG 未初始化');
  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO mode_usage (key, count) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET count=$2`,
      [key, count]
    );
  } finally { client.release(); }
}

async function pgDirectUpdateTeacherStatus(id, is_active) {
  if (!pool) throw new Error('PG 未初始化');
  const client = await pool.connect();
  try {
    await client.query('UPDATE teachers SET is_active=$1 WHERE id=$2', [is_active, id]);
  } finally { client.release(); }
}

/**
 * 直接从 PG 查询某学生的已完结练习历史（绕过内存缓存）。
 * 用于 history 接口的 fallback：当内存缓存为空/缺失时，确保不丢失 PG 中真实存在的数据。
 */
async function pgDirectGetStudentHistory(studentId) {
  if (!pool) return [];
  try {
    const rows = await pgQuery(
      `SELECT ps.id, ps.student_id, ps.room_id, ps.mode_type, ps.score,
              ps.total_questions, ps.correct_count, ps.finished_at,
              COALESCE(ps.note, '') AS note, r.room_code
       FROM practice_sessions ps
       LEFT JOIN rooms r ON r.id = ps.room_id
       WHERE ps.student_id = $1 AND ps.finished_at IS NOT NULL
       ORDER BY ps.finished_at DESC`,
      [studentId]
    );
    return rows.map(r => ({
      session_id: r.id,
      student_id: r.student_id,
      room_id: r.room_id,
      room_code: r.room_code || '未知',
      mode_type: r.mode_type,
      score: r.score,
      total_questions: r.total_questions,
      correct_count: r.correct_count,
      finished_at: r.finished_at,
      note: r.note || ''
    }));
  } catch (e) {
    console.error('⚠️ PG 直查学生历史失败：', e.message);
    return [];
  }
}

// ==================== 统一对外接口（与原 API 完全兼容）====================

function readDB() {
  // 同步读取（兼容现有代码），PG 模式下只返回 PG 缓存
  if (pgReady) {
    // ⚠️ 关键防护：PG 模式下绝不回退到 jsonRead() 的默认模板（含预置 admin），
    // 否则一次空写回会触发 pgWriteAll 的 TRUNCATE，清空整库数据。
    if (!_cachedDB) {
      _cachedDB = {
        admins: [], teachers: [], students: [], rooms: [],
        studentRooms: [], practiceSessions: [], practiceAnswers: [],
        wordStats: [], wordBank: [], studentProgress: [], modeUsage: {}
      };
    }
    return _cachedDB;
  }
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
  // 【重要】PG 模式下：writeDB 只更新内存缓存，不做任何落盘。
  // 真正的持久化由各端点的「增量直写函数」（pgDirectXxx）完成。
  // 历史版本会触发 pgWriteAll 对全库 11 张表执行 TRUNCATE 后按内存缓存重插，
  // 一旦内存缓存在部署/重启/多实例并存瞬间不完整，就会用旧快照把账号全量覆盖清空。
  // 现彻底禁用全表 TRUNCATE 回写，改为纯增量 UPSERT/INSERT/UPDATE/DELETE，数据只增不减，永不丢失。
  if (pgReady && pool) {
    _cachedDB = data; // 仅更新内存缓存，供同步读（readDB）使用
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
let _cacheLoaded = false; // ✅ 防护：initDB 成功从 PG 加载数据后才置 true

/**
 * 危险空写检测：teachers / students / rooms 三张核心表同时为空时，
 * 几乎必然是缓存损坏（而非真实业务），此时绝对不允许 TRUNCATE 写回，
 * 否则会一次性清空整个数据库。
 */
function _isDangerousEmpty(data) {
  if (!data) return true;
  const t = (data.teachers || []).length;
  const s = (data.students || []).length;
  const r = (data.rooms || []).length;
  return t === 0 && s === 0 && r === 0;
}

// ⚠️ 已废弃：全表 TRUNCATE 回写机制（pgWriteAll）是数据丢失的根源，已彻底禁用。
// 现持久化完全由各端点的增量直写函数（pgDirectXxx）完成，数据只增/改/删，绝不被缓存快照整体覆盖。
// 保留以下函数签名仅为兼容潜在引用，内部不再执行任何 TRUNCATE 写回。
function _scheduleFlush() {
  // 故意空操作：不再触发 pgWriteAll 的全表 TRUNCATE 重写。
}
async function flushDB() {
  // 故意空操作：持久化已由增量直写函数负责，无需全量回写。
}

async function initDB() {
  if (USE_PG && pool) {
    const maxRetries = 5;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await ensureTables();
        pgReady = true;
        _cachedDB = await pgReadAll();
        _cacheLoaded = true; // ✅ 数据已从 PG 真实加载，允许后续 writeDB
        console.log(`✅ 数据库已连接（PostgreSQL），缓存 ${Object.keys(_cachedDB).length} 张表`);
        console.log('超级管理员账号: admin / admin123456');
        return;
      } catch (e) {
        console.error(`❌ PostgreSQL 连接失败（第 ${attempt}/${maxRetries} 次）：`, e.message);
        pgReady = false;
        if (attempt < maxRetries) {
          await new Promise(r => setTimeout(r, 2000));
        }
      }
    }
    console.error('⚠️ PostgreSQL 多次连接失败，回退到 JSON 文件模式（数据将不持久化，请检查 DATABASE_URL 是否正确）');
    console.log('超级管理员账号: admin / admin123456');
  } else {
    jsonRead(); // 触发初始化
    console.log('数据库连接成功（JSON文件）');
    console.log('超级管理员账号: admin / admin123456');
  }
}

module.exports = { readDB, readDBAsync, writeDB, genId, initDB, flushDB, pgDirectUpsertStudent, pgDirectUpsertTeacher, pgDirectUpdateTeacherPassword, pgDirectUpdateStudentPassword, pgDirectInsertStudentRoom, pgDirectUpsertRoom, pgDirectDeleteRoomCascade, pgDirectUpdateStudentRoomNote, pgDirectDeleteStudentRoom, pgDirectInsertSession, pgDirectUpdateSessionFinish, pgDirectUpdateSessionNote, pgDirectDeleteSession, pgDirectInsertAnswer, pgDirectUpsertWordStat, pgDirectInsertProgress, pgDirectUpsertWordBank, pgDirectUpsertModeUsage, pgDirectUpdateTeacherStatus, pgDirectGetStudentHistory, isPG: () => pgReady };
