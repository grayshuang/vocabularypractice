const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { db, initDB, genId } = require('./database');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// JWT 中间件
function authMiddleware(req, res, next) {
  const token = req.headers['authorization']?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: '未登录' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'token 无效' });
  }
}

// ==================== 学生注册/登录 ====================

app.post('/api/student/register', async (req, res) => {
  const { username, password, email, student_type, class_code } = req.body;
  if (!username || !password || !email || !student_type) {
    return res.status(400).json({ error: '缺少必填字段' });
  }
  if (student_type === '班课' && !class_code) {
    return res.status(400).json({ error: '班课学生必须填写班号' });
  }
  await db.read();
  if (db.data.students.some(s => s.username === username || s.email === email)) {
    return res.status(400).json({ error: '用户名或邮箱已存在' });
  }
  const password_hash = bcrypt.hashSync(password, 10);
  const student = {
    id: genId(db.data.students),
    username, password_hash, email, student_type, class_code: class_code || null,
    created_at: new Date().toISOString()
  };
  db.data.students.push(student);
  await db.write();
  res.json({ message: '注册成功', studentId: student.id });
});

app.post('/api/student/login', async (req, res) => {
  const { username, password } = req.body;
  await db.read();
  const student = db.data.students.find(s => s.username === username);
  if (!student) return res.status(401).json({ error: '用户不存在' });
  if (!bcrypt.compareSync(password, student.password_hash)) {
    return res.status(401).json({ error: '密码错误' });
  }
  const token = jwt.sign({ id: student.id, type: 'student' }, process.env.JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, student: { id: student.id, username: student.username, student_type: student.student_type, class_code: student.class_code } });
});

// ==================== 教师注册/登录 ====================

app.post('/api/teacher/register', async (req, res) => {
  const { username, password, email } = req.body;
  if (!username || !password || !email) return res.status(400).json({ error: '缺少必填字段' });
  await db.read();
  if (db.data.teachers.some(t => t.username === username || t.email === email)) {
    return res.status(400).json({ error: '用户名或邮箱已存在' });
  }
  const teacher = {
    id: genId(db.data.teachers), username,
    password_hash: bcrypt.hashSync(password, 10), email,
    created_at: new Date().toISOString()
  };
  db.data.teachers.push(teacher);
  await db.write();
  res.json({ message: '注册成功', teacherId: teacher.id });
});

app.post('/api/teacher/login', async (req, res) => {
  const { username, password } = req.body;
  await db.read();
  const teacher = db.data.teachers.find(t => t.username === username);
  if (!teacher) return res.status(401).json({ error: '用户不存在' });
  if (!bcrypt.compareSync(password, teacher.password_hash)) {
    return res.status(401).json({ error: '密码错误' });
  }
  const token = jwt.sign({ id: teacher.id, type: 'teacher' }, process.env.JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, teacher: { id: teacher.id, username: teacher.username } });
});

// ==================== 管理员登录 ====================

app.post('/api/admin/login', async (req, res) => {
  const { username, password } = req.body;
  await db.read();
  const admin = db.data.admins.find(a => a.username === username);
  if (!admin) return res.status(401).json({ error: '用户不存在' });
  if (!bcrypt.compareSync(password, admin.password_hash)) {
    return res.status(401).json({ error: '密码错误' });
  }
  const token = jwt.sign({ id: admin.id, type: 'admin' }, process.env.JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, admin: { id: admin.id, username: admin.username } });
});

// ==================== 房间管理 ====================

app.post('/api/room/create', authMiddleware, async (req, res) => {
  if (req.user.type !== 'teacher') return res.status(403).json({ error: '无权限' });
  await db.read();
  const room_code = Math.floor(100000 + Math.random() * 900000).toString();
  const room = { id: genId(db.data.rooms), room_code, teacher_id: req.user.id, vocabulary_list: null, created_at: new Date().toISOString() };
  db.data.rooms.push(room);
  await db.write();
  res.json({ message: '房间创建成功', room_code, roomId: room.id });
});

app.get('/api/teacher/rooms', authMiddleware, async (req, res) => {
  if (req.user.type !== 'teacher') return res.status(403).json({ error: '无权限' });
  await db.read();
  const rooms = db.data.rooms.filter(r => r.teacher_id === req.user.id);
  res.json(rooms);
});

app.post('/api/room/join', authMiddleware, async (req, res) => {
  if (req.user.type !== 'student') return res.status(403).json({ error: '无权限' });
  const { room_code } = req.body;
  await db.read();
  const room = db.data.rooms.find(r => r.room_code === room_code);
  if (!room) return res.status(404).json({ error: '房间不存在' });
  const exists = db.data.studentRooms.some(sr => sr.student_id === req.user.id && sr.room_id === room.id);
  if (!exists) {
    db.data.studentRooms.push({ id: genId(db.data.studentRooms), student_id: req.user.id, room_id: room.id, joined_at: new Date().toISOString() });
    await db.write();
  }
  res.json({ message: '加入房间成功', roomId: room.id });
});

// ==================== 练习记录 ====================

app.post('/api/practice/start', authMiddleware, async (req, res) => {
  if (req.user.type !== 'student') return res.status(403).json({ error: '无权限' });
  const { room_id, mode_type } = req.body;
  await db.read();
  const session = {
    id: genId(db.data.practiceSessions), student_id: req.user.id, room_id, mode_type,
    score: null, total_questions: 0, correct_count: 0,
    started_at: new Date().toISOString(), finished_at: null
  };
  db.data.practiceSessions.push(session);
  await db.write();
  res.json({ sessionId: session.id });
});

app.post('/api/practice/answer', authMiddleware, async (req, res) => {
  if (req.user.type !== 'student') return res.status(403).json({ error: '无权限' });
  const { session_id, question, student_answer, correct_answer, word, is_correct } = req.body;
  await db.read();
  db.data.practiceAnswers.push({
    id: genId(db.data.practiceAnswers), session_id, question, student_answer, correct_answer, word,
    is_correct: is_correct ? 1 : 0, answered_at: new Date().toISOString()
  });
  // 更新单词统计
  if (word) await updateWordStats(req.user.id, session_id, word, is_correct);
  await db.write();
  res.json({ message: '答案已记录' });
});

app.post('/api/practice/finish', authMiddleware, async (req, res) => {
  if (req.user.type !== 'student') return res.status(403).json({ error: '无权限' });
  const { session_id, score, total_questions, correct_count } = req.body;
  await db.read();
  const session = db.data.practiceSessions.find(s => s.id === session_id);
  if (session) {
    session.score = score; session.total_questions = total_questions;
    session.correct_count = correct_count; session.finished_at = new Date().toISOString();
    await db.write();
  }
  res.json({ message: '练习会话已结束' });
});

async function updateWordStats(student_id, session_id, word, is_correct) {
  await db.read();
  const session = db.data.practiceSessions.find(s => s.id === session_id);
  if (!session) return;
  const stat = db.data.wordStats.find(ws => ws.student_id === student_id && ws.room_id === session.room_id && ws.word === word);
  if (stat) {
    stat.total_attempts += 1;
    if (!is_correct) stat.error_count += 1;
    stat.error_rate = parseFloat(((stat.error_count / stat.total_attempts) * 100).toFixed(2));
    stat.updated_at = new Date().toISOString();
  } else {
    db.data.wordStats.push({
      id: genId(db.data.wordStats), student_id, room_id: session.room_id, word,
      pos: null, error_count: is_correct ? 0 : 1, total_attempts: 1,
      error_rate: is_correct ? 0 : 100, updated_at: new Date().toISOString()
    });
  }
  await db.write();
}

// ==================== 教师数据查询 ====================

app.get('/api/teacher/room/:roomId/students', authMiddleware, async (req, res) => {
  if (req.user.type !== 'teacher') return res.status(403).json({ error: '无权限' });
  await db.read();
  const roomId = parseInt(req.params.roomId);
  const studentIds = db.data.studentRooms.filter(sr => sr.room_id === roomId).map(sr => sr.student_id);
  const students = db.data.students.filter(s => studentIds.includes(s.id)).map(s => {
    const sessions = db.data.practiceSessions.filter(ps => ps.student_id === s.id && ps.room_id === roomId);
    const avgScore = sessions.length > 0 ? sessions.reduce((a, b) => a + (b.score || 0), 0) / sessions.length : 0;
    return { ...s, practice_count: sessions.length, avg_score: parseFloat(avgScore.toFixed(2)) };
  });
  res.json(students);
});

app.get('/api/teacher/room/:roomId/word-stats', authMiddleware, async (req, res) => {
  if (req.user.type !== 'teacher') return res.status(403).json({ error: '无权限' });
  await db.read();
  const roomId = parseInt(req.params.roomId);
  const stats = db.data.wordStats.filter(ws => ws.room_id === roomId).sort((a, b) => b.error_rate - a.error_rate);
  res.json(stats);
});

// ==================== 管理员功能 ====================

app.get('/api/admin/teachers', authMiddleware, async (req, res) => {
  if (req.user.type !== 'admin') return res.status(403).json({ error: '无权限' });
  await db.read();
  res.json(db.data.teachers);
});

app.get('/api/admin/students', authMiddleware, async (req, res) => {
  if (req.user.type !== 'admin') return res.status(403).json({ error: '无权限' });
  await db.read();
  res.json(db.data.students);
});

// ==================== 启动服务器 ====================

initDB().then(() => {
  app.listen(PORT, () => console.log(`服务器运行在 http://localhost:${PORT}`));
});
