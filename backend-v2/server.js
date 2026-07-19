const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const {
  readDB, writeDB, genId, initDB,
  pgDirectUpsertStudent, pgDirectUpsertTeacher,
  pgDirectUpdateTeacherPassword, pgDirectUpdateStudentPassword, pgDirectInsertStudentRoom,
  pgDirectUpsertRoom, pgDirectDeleteRoomCascade,
  pgDirectUpdateStudentRoomNote, pgDirectDeleteStudentRoom,
  pgDirectInsertSession, pgDirectUpdateSessionFinish, pgDirectUpdateSessionNote, pgDirectDeleteSession,
  pgDirectInsertAnswer, pgDirectUpsertWordStat, pgDirectInsertProgress,
  pgDirectUpsertWordBank, pgDirectUpsertModeUsage, pgDirectUpdateTeacherStatus
} = require('./database');
require('dotenv').config();

const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY || 'sk-ws-H.EMMRIEX.5Rcs.MEQCIDw9eY2qhOVq71hfdD5QOk9SFUhlMWyuPm6Wk1OJfQf6AiB1A5598ZiNIUk_IJtB7gnk8V5OjZjoDW9thE9fR5o5UQ';
const JWT_SECRET = process.env.JWT_SECRET || 'vocab-practice-default-secret-change-me';
const DASHSCOPE_API_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

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
  const { name, username, password, email, student_type, class_code } = req.body;
  if (!name || !username || !password || !email || !student_type) {
    return res.status(400).json({ error: '缺少必填字段' });
  }
  if (student_type === '班课' && !class_code) {
    return res.status(400).json({ error: '班课学生必须填写班号' });
  }
  const db = readDB();
  if (db.students.some(s => s.username === username || s.email === email)) {
    return res.status(400).json({ error: '用户名或邮箱已存在' });
  }
  const student = {
    id: genId(db.students), name, username,
    password_hash: bcrypt.hashSync(password, 10), email,
    student_type, class_code: class_code || null,
    created_at: new Date().toISOString()
  };
  db.students.push(student);
  writeDB(db);
  // 直接落盘，绕过异步 TRUNCATE 快照（防止注册数据在 100ms 缓冲期内因重启/报错丢失）
  try {
    await pgDirectUpsertStudent(student);
  } catch (e) {
    console.error('⚠️ 学生注册直写 PG 失败：', e.message);
  }
  res.json({ message: '注册成功', studentId: student.id });
});

app.post('/api/student/login', (req, res) => {
  const { username, password } = req.body;
  const db = readDB();
  const student = db.students.find(s => s.username === username);
  if (!student) return res.status(401).json({ error: '用户不存在' });
  if (!bcrypt.compareSync(password, student.password_hash)) {
    return res.status(401).json({ error: '密码错误' });
  }
  const token = jwt.sign({ id: student.id, type: 'student' }, process.env.JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, student: { id: student.id, name: student.name, username: student.username, student_type: student.student_type, class_code: student.class_code } });
});

// ==================== 教师注册/登录 ====================

app.post('/api/teacher/register', async (req, res) => {
  const { name, username, password, email } = req.body;
  if (!name || !username || !password || !email) return res.status(400).json({ error: '缺少必填字段' });
  const db = readDB();
  if (db.teachers.some(t => t.username === username || t.email === email)) {
    return res.status(400).json({ error: '用户名或邮箱已存在' });
  }
  const teacher = {
    id: genId(db.teachers), name, username,
    password_hash: bcrypt.hashSync(password, 10), email,
    created_at: new Date().toISOString()
  };
  db.teachers.push(teacher);
  writeDB(db);
  // 直接落盘，绕过异步 TRUNCATE 快照（防止注册数据在 100ms 缓冲期内因重启/报错丢失）
  try {
    await pgDirectUpsertTeacher(teacher);
  } catch (e) {
    console.error('⚠️ 教师注册直写 PG 失败：', e.message);
  }
  res.json({ message: '注册成功', teacherId: teacher.id });
});

app.post('/api/teacher/login', (req, res) => {
  const { username, password } = req.body;
  const db = readDB();
  const teacher = db.teachers.find(t => t.username === username);
  if (!teacher) return res.status(401).json({ error: '用户不存在' });
  if (!bcrypt.compareSync(password, teacher.password_hash)) {
    return res.status(401).json({ error: '密码错误' });
  }
  const token = jwt.sign({ id: teacher.id, type: 'teacher' }, process.env.JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, teacher: { id: teacher.id, name: teacher.name, username: teacher.username } });
});

// 教师自助重置密码（只用注册邮箱验证，无需用户名 / 旧密码 / 登录）
app.post('/api/teacher/reset-password', async (req, res) => {
  const { email, newPassword } = req.body;
  if (!email || !newPassword) {
    return res.status(400).json({ error: '请填写注册邮箱和新密码' });
  }
  if (String(newPassword).length < 4) {
    return res.status(400).json({ error: '新密码至少 4 位' });
  }
  const db = readDB();
  const cleanEmail = String(email).trim().toLowerCase();
  const teacher = db.teachers.find(t => (t.email || '').trim().toLowerCase() === cleanEmail);
  if (!teacher) {
    // 调试：列出库里所有教师邮箱便于比对
    const allEmails = db.teachers.map(t => `"${t.email}" (user: ${t.username})`).join(', ') || '(无)';
    console.warn(`[reset-teacher] 邮箱 "${cleanEmail}" 未匹配。库中邮箱: ${allEmails}`);
    return res.status(404).json({ error: '该邮箱未注册教师账号（请确认邮箱拼写，或联系管理员）' });
  }
  teacher.password_hash = bcrypt.hashSync(newPassword, 10);
  writeDB(db);
  // 直接落盘，确保密码立即生效（绕过异步 TRUNCATE 快照）
  try {
    await pgDirectUpdateTeacherPassword(cleanEmail, teacher.password_hash);
  } catch (e) {
    console.error('⚠️ 教师密码直写 PG 失败：', e.message);
  }
  res.json({ message: '密码重置成功，请用新密码登录' });
});

// 学生自助重置密码（只用注册邮箱验证，无需用户名 / 旧密码 / 登录）
app.post('/api/student/reset-password', async (req, res) => {
  const { email, newPassword } = req.body;
  if (!email || !newPassword) {
    return res.status(400).json({ error: '请填写注册邮箱和新密码' });
  }
  if (String(newPassword).length < 4) {
    return res.status(400).json({ error: '新密码至少 4 位' });
  }
  const db = readDB();
  const cleanEmail = String(email).trim().toLowerCase();
  const student = db.students.find(s => (s.email || '').trim().toLowerCase() === cleanEmail);
  if (!student) {
    return res.status(404).json({ error: '该邮箱未注册学生账号' });
  }
  student.password_hash = bcrypt.hashSync(newPassword, 10);
  writeDB(db);
  // 直接落盘，确保密码立即生效（绕过异步 TRUNCATE 快照）
  try {
    await pgDirectUpdateStudentPassword(cleanEmail, student.password_hash);
  } catch (e) {
    console.error('⚠️ 学生密码直写 PG 失败：', e.message);
  }
  res.json({ message: '密码重置成功，请用新密码登录' });
});

// ==================== 管理员登录 ====================

app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  const db = readDB();
  const admin = db.admins.find(a => a.username === username);
  if (!admin) return res.status(401).json({ error: '用户不存在' });
  if (!bcrypt.compareSync(password, admin.password_hash)) {
    return res.status(401).json({ error: '密码错误' });
  }
  const token = jwt.sign({ id: admin.id, type: 'admin' }, process.env.JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, admin: { id: admin.id, username: admin.username } });
});

// ==================== 房间管理 ====================

app.post('/api/room/create', authMiddleware, (req, res) => {
  if (req.user.type !== 'teacher') return res.status(403).json({ error: '无权限' });
  const { vocabulary_list, practice_modes, mode_word_map, level } = req.body;
  const db = readDB();
  const room_code = Math.floor(100000 + Math.random() * 900000).toString();
  const room = {
    id: genId(db.rooms), room_code, teacher_id: req.user.id,
    vocabulary_list: vocabulary_list || null,
    practice_modes: practice_modes || [],
    mode_word_map: mode_word_map || {},
    level: ['5', '6', '7+'].includes(level) ? level : '6',
    created_at: new Date().toISOString()
  };
  db.rooms.push(room);
  writeDB(db);
  // 增量直写（绕过全表 TRUNCATE，防止部署/重启时用旧缓存覆盖清空）
  pgDirectUpsertRoom(room).catch(e => console.error('⚠️ 房间创建直写 PG 失败：', e.message));
  res.json({ message: '房间创建成功', room_code, roomId: room.id });
});

app.get('/api/teacher/rooms', authMiddleware, (req, res) => {
  if (req.user.type !== 'teacher') return res.status(403).json({ error: '无权限' });
  const db = readDB();
  const rooms = db.rooms.filter(r => r.teacher_id === req.user.id).map(room => {
    const joinedCount = db.studentRooms.filter(sr => sr.room_id === room.id).length;
    // 只统计有实际答题记录的练习会话（finished_at + total_questions > 0），过滤幽灵学生
    const practiceStudentIds = db.practiceSessions
      .filter(ps => ps.room_id === room.id && ps.finished_at && (ps.total_questions || 0) > 0)
      .map(ps => ps.student_id);
    const practiceCount = new Set(practiceStudentIds).size;
    // 去重：加入列表 + 练习记录里的学生（取并集）
    const joinedIds = db.studentRooms.filter(sr => sr.room_id === room.id).map(sr => sr.student_id);
    const allStudentIds = [...new Set([...joinedIds, ...practiceStudentIds])];
    const studentCount = allStudentIds.length;
    return { ...room, student_count: studentCount };
  });
  res.json(rooms);
});

app.delete('/api/room/:roomCode', authMiddleware, (req, res) => {
  if (req.user.type !== 'teacher') return res.status(403).json({ error: '无权限' });
  const db = readDB();
  const roomIdx = db.rooms.findIndex(r => r.room_code === req.params.roomCode && r.teacher_id === req.user.id);
  if (roomIdx === -1) return res.status(404).json({ error: '房间不存在' });
  // 删除房间相关的练习会话
  const roomId = db.rooms[roomIdx].id;
  db.practiceSessions = db.practiceSessions.filter(s => s.room_id !== roomId);
  db.wordStats = db.wordStats.filter(ws => ws.room_id !== roomId);
  db.studentRooms = db.studentRooms.filter(sr => sr.room_id !== roomId);
  db.rooms.splice(roomIdx, 1);
  writeDB(db);
  // 级联删除房间及其练习数据（增量，绝不全表 TRUNCATE）
  pgDirectDeleteRoomCascade(roomId).catch(e => console.error('⚠️ 房间删除直写 PG 失败：', e.message));
  res.json({ message: '房间已删除' });
});

app.get('/api/room/:roomCode', (req, res) => {
  const db = readDB();
  const room = db.rooms.find(r => r.room_code === req.params.roomCode);
  if (!room) return res.status(404).json({ error: '房间不存在' });
  const teacher = db.teachers.find(t => t.id === room.teacher_id);
  // 统计该房间各练习模式被使用的次数
  const usage = {};
  Object.entries(db.modeUsage || {}).forEach(([k, v]) => {
    const sep = k.indexOf(':');
    const rid = parseInt(k.slice(0, sep));
    const mode = k.slice(sep + 1);
    if (rid === room.id) usage[mode] = (usage[mode] || 0) + v;
  });
  // 统计学生人数（合并 studentRooms + 有实际答题记录的 practiceSessions 去重）
  const joinedIds = db.studentRooms.filter(sr => sr.room_id === room.id).map(sr => sr.student_id);
  const practiceIds = db.practiceSessions
    .filter(ps => Number(ps.room_id) === room.id && ps.finished_at && (ps.total_questions || 0) > 0)
    .map(ps => ps.student_id)
    .filter(id => !joinedIds.includes(id));
  const allStudentIds = [...new Set([...joinedIds, ...practiceIds])];
  const studentCount = allStudentIds.length;

  res.json({
    id: room.id,
    room_code: room.room_code,
    vocabulary_list: room.vocabulary_list,
    practice_modes: room.practice_modes,
    mode_word_map: room.mode_word_map || {},
    level: room.level || '6',
    mode_usage: usage,
    student_count: studentCount,
    teacher_name: teacher ? teacher.username : '未知'
  });
});

app.post('/api/room/join', authMiddleware, async (req, res) => {
  if (req.user.type !== 'student') return res.status(403).json({ error: '无权限' });
  const { room_code } = req.body;
  const db = readDB();
  const room = db.rooms.find(r => r.room_code === room_code);
  if (!room) return res.status(404).json({ error: '房间不存在' });
  const exists = db.studentRooms.some(sr => sr.student_id === req.user.id && sr.room_id === room.id);
  if (!exists) {
    const sr = { id: genId(db.studentRooms), student_id: req.user.id, room_id: room.id, joined_at: new Date().toISOString(), note: '' };
    db.studentRooms.push(sr);
    writeDB(db);
    // 直接落盘，确保加入关系立即生效（绕过异步 TRUNCATE 快照）
    try {
      await pgDirectInsertStudentRoom(sr);
    } catch (e) {
      console.error('⚠️ 加入房间直写 PG 失败：', e.message);
    }
  }
  res.json({ message: '加入房间成功', roomId: room.id, roomCode: room.room_code });
});

// 学生为已加入的房间添加/修改备注
app.post('/api/student/room/note', authMiddleware, (req, res) => {
  if (req.user.type !== 'student') return res.status(403).json({ error: '无权限' });
  const { room_code, note } = req.body;
  if (!room_code) return res.status(400).json({ error: '缺少 room_code' });
  const db = readDB();
  const room = db.rooms.find(r => r.room_code === room_code);
  if (!room) return res.status(404).json({ error: '房间不存在' });
  const sr = db.studentRooms.find(s => s.student_id === req.user.id && s.room_id === room.id);
  if (!sr) return res.status(404).json({ error: '尚未加入该房间' });
  sr.note = (note || '').toString().slice(0, 200);
  writeDB(db);
  pgDirectUpdateStudentRoomNote(req.user.id, room.id, sr.note).catch(e => console.error('⚠️ 房间备注直写 PG 失败：', e.message));
  res.json({ message: '备注已保存', note: sr.note });
});

// 学生从已加入列表移除（永久删除）某个房间
app.post('/api/student/room/leave', authMiddleware, (req, res) => {
  if (req.user.type !== 'student') return res.status(403).json({ error: '无权限' });
  const { room_code } = req.body;
  if (!room_code) return res.status(400).json({ error: '缺少 room_code' });
  const db = readDB();
  const room = db.rooms.find(r => r.room_code === room_code);
  if (!room) return res.status(404).json({ error: '房间不存在' });
  const before = db.studentRooms.length;
  db.studentRooms = db.studentRooms.filter(s => !(s.student_id === req.user.id && s.room_id === room.id));
  writeDB(db);
  if (db.studentRooms.length === before) return res.status(404).json({ error: '尚未加入该房间' });
  // 增量删除该加入关系（与内存缓存保持一致）
  pgDirectDeleteStudentRoom(req.user.id, room.id).catch(e => console.error('⚠️ 离开房间直写 PG 失败：', e.message));
  res.json({ message: '已从房间列表移除' });
});

// ==================== 练习题目生成（通义千问 AI 生成） ====================

// IELTS topic categories (雅思话题类别)
const TOPIC_CATEGORIES = [
  '教育类', '科技类', '环境类', '社会类', '政府类',
  '文化类', '健康类', '工作类', '媒体类', '犯罪类', '全球化类', '城市化类'
];

const SENTENCE_PATTERNS = [
  "While it's universally believed that..., I'd rather say...",
  "It's not uncommon for sb to...",
  "It's highly likely/unlikely that...",
  "From what I've seen/heard/read,...",
  "Despite the fact that...",
  "What I'm trying to say is...",
  "The reason why I think this way is that...",
  "If I had to put it in a nutshell,...",
  "I suppose one of the main reasons is...",
  "It really depends on..., but generally speaking,...",
  "I'm not entirely sure, but...",
  "There's no denying that...",
  "It's fair to say that...",
  "I guess it really comes down to...",
  "To be honest,...",
  "The way I see it,...",
  "I'd go as far as to say that..."
];

const THINKING_TAGS = [
  '人际', '身心', '学习', '经济', '效率',
  '环境', '科技', '减压', '好恶', '性格', '能力', '规划'
];

// 高质量降级模板库（按词性分类，每个词有独立句子）
// 兜底模板：按【目标水平】×【词性】分级。AI 欠费/失败走 fallback 时，
// 仍能根据教师所选等级(5/6/7+)生成明显不同复杂度的句子。
// - 5 分：简单句，12-16 词，基础词汇，至多 1 个简单从句
// - 6 分：含 1 个从句，15-22 词
// - 7+ 分：高级复杂句型（让步/定语/分词/名词性从句），18-28 词
const FALLBACK_TEMPLATES_BY_LEVEL = {
  '5': {
    adj: [
      { t: "The new plan is very {w} and easy for most people to accept.", c: "这个新计划很{w}，大多数人都容易接受。" },
      { t: "Many students think the topic is {w} but still useful to learn.", c: "很多学生觉得这个话题很{w}，但仍然值得学习。" },
      { t: "This kind of food is {w} and popular among young people today.", c: "这种食物很{w}，如今在年轻人中很受欢迎。" },
      { t: "The weather here is often {w}, so people plan their days carefully.", c: "这里的天气常常很{w}，所以人们会仔细安排日程。" },
    ],
    n: [
      { t: "Many people talk about {w} in their daily life these days.", c: "如今很多人在日常生活中谈论{w}。" },
      { t: "The government spends a lot of money on {w} every year.", c: "政府每年在{w}上花很多钱。" },
      { t: "Young people today care more about {w} than before.", c: "如今的年轻人比以前更关心{w}。" },
      { t: "In big cities, {w} is a common thing that people notice.", c: "在大城市里，{w}是人们常常注意到的事情。" },
    ],
    v: [
      { t: "People should {w} more often to stay healthy and happy.", c: "人们应该多{w}，以保持健康和快乐。" },
      { t: "Schools ask students to {w} as part of their daily study.", c: "学校要求学生把{w}作为日常学习的一部分。" },
      { t: "It is good to {w} when you have free time at home.", c: "在家有空时{w}是件好事。" },
      { t: "Parents often tell their children to {w} every day.", c: "父母常常叮嘱孩子每天{w}。" },
    ],
    phrase: [
      { t: "Teachers often encourage students to {w} at school.", c: "老师常常鼓励学生在学校{w}。" },
      { t: "Many families try to {w} together on weekends.", c: "很多家庭会在周末一起{w}。" },
      { t: "People are asked to {w} in order to save money.", c: "人们被要求{w}，以便省钱。" },
      { t: "It is helpful to {w} in everyday life.", c: "在日常生活中{w}很有帮助。" },
    ],
  },
  '6': {
    adj: [
      { t: "A {w} approach to the problem has produced noticeably better outcomes than expected.", c: "用{w}的方法处理这个问题，产生的效果明显优于预期。" },
      { t: "The {w} design of the new policy has drawn both praise and criticism from experts.", c: "这项新政策{w}的设计既赢得了专家的赞许，也招来了批评。" },
      { t: "Such {w} conditions are rarely found in densely populated metropolitan areas.", c: "这种{w}的条件在人口稠密的大都市地区很少见。" },
      { t: "Critics describe the proposal as {w}, arguing it ignores long-term consequences.", c: "批评者将该提案描述为{w}，认为它忽视了长期后果。" },
      { t: "The {w} contrast between the two regions reflects deeper structural inequalities.", c: "两个地区之间{w}的对比，反映了更深层的结构性不平等。" },
    ],
    n: [
      { t: "The recent debate over {w} has divided public opinion across the country.", c: "最近关于{w}的争论在全国范围内使公众意见出现分歧。" },
      { t: "Surveys indicate that {w} varies significantly between urban and rural regions.", c: "调查显示，{w}在城市和农村地区之间存在显著差异。" },
      { t: "Policymakers are under growing pressure to address the issue of {w}.", c: "政策制定者正面临越来越大的压力，需要解决{w}的问题。" },
      { t: "Few would deny that {w} has reshaped the way younger generations think.", c: "很少有人会否认，{w}已经重塑了年轻一代的思维方式。" },
      { t: "The long-term consequences of {w} remain a subject of intense academic study.", c: "{w}的长期影响仍然是学术研究高度关注的课题。" },
    ],
    v: [
      { t: "Authorities have pledged to {w} the new measures before the end of the year.", c: "当局已承诺在年底前{w}新措施。" },
      { t: "Critics warn that failing to {w} could expose the system to serious risks.", c: "批评者警告，若不{w}，可能会使系统面临严重风险。" },
      { t: "Gradually, communities began to {w} as part of their everyday routines.", c: "渐渐地，社区开始将{w}作为日常惯例的一部分。" },
      { t: "The report urges citizens to {w} rather than wait for external intervention.", c: "报告敦促市民{w}，而不是等待外部干预。" },
      { t: "Economists predict that companies will {w} to stay competitive in the market.", c: "经济学家预测，企业将会{w}以在市场中保持竞争力。" },
    ],
    phrase: [
      { t: "Officials announced a plan to {w} across all major public institutions.", c: "官员宣布了一项在所有主要公共机构中{w}的计划。" },
      { t: "The campaign encourages young people to {w} instead of relying on shortcuts.", c: "该运动鼓励年轻人{w}，而不是依赖捷径。" },
      { t: "Researchers found it easier to {w} when clear guidelines were provided.", c: "研究人员发现，在提供明确指引时，{w}更容易实现。" },
      { t: "Local communities were asked to {w} in order to reduce overall waste.", c: "当地社区被要求{w}，以减少总体浪费。" },
    ],
  },
  '7+': {
    adj: [
      { t: "Although the reform initially appeared {w}, its long-term implications, which few had anticipated, soon became a matter of national concern.", c: "尽管这项改革起初看起来{w}，但其少有人预料到的长期影响，很快成为全国关注的问题。" },
      { t: "What makes the proposal particularly {w} is the way it reconciles competing interests that have long divided policymakers.", c: "这项提案之所以尤其{w}，在于它调和了长期以来使政策制定者产生分歧的各方利益。" },
      { t: "Being inherently {w}, the strategy demands a level of coordination that most institutions, however well-funded, struggle to achieve.", c: "由于本质上{w}，该策略所要求的协调程度，是大多数机构（无论资金多么充裕）都难以达到的。" },
      { t: "The {w} nature of the phenomenon, coupled with mounting economic pressure, has forced experts to reconsider long-held assumptions.", c: "这一现象{w}的本质，加上日益加剧的经济压力，迫使专家重新审视长期以来的假设。" },
    ],
    n: [
      { t: "While {w} is frequently cited as a driver of progress, its uneven distribution across regions raises questions that remain largely unresolved.", c: "尽管{w}常被视为进步的推动力，但其在各地区分布不均，引发了迄今仍未解决的问题。" },
      { t: "The debate surrounding {w}, which has intensified in recent years, reflects deeper tensions between economic growth and social equality.", c: "近年来愈演愈烈的关于{w}的争论，反映出经济增长与社会公平之间更深层的矛盾。" },
      { t: "Far from being a marginal concern, {w} has emerged as a defining issue that shapes how societies allocate their limited resources.", c: "{w}远非无关紧要的问题，而已成为决定社会如何分配有限资源的关键议题。" },
      { t: "What complicates the discussion of {w} is the extent to which cultural values, rather than mere policy, determine public attitudes.", c: "使关于{w}的讨论变得复杂的，是文化价值观（而非单纯的政策）在多大程度上决定了公众态度。" },
    ],
    v: [
      { t: "Unless governments are willing to {w} decisively, the structural problems that underlie the crisis are unlikely to be resolved.", c: "除非政府愿意果断地{w}，否则潜藏于危机之下的结构性问题不太可能得到解决。" },
      { t: "Having recognised the urgency of the situation, authorities have begun to {w}, though critics argue the measures remain insufficient.", c: "在认识到形势的紧迫后，当局已开始{w}，尽管批评者认为这些措施仍然不够。" },
      { t: "The pressure to {w}, driven by both economic necessity and public expectation, has reshaped the priorities of major institutions.", c: "在经济需要和公众期待的双重驱动下，{w}的压力重塑了各大机构的优先事项。" },
      { t: "Whereas earlier generations were reluctant to {w}, today's citizens increasingly regard it as an essential civic responsibility.", c: "早先几代人不愿{w}，而如今的公民则越来越将其视为一项重要的公民责任。" },
    ],
    phrase: [
      { t: "In an era defined by rapid change, the capacity to {w} has become indispensable to those hoping to remain competitive.", c: "在一个以快速变革为特征的时代，{w}的能力对于希望保持竞争力的人而言已不可或缺。" },
      { t: "Although it may seem straightforward to {w}, doing so consistently requires resources that many communities simply lack.", c: "尽管{w}看似简单，但要持之以恒地做到，需要许多社区根本不具备的资源。" },
      { t: "The growing tendency to {w}, which reflects shifting social values, carries profound implications for future policy.", c: "{w}这一日益增长的趋势反映了社会价值观的变化，对未来政策具有深远影响。" },
      { t: "Institutions that fail to {w}, however prestigious, risk losing relevance in an increasingly demanding environment.", c: "未能{w}的机构，无论多么有声望，都可能在要求日益苛刻的环境中失去存在价值。" },
    ],
  },
};

// 向后兼容别名：默认取 6 分模板（旧代码若直接引用 FALLBACK_TEMPLATES 不会崩溃）
const FALLBACK_TEMPLATES = FALLBACK_TEMPLATES_BY_LEVEL['6'];

const BATCH_SIZE = 10;

// 通用干扰词池（当词汇表词数不足4个时，从此处补齐选项）
const COMMON_DISTRACTORS = [
  'significant', 'essential', 'crucial', 'substantial', 'considerable',
  'remarkable', 'adequate', 'sufficient', 'appropriate', 'relevant',
  'beneficial', 'effective', 'efficient', 'reliable', 'consistent',
  'apparent', 'evident', 'obvious', 'distinct', 'particular',
  'complex', 'diverse', 'extensive', 'various', 'numerous'
];

// 词库缓存版本号：每次修改题目生成质量（如修复模板句/脏数据）后 +1，
// 旧版本缓存自动失效，下次请求强制重新 AI 生成干净句子，无需手动清库。
const CACHE_VERSION = 11;

// 不同目标分数对应的句子复杂度指导（注入到 AI 生成 prompt）
const LEVEL_GUIDE = {
  '5': '【目标学生水平：雅思 5 分】\n- 句子以简单句为主，长度约 12-16 词\n- 使用常见基础词汇，语法基本正确即可\n- 最多使用 1 个简单从句，不要使用生僻词或过于复杂的句型',
  '6': '【目标学生水平：雅思 6 分】\n- 句子应包含 1 个复杂结构（如定语从句或状语从句）\n- 词汇较丰富，句式有一定变化，长度约 15-22 词\n- 体现雅思 6 分的衔接与连贯',
  '7+': '【目标学生水平：雅思 7 分以上】\n- 必须综合使用高级复杂句型（让步状语从句、定语从句、分词结构、名词性从句等）\n- 用词精准高级，逻辑衔接自然，长度约 18-28 词\n- 充分体现雅思口语 7+ 的回答特征'
};

/**
 * 调用通义千问为一批词汇生成题目
 */
async function generateBatchWithAI(wordBatch, level, batchIndex, totalBatches) {
  const levelBlock = LEVEL_GUIDE[level] || LEVEL_GUIDE['6'];
  const prompt = `你是一位雅思口语8分老师。请为以下每个词汇生成一道高质量的雅思口语Part3题目（句子填空形式）。
⚠️ 生成的数据将被用于**多种练习模式**（句子填空/拖曳语块成句/组词成句/词格找句等），chinese 字段会在每种模式中展示给学生作为参考翻译。

${levelBlock}
- 尽量所有句子都是雅思口语 Part 3 的回答风格：探讨社会、教育、科技、环境等宏观/抽象话题，使用客观论证而非个人经历叙述。

【严格规则】
1. 每个词必须生成**语义上真正贴合该词自身含义**的独特句子，绝不能套用通用模板！
   ❌ 绝对禁止的「假例句」写法（这类句子无论换成哪个词都成立，毫无针对性）：
      - "We think [词] is important." / "We believe [词] matters."
      - "We learned [词] from this experience."
      - "[词] plays a crucial role in our daily lives."（对每个词都这么说）
      - "The importance of [词] cannot be overstated."
      - 任何把词条当主语/宾语随意塞进固定句型的写法
   ✅ 正确写法：句子内容必须围绕该词**具体的、真实的含义**展开，例如：
      - dense（稠密的）："The ______ fog made it nearly impossible to see the road ahead."
      - implement（实施）："Local governments must ______ the new environmental policies without delay."
      - hype（炒作）："Media ______ around the product faded once its flaws were exposed."
2. 句子中用 ______ 表示空白处，正确答案就是该词本身（词形须与句子语法一致，必要时用正确时态/单复数）。
3. 句子必须是雅思口语 Part3 风格：探讨社会、教育、科技、环境等宏观抽象话题，用客观论证而非 "I think/believe" 个人叙述；使用复杂句型（让步/定语/分词结构）。
4. 必须正确判断并使用该词的词性，确保语法完全正确（注意动词时态、名词单复数、形容词位置）。
5. 干扰项必须与正确答案词性相同、难度相当、但意思不同，且不能是模板套话。
6. chinese 字段必须是对应英文句子的**完整中文翻译**（逐字对应级别），要涵盖英文句子中的**每一个**信息点，不能省略任何从句、修饰语或细节。学生需要靠中文理解整句英文的全部含义。
7. 句子（含空白标记 ______，空白计 1 个词）总长度建议控制在 25 个单词以内，允许适度使用雅思常见复杂句型，但避免过于冗长的嵌套从句链。
8. **以下字段绝对禁止包含任何中文字符或词性标注（adj./v./n.等）**：word、options、correct_answer、definition、option_defs、sentence。这些字段必须100%纯英文。只有 chinese 字段可以包含中文。
9. **sentence 字段中禁止原样复制词汇列表中的原始格式**（如 "implement v."、"dense adj. 浓密"）。句子中只能出现该词的**纯英文形式**（如 "implement"、"dense"），绝不能附带词性或中文。
10. **sentence 必须是语法完整、标点正确的句子**：首字母必须大写，句末必须有英文标点（. ? !），不能是截断的片段。这个句子会直接展示给学生作为「原句」参考。

【字段说明】
- word: **纯英文词汇**（仅英文单词，禁止包含中文、词性标注或释义）
- pos: 词性 (adj/n/v/adv/phrase)
- sentence: **纯英文**含______的完整句子（禁止包含中文、词性标注或原始词汇格式）
- options: [正确答案, 干扰项1, 干扰项2, 干扰项3] 共4个（每个仅英文单词）
- correct_answer: 正确答案（仅英文单词）
- topic_category: 雅思话题类别（从以下选一个）：教育类/科技类/环境类/社会类/政府类/文化类/健康类/工作类/媒体类/犯罪类/全球化类/城市化类
- thinking_tag: 思路标签（从以下选一个）：人际/身心/学习/经济/效率/环境/科技/减压/好恶/性格/能力/规划
- template: 逻辑句型模板（如 "While it's universally believed that..., I'd rather say..."）
- definition: **纯英文**简单短释义（5-10个单词，禁止包含任何中文字符，**且绝对禁止包含 word 字段的单词本身**——例如 word 是 "dense" 时，definition 不能出现 "dense" 这个词）
- option_defs: 与 options 顺序严格对应的每个词的**纯英文**简单短释义数组（长度必须等于 options 长度）；第1个是正确答案释义，其余是干扰项释义；**绝对禁止包含任何中文字符**
- chinese: 中文翻译

【词汇列表】
${JSON.stringify(wordBatch)}

【返回格式 - 纯JSON，不要markdown】
[
  {
    "word": "ubiquitous",
    "pos": "adj",
    "sentence": "Smartphones have become ______ in modern society, appearing in almost every aspect of our daily lives.",
    "options": ["ubiquitous", "obsolete", "redundant", "scarce"],
    "correct_answer": "ubiquitous",
    "topic_category": "科技类",
    "thinking_tag": "科技",
    "template": "While it's universally believed that..., I'd rather say...",
    "definition": "present or found everywhere",
    "option_defs": ["present or found everywhere", "no longer produced or used", "unnecessary, superfluous", "rare, insufficient"],
    "chinese": "智能手机在现代社会已经变得无处不在，几乎出现在我们日常生活的方方面面。"
  }
]

重要：
- 每个词的句子必须**根据词义量身定制**，内容要体现该词具体是什么意思、在什么语境下用。宁可句子结构相似，也绝不能用"X is important"这种放之四海皆准的废话。
- 自检：把生成的句子里的词换成另一个词，如果句子依然通顺且"没毛病"，说明你在套模板——重写！
- 一共生成 ${wordBatch.length} 道

🚨 最后一次强调：绝对禁止以下模板句式（后端会自动检测并拦截，被拦截的题会降级为低质量兜底句子）：
  - "While ____ is frequently cited as..."（无论填什么词都成立）
  - "____ plays a crucial role in..."
  - "The importance of ____ cannot be overstated"
  - "____ has become increasingly common in modern society"
  - "Few would deny that ____ has reshaped..."
  - "____ raises questions that remain largely unresolved"
  - 任何"把词塞进固定句型"的写法
  每个句子的**核心语义必须依赖目标词的具体含义**！
- 只返回JSON数组`;

  try {
    console.log(`AI生成题目 - 批次 ${batchIndex + 1}/${totalBatches}，词汇数：${wordBatch.length}`);

    const response = await axios.post(DASHSCOPE_API_URL, {
      model: 'qwen-plus',
      messages: [
        { role: 'system', content: '你是雅思口语8分专家。只返回JSON数组，不要解释，不要markdown代码块。每个词汇必须有独特、贴合词义的句子。绝对禁止生成模板句——每个句子必须围绕该词的具体含义展开。' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.4,
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${DASHSCOPE_API_KEY}`
      },
      timeout: 60000
    });

    const content = response.data.choices[0].message.content.trim();

    let jsonStr = content;
    const codeBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (codeBlockMatch) jsonStr = codeBlockMatch[1];

    const questions = JSON.parse(jsonStr);

    if (!Array.isArray(questions) || questions.length === 0) {
      throw new Error('AI返回数据格式错误');
    }

    // 限制原句长度：含空白计 1 词，最长 28 词（雅思复杂句型需要足够长度表达完整语义）
    questions.forEach(q => { if (q && q.sentence) q.sentence = truncateSentence(q.sentence, 28); });

    // 校验：不合格的题单独用词典兜底重生成（避免垃圾数据入缓存）
    const validated = [];
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      if (isQuestionValid(q)) {
        validated.push(q);
      } else {
        const pool = wordBatch.filter((_, j) => j !== i).slice(0, 4);
        const fb = await generateFallback([wordBatch[i], ...pool], level, i, [wordBatch[i], ...pool]);
        if (fb.length) validated.push(fb[0]);
      }
    }
    if (validated.length === 0) throw new Error('AI返回题目全部校验不合格');
    questions = validated;

    // 安全清洗：确保 word/options/correct_answer/definition/option_defs 不含中文与词性标注
    const stripChinese = (s) => {
      if (typeof s !== 'string') return s || '';
      return s
        .replace(/[一-鿿㐀-䶿]/g, '')                                  // 去掉所有中文字符
        .replace(/(^|\s)(?:adj|adv|prep|conj|pron|det|int|aux|art|num|abbr|phr|vi|vt|n|v)\.?(?=[\s,，.;；、。！？!?]|\)|$)/gi, '$1') // 去掉词性标注（含标点后缀）
        .replace(/\s*[（（][^））]*[））]\s*/g, ' ')                   // 去掉括号注释
        .replace(/\s*\([^)]*\)\s*/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    };
    questions.forEach(q => {
      if (!q) return;
      if (q.word) q.word = cleanWordEntry(q.word);           // 用更强力的 cleanWordEntry
      if (q.correct_answer) q.correct_answer = cleanWordEntry(q.correct_answer);
      if (q.sentence) {
        q.sentence = stripChinese(q.sentence);   // 句子也不能含中文/词性
        // 规范化：确保首字母大写 + 句末有标点
        let s = q.sentence.trim();
        if (s.length > 0) {
          s = s[0].toUpperCase() + s.slice(1);
          if (!/[.!?]$/.test(s)) s += '.';
          q.sentence = s;
        }
      }
      if (Array.isArray(q.options)) q.options = q.options.map(cleanWordEntry);
      if (q.definition) {
        q.definition = stripChinese(q.definition);
        // 定义若包含答案词本身则清空（避免泄露原词）
        const w = (q.word || q.correct_answer || '').toLowerCase();
        if (w && q.definition.toLowerCase().includes(w)) q.definition = '';
      }
      if (Array.isArray(q.option_defs)) q.option_defs = q.option_defs.map(stripChinese);
    });

    console.log(`批次 ${batchIndex + 1} AI生成成功，题目数：`, questions.length);
    return questions;
  } catch (err) {
    console.error(`批次 ${batchIndex + 1} AI生成失败：`, err.message);
    // 高质量降级模板生成（每个词有独立句子）
    try {
      return await generateFallback(wordBatch, level, batchIndex);
    } catch (fbErr) {
      // fallback 自身也出错时，返回最简兜底题目（确保永远不崩页面）
      console.error(`批次 ${batchIndex + 1} fallback也失败：`, fbErr.message);
      return (wordBatch || []).map(cleanWordEntry).filter(Boolean).map(w => ({
        word: w, pos: posGuess(w),
        sentence: `The use of ${w} has become increasingly common in modern society.`,
        options: shuffleArray([w, 'significant', 'essential', 'crucial'].filter(o => o !== w).slice(0, 3).concat(w)),
        correct_answer: w,
        topic_category: '社会类', thinking_tag: '效率', template: 'It is widely argued that...',
        definition: `${w} (${posGuess(w)})`,
        option_defs: ['（释义暂缺）', '（释义暂缺）', '（释义暂缺）', '（释义暂缺）'],
        chinese: `（关于 ${w} 的句子翻译待补充）`
      }));
    }
  }
}

/**
 * 词典查询（免费无 key 源）：Free Dictionary API 取英文释义/例句/词性，MyMemory 取中文翻译。
 * 任一源失败都不抛错，返回空串，由调用方决定兜底。带 5s 超时避免悬挂。
 */
async function lookupWord(rawWord) {
  const word = cleanWordEntry(rawWord);
  if (!word) return { word, pos: '', definition: '', example: '', chinese: '' };
  let pos = '', definition = '', example = '', chinese = '';
  // 1) 英文释义 + 例句 + 词性
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const engRes = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (engRes.ok) {
      const data = await engRes.json();
      const first = Array.isArray(data) ? data[0] : data;
      if (first && first.meanings && first.meanings.length) {
        pos = first.meanings[0].partOfSpeech || '';
        for (const m of first.meanings.slice(0, 3)) {
          const d = m.definitions && m.definitions[0];
          if (d && d.definition && !definition) definition = d.definition;
          if (d && d.example && !example && d.example.toLowerCase().includes(word.toLowerCase())) example = d.example;
          if (definition && example) break;
        }
      }
    }
  } catch (_) { /* 英文源不可达 */ }
  // 2) 中文翻译
  try {
    const ctrl2 = new AbortController();
    const timer2 = setTimeout(() => ctrl2.abort(), 5000);
    const cnRes = await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(word)}&langpair=en|zh-CN`, { signal: ctrl2.signal });
    clearTimeout(timer2);
    if (cnRes.ok) {
      const cnData = await cnRes.json();
      const t = cnData.responseData && cnData.responseData.translatedText;
      if (t && t !== word && t.toUpperCase() !== word.toUpperCase()) {
        chinese = t.split(/[；;、]/)[0].trim() || '';
      }
    }
  } catch (_) { /* 中文源不可达 */ }
  return { word, pos, definition: definition || '', example, chinese };
}

function stripLite(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/[一-鿿㐀-䶿]/g, '').replace(/\s+/g, ' ').trim();
}

function posGuess(word) {
  if (word.includes(' ') || word.includes('-')) return 'phrase';
  if (/^(be|get|go|take|make|have|do|set|put|bring|fall|grow|look|come|keep|break|spend|save|waste|pay|draw|reach|gain|lose|earn|raise|give|play|meet|solve|achieve|develop|improve|reduce|increase|build|face|accept|reject|create|close|clear|open|pose|do|play)/i.test(word)) return 'v';
  if (word.length <= 4 && /^[a-z]+$/i.test(word)) return 'adj';
  return 'n';
}

/**
 * 翻译整句英文为中文（MyMemory 免费 API，5s 超时）。
 * 用于 generateFallback 的 chinese 字段：给学生展示完整句子的中文含义，而非仅目标单词的词典翻译。
 */
async function translateSentence(sentence) {
  if (!sentence || typeof sentence !== 'string') return '';
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(sentence)}&langpair=en|zh-CN`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (res.ok) {
      const data = await res.json();
      const t = data.responseData && data.responseData.translatedText;
      if (t && t !== sentence) return t.split(/[；;、]/)[0].trim() || '';
    }
  } catch (_) { /* 翻译源不可达 */ }
  return '';
}

/* 薄弱词汇真实例句缓存（模块级，服务器生命周期内复用，避免重复打外部 API） */
const exampleCache = new Map();

/**
 * 为薄弱词抓取「真实词典例句」（非模板套句）。
 * - 例句必须包含该词本身（保证是真实语境句，而非套用的假例句）
 * - 并行抓取：词典例句 + 词的中文义 + 例句的中文翻译
 * - 任何一步超时/失败都优雅降级，绝不抛出（避免拖垮薄弱词接口）
 * 返回 { example_en, example_zh, word_zh }
 */
async function fetchWordExample(rawWord) {
  const word = cleanWordEntry(rawWord);
  const lower = word.toLowerCase();
  if (!word) return { example_en: '', example_zh: '', word_zh: '' };
  if (exampleCache.has(lower)) return exampleCache.get(lower);

  let example_en = '', example_zh = '', word_zh = '';

  // 1) 词典真实例句（含该词）+ 2) 词的中文义，并行抓取
  const dictP = (async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
      const r = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`, { signal: ctrl.signal });
      if (r.ok) {
        const data = await r.json();
        const first = Array.isArray(data) ? data[0] : data;
        if (first && first.meanings && first.meanings.length) {
          for (const m of first.meanings.slice(0, 3)) {
            const d = m.definitions && m.definitions[0];
            if (d && d.example && d.example.toLowerCase().includes(lower) && !example_en) {
              example_en = d.example;
              break;
            }
          }
        }
      }
    } catch (_) { /* 词典源不可达 */ }
    finally { clearTimeout(timer); }
  })();

  const zhP = (async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
      const r = await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(word)}&langpair=en|zh-CN`, { signal: ctrl.signal });
      if (r.ok) {
        const j = await r.json();
        const tx = j.responseData && j.responseData.translatedText;
        if (tx && tx.toUpperCase() !== word.toUpperCase()) word_zh = tx.split(/[；;、]/)[0].trim() || '';
      }
    } catch (_) { /* 翻译源不可达 */ }
    finally { clearTimeout(timer); }
  })();

  await Promise.all([dictP, zhP]);

  // 3) 例句的中文翻译（best-effort，依赖上一步拿到的例句）
  if (example_en) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
      const r = await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(example_en)}&langpair=en|zh-CN`, { signal: ctrl.signal });
      if (r.ok) {
        const j = await r.json();
        const tx = j.responseData && j.responseData.translatedText;
        if (tx && tx !== example_en) example_zh = tx.split(/[；;、]/)[0].trim() || '';
      }
    } catch (_) { /* 翻译源不可达 */ }
    finally { clearTimeout(timer); }
  }

  const result = { example_en, example_zh, word_zh };
  exampleCache.set(lower, result);
  return result;
}

/** 根据词性生成兜底释义（当词典查不到干扰词定义时使用）。variant 用于同词性产生不同措辞避免重复。 */
function fallbackDefForPos(pos, variant) {
  // 注意：绝不把原词嵌入返回值，否则前端 strip 后会变成裸词泄露答案
  // 改进：每种词性的变体指向不同语义域，确保彼此可区分
  const v = (variant || 0) % 6;  // 每种词性 6 种变体（增加区分度）
  switch ((pos || 'n').toLowerCase()) {
    case 'v': case 'vi': case 'vt':
      return [
        'relating to an action or process that changes something',
        'connected to how people behave or interact in society',
        'about creating, building, or producing something new',
        'involving movement, change, or development over time',
        'describing how something affects or influences a situation',
        'used when talking about managing or controlling something'
      ][v];
    case 'adj':
      return [
        'describing a quality or condition of something',
        'relating to size, amount, or degree of something',
        'about how important or necessary something is',
        'connected to appearance, form, or structure',
        'describing a feeling, attitude, or opinion',
        'indicating whether something is good or bad'
      ][v];
    case 'adv':
      return [
        'telling how often or how much something happens',
        'about the manner or way in which something is done',
        'relating to time — when something occurs',
        'describing the level or extent of something',
        'connected to certainty or possibility',
        'indicating a point of view or perspective'
      ][v];
    case 'n': default:
      return [
        'a concept or idea in academic or scientific contexts',
        'something physical found in nature or daily life',
        'an abstract principle or rule in social systems',
        'a measurable quantity in economics or statistics',
        'part of a system, process, or method',
        'a role, position, or category in an organization'
      ][v];
  }
}

/** 检测释义是否过于宽泛/通用（无法区分不同词汇） */
function isGenericDefinition(def) {
  if (!def) return true;
  const d = def.toLowerCase();
  const GENERIC_PATTERNS = [
    /^referring to a (person|place|thing|object|item|being)/,
    /^(representing|naming|identifying) (something|anything|an? \w+)/,
    /^(a word used to|a term for|denoting|meaning)/,
    /^(describing|giving|expressing|modifying|indicating) (a |an |something )?(quality|characteristic|attribute|property|feature)/,
    /^(to perform|to carry out|an action|an activity|an act|a deed)/,
  ];
  return GENERIC_PATTERNS.some(p => p.test(d));
}

/**
 * 高质量降级方案（AI 不可用时的兜底）：用免费词典 API 实时取每个词（含干扰词）的
 * 真实英文释义 / 中文翻译 / 例句，生成可用题目。保证：
 * - options ≥ 4 个不重复选项
 * - chinese 是整句的中文翻译（非单个词翻译）
 * - option_defs 尽量用真实词典释义，缺失则用词性兜底
 */
/** 归一化 level 到模板级别键：'5' | '6' | '7+' */
function normalizeLevelKey(level) {
  const s = String(level || '6').toLowerCase();
  if (/7|8|9|ielts|雅思|高|advanced|c1|c2/.test(s)) return '7+';
  if (/5|初|elementary|a2|b1|基础|简单|easy/.test(s)) return '5';
  return '6';
}

async function generateFallback(words, level, batchIndex, pool) {
  try {
  const levelKey = normalizeLevelKey(level);
  const TPL = FALLBACK_TEMPLATES_BY_LEVEL[levelKey] || FALLBACK_TEMPLATES_BY_LEVEL['6'];
  const maxWords = levelKey === '5' ? 16 : (levelKey === '7+' ? 32 : 24);
  const cleaned = words.map(cleanWordEntry).filter(Boolean);
  const distractorPool = (pool && pool.length ? pool : words).map(cleanWordEntry).filter(Boolean);
  // 并行查所有目标词 + 干扰词池（确保干扰词也有释义可用）
  const allLookupWords = [...new Set([...cleaned, ...distractorPool])];
  const looked = await Promise.all(allLookupWords.map(w => lookupWord(w)));
  const infoMap = {};
  allLookupWords.forEach((w, i) => { infoMap[w.toLowerCase()] = looked[i]; });

  // 预查所有词的词性（用于兜底释义）
  const posMap = {};
  allLookupWords.forEach(w => { posMap[w.toLowerCase()] = (infoMap[w.toLowerCase()] || {}).pos || posGuess(w); });

  // ===== 第一遍：构建每道题的句子（不含中文）=====
  const rawQuestions = [];
  for (let i = 0; i < cleaned.length; i++) {
    const word = cleaned[i];
    const info = infoMap[word.toLowerCase()] || { pos: '', definition: '', example: '', chinese: '' };
    const pos = info.pos || posGuess(word);

    let sentence;
    // 5 分级优先用分级模板（简单句），6/7+ 级可保留词典真实例句以获得更自然的语境
    const useDictExample = levelKey !== '5' && info.example && info.example.toLowerCase().includes(word.toLowerCase()) && new RegExp(escapeRegExp(word), 'gi').test(info.example);
    if (useDictExample) {
      sentence = truncateSentence(info.example.replace(new RegExp(escapeRegExp(word), 'gi'), '______'), maxWords);
    } else {
      const tb = TPL[pos] || TPL.n;
      sentence = truncateSentence(tb[(i + batchIndex * BATCH_SIZE) % tb.length].t.replace('{w}', '______'), maxWords);
    }
    if (!/_{4,}/.test(sentence)) {
      const tb = TPL[pos] || TPL.n;
      sentence = truncateSentence(tb[(i + batchIndex * BATCH_SIZE) % tb.length].t.replace('{w}', '______'), maxWords);
    }
    sentence = sentence.trim();
    if (sentence.length > 0) {
      sentence = sentence[0].toUpperCase() + sentence.slice(1);
      if (!/[.!?]$/.test(sentence)) sentence += '.';
    }

    rawQuestions.push({ word, pos, info, sentence });
  }

  // ===== 并行翻译所有整句（关键：循环外 Promise.all，不串行等待）=====
  const sentencesToTranslate = rawQuestions.map(rq => ({
    original: rq.sentence.replace(/_{4,}/g, rq.word),  // 还原答案词用于翻译
    index: rq.rawIndex
  }));
  const translations = await Promise.all(
    sentencesToTranslate.map(st => translateSentence(st.original).catch(() => ''))
  );

  // ===== 第二遍：组装完整题目（含整句中文翻译）=====
  const out = [];
  for (let i = 0; i < cleaned.length; i++) {
    const { word, pos, info, sentence } = rawQuestions[i];

    // 取 3 个同批干扰词（确保不重复、不是答案词本身）
    const othersRaw = distractorPool.filter(w => w && w.toLowerCase() !== word.toLowerCase());
    const others = shuffleArray(othersRaw).slice(0, 3);
    // 如果干扰词不够3个，用 COMMON_DISTRACTORS 补齐
    const needMore = Math.max(0, 3 - others.length);
    const extras = needMore > 0 ? COMMON_DISTRACTORS.filter(d => d.toLowerCase() !== word.toLowerCase() && !others.some(o => o.toLowerCase() === d.toLowerCase())).slice(0, needMore) : [];
    const options = shuffleArray([word, ...others, ...extras]);
    // 极端保护：如果还是不足4，复制填充
    while (options.length < 4) options.push(`word_${options.length + 1}`);

    // 每个选项配释义：优先词典真实释义 → 词性兜底（绝不允许空串导致校验失败）
    const optionDefs = options.map((o, oi) => {
      const oKey = o.toLowerCase();
      const d = (infoMap[oKey] || {}).definition || '';
      if (d && !d.toLowerCase().includes(word.toLowerCase())) return stripLite(d);
      // 兜底：基于该词的猜测词性 + 选项位置生成差异化占位释义
      return fallbackDefForPos(posMap[oKey] || 'n', i + oi);
    });

    // 中文优先级：整句并行翻译 > 词级词典翻译 > 模板中文 > 占位符
    let chinese = translations[i] || '';
    if (!chinese) chinese = info.chinese || '';
    if (!chinese) {
      const tmplArr = TPL[pos] || TPL.n;
      const tmplC = tmplArr ? tmplArr[(i + batchIndex * BATCH_SIZE) % tmplArr.length].c : '';
      chinese = tmplC ? tmplC.replace('{w}', word) : '';
    }
    if (!chinese) chinese = '（翻译待补充）';

    const topicCat = TOPIC_CATEGORIES[(i + batchIndex) % TOPIC_CATEGORIES.length];
    const thinkTag = THINKING_TAGS[i % THINKING_TAGS.length];
    const pattern = SENTENCE_PATTERNS[i % SENTENCE_PATTERNS.length];

    // 最终安全扫描：option_defs 绝不能等于（或包含）任何选项词，也不能过于宽泛通用
    const safeOptionDefs = optionDefs.map((d, di) => {
      const dClean = stripLite(d || '').toLowerCase();
      if (!d || options.some(o => dClean === o.toLowerCase() || dClean.includes(o.toLowerCase())) || isGenericDefinition(d)) {
        return fallbackDefForPos(pos, i + di + 99);  // 兜底替换，用偏移量避免与上面的重复
      }
      return d;
    });

    out.push({
      word,
      pos,
      sentence,
      options,
      correct_answer: word,
      topic_category: topicCat,
      thinking_tag: thinkTag,
      template: pattern,
      definition: (info.definition && !info.definition.toLowerCase().includes(word.toLowerCase()) && !isGenericDefinition(info.definition)) ? stripLite(info.definition) : fallbackDefForPos(pos, i + 77),
      option_defs: safeOptionDefs,
      chinese
    });
  }
  return out;
  } catch (innerErr) {
    // 任何意外错误时返回最简可用题目（绝不抛出）
    console.error('generateFallback 内部异常:', innerErr.message);
    return (words || []).map(cleanWordEntry).filter(Boolean).map((w, wi) => ({
      word: w, pos: posGuess(w),
      sentence: `The use of ${w} has become increasingly common in modern society.`,
      options: shuffleArray([w, 'significant', 'essential', 'crucial'].filter(o => o !== w).slice(0, 3).concat(w)),
      correct_answer: w,
      topic_category: '社会类', thinking_tag: '效率', template: 'It is widely argued that...',
      definition: fallbackDefForPos(posGuess(w), wi),
      option_defs: [0,1,2,3].map(vi => fallbackDefForPos(posGuess(w), wi + vi + 10)),
      chinese: `（关于 ${w} 的句子翻译待补充）`
    }));
  }
}

/**
 * 校验单道 AI 题目是否合格（不合格则不应入缓存，避免垃圾数据）。
 * 要求：选项≥2且不重复、释义与选项一一对应且非空非答案词、定义非空非答案词、
 *       中文翻译非空、句子含挖空且句子内不再残留答案词。
 */
function isQuestionValid(q) {
  if (!q || !q.word) return false;
  const w = cleanWordEntry(q.word).toLowerCase();
  const opts = (Array.isArray(q.options) ? q.options : []).map(cleanWordEntry).filter(Boolean);
  if (opts.length < 2) return false;
  if (new Set(opts.map(o => o.toLowerCase())).size !== opts.length) return false; // 选项不重复
  const defs = (Array.isArray(q.option_defs) ? q.option_defs : []).map(s => String(s || '').toLowerCase());
  if (defs.length !== opts.length) return false;                                 // 释义与选项一一对应
  if (defs.some(d => !d || d === w)) return false;                              // 释义非空且不是答案词
  const def = String(q.definition || '').toLowerCase();
  if (!def || def.includes(w)) return false;                                    // 定义非空且不含答案词
  if (!q.chinese || !String(q.chinese).trim()) return false;                   // 中文翻译必须有
  const s = String(q.sentence || '').toLowerCase();
  if (!/_{4,}/.test(s)) return false;                                           // 句子必须含挖空
  if (new RegExp('\\b' + escapeRegExp(w) + '\\b', 'i').test(s)) return false;   // 句子残留答案词（未被挖空）
  if (isTemplateSentence(s, w)) return false;                                   // 拦截模板句
  return true;
}

/**
 * 检测是否为模板句（同一句式套不同目标词的假句子）
 * 模板句特征：句子去掉空白标记后，结构高度通用，换任何同词性词都成立
 */
function isTemplateSentence(sentence, word) {
  if (!sentence) return true;
  const s = sentence.toLowerCase().trim();
  // 常见模板短语列表（这些短语出现在句中几乎一定是模板句）
  const TEMPLATE_PHRASES = [
    /\bis frequently cited as\b/,
    /\bplays?\s+(a\s+)?(crucial|key|important|vital|significant|pivotal|essential)\s+role\b/,
    /\bcannot be (overstated|overemphasized|ignored|neglected)\b/,
    /\bhas become increasingly\s+(common|popular|prevalent|widespread|important)\b/,
    /\bis widely (regarded|considered|believed|recognized|acknowledged)\s+(to be\s+)?(an? )?(important|essential|crucial|significant|vital)\b/,
    /\bthere is no doubt that\b/,
    /\bit is (widely|generally|universally|commonly)\s+(accepted|agreed|believed|recognized)\s+that\b/,
    /\bin (recent|modern|today's|current)\s+(years?|times?|society|world)\b.*\bhas (drawn|attracted|received|gained)\b.*(attention|interest|concern|praise|criticism)\b/,
    /\bthe (importance|significance|value|role|impact|effect)\s+of\b.*\b(cannot|can\s+not)\s+(be\s+)?(ignored|overlooked|denied|underestimated|dismissed)\b/,
    /\braises?\s+(questions?|issues?|concerns?)\s+(that\s+)?(remain|are)\s+(largely|mostly|still|yet)\s+(unresolved|unanswered|unclear|open)\b/,
    /\bhas (reshaped|transformed|revolutionized|changed|altered)\s+(the\s+)?way\b/,
    /\bfew would (deny|dispute|argue|question)\s+that\b/,
  ];
  if (TEMPLATE_PHRASES.some(p => p.test(s))) return true;

  // 额外检测：如果句子中不含任何该词的语义相关词汇（基于简单启发），可能也是模板
  // 此处不做复杂NLP，仅靠上面的短语匹配已能拦截大部分模板

  return false;
}

/**
 * 分批调用AI生成所有题目
 */
async function generateQuestionsWithAI(vocabularyList, level) {
  if (!vocabularyList || vocabularyList.length === 0) return [];

  // 【关键】入口处统一清洗：确保传给AI的词汇100%纯英文，绝不带中文/词性
  const cleanList = vocabularyList.map(cleanWordEntry);

  // 如果词汇数 <= BATCH_SIZE，直接生成
  if (cleanList.length <= BATCH_SIZE) {
    return await generateBatchWithAI(cleanList, level, 0, 1);
  }

  // 分批生成
  const totalBatches = Math.ceil(cleanList.length / BATCH_SIZE);
  const batchPromises = [];

  for (let i = 0; i < cleanList.length; i += BATCH_SIZE) {
    const batch = cleanList.slice(i, i + BATCH_SIZE);
    const batchIndex = Math.floor(i / BATCH_SIZE);
    batchPromises.push(generateBatchWithAI(batch, level, batchIndex, totalBatches));
  }

  // 顺序执行（避免并发过多）
  const allQuestions = [];
  for (const promise of batchPromises) {
    const batchResult = await promise;
    allQuestions.push(...batchResult);
  }

  console.log('所有批次生成完成，总题目数：', allQuestions.length);
  return allQuestions;
}

/**
 * 带词库缓存的题目获取
 * - 命中缓存（wordBank）直接返回，0 token 消耗，句子固定
 * - 未命中才调 AI 生成，并写回缓存，下次复用
 */
async function getQuestionsCached(vocabularyList, level) {
  const lv = ['5', '6', '7+'].includes(level) ? level : '6';
  if (!vocabularyList || vocabularyList.length === 0) return [];
  // 清洗词汇表：去掉每条的中文和词性标注，只保留纯英文单词
  const cleanedList = vocabularyList.map(cleanWordEntry);
  const db = readDB();
  const bank = db.wordBank || [];
  const result = [];
  const missing = [];
  const newEntries = [];

  for (let i = 0; i < vocabularyList.length; i++) {
    const rawW = vocabularyList[i];
    const w = cleanedList[i];   // 用清洗后的词做缓存查找
    const key = w.toLowerCase();
    // 命中条件：同词 + 同目标水平 + 同缓存版本（旧版本模板句/脏数据强制失效重生成）
    const hit = bank.find(b => b.word.toLowerCase() === key && (b.level || '6') === lv && (b.cache_version || 0) === CACHE_VERSION);
    if (hit) {
      result.push(applyWordCase(hit, w));
    } else {
      missing.push(w);  // 传清洗后的纯英文词给AI（禁止把中文/词性传入prompt）
    }
  }

  if (missing.length > 0) {
    console.log('词库缓存未命中，调用AI生成新词：', missing.map(cleanWordEntry), '水平：', lv);
    const generated = await generateQuestionsWithAI(missing, lv);
    generated.forEach(q => {
      // 清洗AI返回的所有字段
      q.word = cleanWordEntry(q.word);
      q.correct_answer = cleanWordEntry(q.correct_answer);
      if (Array.isArray(q.options)) q.options = q.options.map(cleanWordEntry);
      const key = (q.word || '').toLowerCase();
      if (key && !bank.find(b => b.word.toLowerCase() === key && (b.level || '6') === lv)) {
        const entry = {
          word: q.word,
          level: lv,
          cache_version: CACHE_VERSION,
          pos: q.pos || '',
          sentence: q.sentence || '',
          options: q.options || [],
          correct_answer: q.correct_answer || q.word,
          topic: q.topic || '',
          template: q.template || '',
          chinese: q.chinese || '',
          definition: q.definition || '',
          option_defs: q.option_defs || [],
          topic_category: q.topic_category || ''
        };
        bank.push(entry);
        newEntries.push(entry);
      }
      result.push(shuffleQuestion({ ...q, sentence: ensureBlank(q.sentence, q.word) }));
    });
    db.wordBank = bank;
    writeDB(db);
    // 增量直写新生成的词条（绕过全表 TRUNCATE，防止词库/账号在部署时被旧缓存覆盖清空）
    for (const entry of newEntries) {
      try {
        await pgDirectUpsertWordBank(entry);
      } catch (e) {
        console.error('⚠️ 词库直写 PG 失败：', e.message);
      }
    }
    console.log('词库缓存已更新，当前词条数：', bank.length);
  }

  // 最终净化关：无论命中缓存还是新生成，返回前统一清洗，
  // 确保 word/options/correct_answer/definition/option_defs 绝不含中文、词性标注或答案词泄露
  const finalStrip = (s) => {
    if (typeof s !== 'string') return s || '';
    return s
      .replace(/[一-鿿㐀-䶿]/g, '')
      // 词性标注后可能紧跟标点(,)或句尾，(?=...) 前瞻需覆盖标点
      .replace(/(^|\s)(?:adj|adv|prep|conj|pron|det|int|aux|art|num|abbr|phr|vi|vt|n|v)\.?(?=[\s,，.;；、。！？!?]|\)|$)/gi, '$1')
      .replace(/[\s,]*[（（][^））]*[））][\s,]*/g, ' ')
      .replace(/[\s,]*\([^)]*\)[\s,]*/g, ' ')
      .replace(/[\s,]+/g, ' ').trim()
  };
  const sanitized = result.map(q => {
    if (!q) return q;
    const w = (q.word || q.correct_answer || '').toLowerCase();
    const clean = {
      ...q,
      word: q.word ? cleanWordEntry(q.word) : q.word,
      correct_answer: q.correct_answer ? cleanWordEntry(q.correct_answer) : q.correct_answer,
      sentence: (() => {
        if (!q.sentence) return q.sentence;
        let s = finalStrip(q.sentence);
        // 规范化：首字母大写 + 句末标点
        s = s.trim();
        if (s.length > 0) {
          s = s[0].toUpperCase() + s.slice(1);
          if (!/[.!?]$/.test(s)) s += '.';
        }
        return s;
      })(),
      options: Array.isArray(q.options) ? q.options.map(cleanWordEntry) : q.options,
      definition: q.definition ? finalStrip(q.definition) : q.definition,
      option_defs: Array.isArray(q.option_defs) ? q.option_defs.map(finalStrip) : q.option_defs,
      // chinese 是中文翻译字段，绝不能套用 finalStrip（会删掉所有中文字符）。仅做空白归一。
      chinese: (typeof q.chinese === 'string' && q.chinese.trim()) ? q.chinese.replace(/\s+/g, ' ').trim() : '',
      topic_category: q.topic_category || '',
    };
    // 定义若包含答案词本身则清空
    if (clean.definition && w && clean.definition.toLowerCase().includes(w)) clean.definition = '';
    return clean;
  });

  return sanitized;
}

// 正则转义
function escapeRegExp(s) {
  return (s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 从词汇表原始条目中提取纯英文单词
 * 输入示例："dense adj. 浓密的" → "dense"
 *       "drain v. 排放排出（液体）" → "drain"
 *       "take responsibility" → "take responsibility"
 *       "widespread" → "widespread"
 */
function cleanWordEntry(raw) {
  if (typeof raw !== 'string') return raw || '';
  // 提取第一个英文单词串（可含连字符、多词短语），彻底忽略前/后的中文与词性标注
  // 例如："dense adj. 浓密的" → "dense"；"take responsibility v. 承担责任" → "take responsibility"
  const m = raw.match(/[a-zA-Z][a-zA-Z\-']*(?:\s+[a-zA-Z][a-zA-Z\-']*)*/);
  return m ? m[0].trim() : raw.trim();
}

function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// 打乱题目选项，并保持 option_defs 与选项严格同步（成对打乱，避免释义错位）
function shuffleQuestion(q) {
  const options = Array.isArray(q.options) ? [...q.options] : [];
  const defs = Array.isArray(q.option_defs) ? [...q.option_defs] : [];
  const paired = options.map((opt, i) => ({ opt, def: i < defs.length ? defs[i] : '' }));
  for (let i = paired.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [paired[i], paired[j]] = [paired[j], paired[i]];
  }
  return {
    ...q,
    options: paired.map(p => p.opt),
    option_defs: paired.map(p => p.def)
  };
}

// 确保句子含有挖空；若AI未生成空白（句子里直接写出答案），自动在词出现处插入 ______
function ensureBlank(sentence, word) {
  if (!sentence || !word) return sentence || '';
  if (/_{4,}/.test(sentence)) return sentence;
  const w = String(word).trim();
  if (!w) return sentence;
  const re = new RegExp(`['"\`‘’“”]?${escapeRegExp(w)}['"\`‘’“”]?`, 'i');
  return sentence.replace(re, '______');
}

// 截断原句：最长 maxWords 个单词（空白 ______ 计 1 个词），超长则从较长一侧在逗号/连词处自然切断，且保留空白
// 雅思Part3复杂句通常15-30词，默认28词上限保证语义完整
function truncateSentence(sentence, maxWords = 28) {
  if (!sentence || typeof sentence !== 'string') return sentence;
  const words = sentence.trim().split(/\s+/).filter(Boolean);
  const isBlank = w => /_{4,}/.test(w);
  const isWord = w => /[A-Za-z]/.test(w) || isBlank(w); // 真实单词或空白都计 1 词
  const total = words.filter(isWord).length;
  if (total <= maxWords) return sentence;

  const CONN = new Set(['and', 'but', 'or', 'nor', 'for', 'yet', 'so', 'because', 'although', 'though', 'while', 'which', 'that', 'when', 'where', 'if', 'unless', 'once', 'since', 'after', 'before']);
  const bareWord = w => w.replace(/[^A-Za-z]/g, '').toLowerCase();
  const isBoundary = w => /[,;]$/.test(w) || CONN.has(bareWord(w));

  const blankIdx = words.findIndex(isBlank);
  // 无空白：退化为普通截断（在最近逗号/连词处切断，加省略号）
  if (blankIdx < 0) {
    let cnt = 0, cut = -1;
    for (let i = 0; i < words.length; i++) { if (/[A-Za-z]/.test(words[i])) cnt++; if (cnt === maxWords) { cut = i; break; } }
    if (cut < 0 || cut >= words.length - 1) return sentence;
    let best = cut;
    for (let i = cut; i >= Math.max(0, cut - 5); i--) { if (isBoundary(words[i])) { best = i; break; } }
    return words.slice(0, best + 1).join(' ').replace(/[,;:]\s*$/, '') + ' …';
  }

  // 含空白：保留空白，从较长侧裁剪到 ≤ maxWords
  let start = 0, end = words.length - 1;
  const windowCount = () => words.slice(start, end + 1).filter(isWord).length;
  let guard = 0;
  while (windowCount() > maxWords && guard++ < words.length + 5) {
    const before = words.slice(start, blankIdx + 1).filter(isWord).length;
    const after = words.slice(blankIdx, end + 1).filter(isWord).length;
    if (before >= after) {
      let i = start;
      while (i < blankIdx) { if (isBoundary(words[i])) break; i++; }
      start = Math.min(i + 1, blankIdx);
    } else {
      let i = end;
      while (i > blankIdx) { if (isBoundary(words[i])) break; i--; }
      end = Math.max(i - 1, blankIdx);
    }
  }
  return words.slice(start, end + 1).join(' ');
}

// 命中缓存时：同步大小写 + 补挖空 + 打乱选项（每次读取都打乱，避免正确答案总在A位）
function applyWordCase(bankItem, originalWord) {
  let item = { ...bankItem };
  // 同步大小写
  if (bankItem.word.toLowerCase() !== originalWord.toLowerCase()) {
    const re = new RegExp(escapeRegExp(bankItem.word), 'gi');
    item.sentence = (bankItem.sentence || '').replace(re, originalWord);
    item.options = (bankItem.options || []).map(o =>
      o.toLowerCase() === bankItem.word.toLowerCase() ? originalWord : o
    );
    item.word = originalWord;
    item.correct_answer = originalWord;
  } else {
    item.word = originalWord;
  }
  // 补挖空 + 重新打乱选项（含释义同步）
  item.sentence = ensureBlank(item.sentence || '', item.correct_answer);
  item.sentence = truncateSentence(item.sentence, 28);
  return shuffleQuestion(item);
}

// ==================== ⑨ 搭配拼词：雅思口语高分搭配内置库 ====================
// 每条：base(锚词) + partner(搭配词) + pos + sentence(含完整搭配的例句) + zh(中文)
const IELTS_COLLOCATIONS = [
  { base: 'make', partner: 'decision', pos: 'v', sentence: 'We need to make a decision about our future career.', zh: '我们需要对未来职业做个决定。' },
  { base: 'make', partner: 'progress', pos: 'v', sentence: 'Students should make progress every semester.', zh: '学生每学期都应取得进步。' },
  { base: 'make', partner: 'effort', pos: 'v', sentence: 'You must make an effort to improve your pronunciation.', zh: '你必须努力改善发音。' },
  { base: 'make', partner: 'mistake', pos: 'v', sentence: 'It is natural to make a mistake when learning.', zh: '学习时犯错很正常。' },
  { base: 'make', partner: 'sense', pos: 'v', sentence: 'His argument does not make sense to me.', zh: '他的论点我听不懂。' },
  { base: 'take', partner: 'place', pos: 'v', sentence: 'The meeting will take place next Monday.', zh: '会议下周一举行。' },
  { base: 'take', partner: 'responsibility', pos: 'v', sentence: 'Parents should take responsibility for their children.', zh: '父母应对孩子负责。' },
  { base: 'take', partner: 'action', pos: 'v', sentence: 'We must take action to protect the environment.', zh: '我们必须采取行动保护环境。' },
  { base: 'take', partner: 'advantage', pos: 'v', sentence: 'Smart students take advantage of every opportunity.', zh: '聪明的学生利用每个机会。' },
  { base: 'pay', partner: 'attention', pos: 'v', sentence: 'You should pay attention to the teacher.', zh: '你应该注意听老师讲。' },
  { base: 'pay', partner: 'respect', pos: 'v', sentence: 'We pay respect to our elders.', zh: '我们尊重长辈。' },
  { base: 'draw', partner: 'conclusion', pos: 'v', sentence: 'We can draw a conclusion from the data.', zh: '我们可以从数据得出结论。' },
  { base: 'draw', partner: 'attention', pos: 'v', sentence: 'The advertisement draws attention to the product.', zh: '广告把注意力引向产品。' },
  { base: 'reach', partner: 'agreement', pos: 'v', sentence: 'Both sides reached an agreement.', zh: '双方达成了协议。' },
  { base: 'reach', partner: 'conclusion', pos: 'v', sentence: 'Scientists reached a conclusion after research.', zh: '科学家研究后得出结论。' },
  { base: 'gain', partner: 'experience', pos: 'v', sentence: 'Interns gain experience in the company.', zh: '实习生在公司获得经验。' },
  { base: 'gain', partner: 'access', pos: 'v', sentence: 'Students gain access to the library.', zh: '学生获得了图书馆的使用权。' },
  { base: 'gain', partner: 'confidence', pos: 'v', sentence: 'Practice helps you gain confidence.', zh: '练习帮你建立信心。' },
  { base: 'have', partner: 'effect', pos: 'v', sentence: 'Pollution has a bad effect on health.', zh: '污染对健康有坏影响。' },
  { base: 'have', partner: 'impact', pos: 'v', sentence: 'Technology has a huge impact on our lives.', zh: '科技对生活影响巨大。' },
  { base: 'have', partner: 'influence', pos: 'v', sentence: 'Parents have influence on their kids.', zh: '父母对孩子有影响。' },
  { base: 'have', partner: 'opportunity', pos: 'v', sentence: 'You have an opportunity to study abroad.', zh: '你有机会出国留学。' },
  { base: 'pose', partner: 'threat', pos: 'v', sentence: 'Climate change poses a threat to wildlife.', zh: '气候变化对野生动物构成威胁。' },
  { base: 'pose', partner: 'challenge', pos: 'v', sentence: 'An aging population poses a challenge to society.', zh: '人口老龄化对社会构成挑战。' },
  { base: 'pose', partner: 'risk', pos: 'v', sentence: 'Smoking poses a risk to your health.', zh: '吸烟对健康有风险。' },
  { base: 'raise', partner: 'awareness', pos: 'v', sentence: 'Campaigns raise awareness of pollution.', zh: '活动提高了对污染的意识。' },
  { base: 'raise', partner: 'children', pos: 'v', sentence: 'It is hard to raise children alone.', zh: '独自抚养孩子很难。' },
  { base: 'raise', partner: 'question', pos: 'v', sentence: 'The report raises a question about safety.', zh: '报告提出了一个关于安全的问题。' },
  { base: 'keep', partner: 'promise', pos: 'v', sentence: 'He always keeps his promise.', zh: '他总是信守诺言。' },
  { base: 'break', partner: 'rule', pos: 'v', sentence: 'You should not break the rule.', zh: '你不该违反规则。' },
  { base: 'spend', partner: 'time', pos: 'v', sentence: 'I spend time reading every day.', zh: '我每天花时间阅读。' },
  { base: 'spend', partner: 'money', pos: 'v', sentence: 'Teenagers spend money on games.', zh: '青少年把钱花在游戏上。' },
  { base: 'save', partner: 'money', pos: 'v', sentence: 'We should save money for the future.', zh: '我们该为未来存钱。' },
  { base: 'save', partner: 'time', pos: 'v', sentence: 'Online shopping saves time.', zh: '网购节省时间。' },
  { base: 'waste', partner: 'time', pos: 'v', sentence: 'Do not waste time on social media.', zh: '别把时间浪费在社交媒体上。' },
  { base: 'do', partner: 'research', pos: 'v', sentence: 'Professors do research on artificial intelligence.', zh: '教授们做人工智能研究。' },
  { base: 'do', partner: 'exercise', pos: 'v', sentence: 'We should do exercise regularly.', zh: '我们应定期锻炼。' },
  { base: 'play', partner: 'role', pos: 'v', sentence: 'Education plays a role in success.', zh: '教育在成功中起作用。' },
  { base: 'give', partner: 'advice', pos: 'v', sentence: 'Teachers give advice to students.', zh: '老师给学生建议。' },
  { base: 'give', partner: 'example', pos: 'v', sentence: 'Can you give an example?', zh: '你能举个例子吗？' },
  { base: 'get', partner: 'job', pos: 'v', sentence: 'Graduates want to get a job.', zh: '毕业生想找到工作。' },
  { base: 'lose', partner: 'weight', pos: 'v', sentence: 'Many people want to lose weight.', zh: '很多人想减肥。' },
  { base: 'lose', partner: 'job', pos: 'v', sentence: 'He lost his job during the crisis.', zh: '他在危机中丢了工作。' },
  { base: 'lose', partner: 'temper', pos: 'v', sentence: 'Do not lose your temper easily.', zh: '别轻易发脾气。' },
  { base: 'earn', partner: 'money', pos: 'v', sentence: 'Workers earn money by working.', zh: '工人靠工作赚钱。' },
  { base: 'earn', partner: 'respect', pos: 'v', sentence: 'Hard work earns respect.', zh: '努力赢得尊重。' },
  { base: 'heavy', partner: 'traffic', pos: 'adj', sentence: 'There is heavy traffic at rush hour.', zh: '高峰时段交通拥堵。' },
  { base: 'keen', partner: 'interest', pos: 'adj', sentence: 'She has a keen interest in art.', zh: '她对艺术有浓厚兴趣。' },
  { base: 'wide', partner: 'range', pos: 'adj', sentence: 'The course offers a wide range of topics.', zh: '这门课涵盖广泛的话题。' },
  { base: 'strong', partner: 'argument', pos: 'adj', sentence: 'He presented a strong argument.', zh: '他提出了有力的论点。' },
  { base: 'high', partner: 'quality', pos: 'adj', sentence: 'We need high quality education.', zh: '我们需要高质量教育。' },
  { base: 'deeply', partner: 'concerned', pos: 'adv', sentence: 'I am deeply concerned about pollution.', zh: '我对污染深感担忧。' },
  { base: 'widely', partner: 'used', pos: 'adv', sentence: 'English is widely used worldwide.', zh: '英语在全世界广泛使用。' },
  { base: 'highly', partner: 'recommended', pos: 'adv', sentence: 'This book is highly recommended.', zh: '强烈推荐这本书。' },
  { base: 'badly', partner: 'needed', pos: 'adv', sentence: 'More funds are badly needed.', zh: '急需更多资金。' },
  { base: 'make', partner: 'contribution', pos: 'v', sentence: 'Volunteers make a contribution to society.', zh: '志愿者为社会做贡献。' },
  { base: 'make', partner: 'difference', pos: 'v', sentence: 'One person can make a difference.', zh: '一个人也能带来改变。' },
  { base: 'make', partner: 'friend', pos: 'v', sentence: 'It is easy to make friends at school.', zh: '在学校很容易交朋友。' },
  { base: 'take', partner: 'measure', pos: 'v', sentence: 'The government took measures to control prices.', zh: '政府采取措施控制物价。' },
  { base: 'take', partner: 'step', pos: 'v', sentence: 'We must take steps to reduce pollution.', zh: '我们必须采取措施减少污染。' },
  { base: 'take', partner: 'note', pos: 'v', sentence: 'Students should take notes in class.', zh: '学生上课应记笔记。' },
  { base: 'take', partner: 'photo', pos: 'v', sentence: 'Tourists take photos of the museum.', zh: '游客给博物馆拍照。' },
  { base: 'pay', partner: 'bill', pos: 'v', sentence: 'Tenants pay the electricity bill.', zh: '租户付电费。' },
  { base: 'pay', partner: 'visit', pos: 'v', sentence: 'We paid a visit to our grandparents.', zh: '我们拜访了祖父母。' },
  { base: 'draw', partner: 'line', pos: 'v', sentence: 'You must draw a line between work and life.', zh: '你必须划清工作与生活的界限。' },
  { base: 'draw', partner: 'comparison', pos: 'v', sentence: 'The essay draws a comparison between two cities.', zh: '这篇文章对比了两座城市。' },
  { base: 'reach', partner: 'target', pos: 'v', sentence: 'The company reached its sales target.', zh: '公司达成了销售目标。' },
  { base: 'reach', partner: 'goal', pos: 'v', sentence: 'Hard work helps you reach your goal.', zh: '努力助你达成目标。' },
  { base: 'reach', partner: 'standard', pos: 'v', sentence: 'Our school reaches high academic standards.', zh: '我们学校达到很高的学术标准。' },
  { base: 'gain', partner: 'profit', pos: 'v', sentence: 'The business gained a large profit.', zh: '这家企业获得了巨额利润。' },
  { base: 'gain', partner: 'support', pos: 'v', sentence: 'The policy gained public support.', zh: '该政策获得了公众支持。' },
  { base: 'have', partner: 'right', pos: 'v', sentence: 'Every child has the right to education.', zh: '每个孩子都有受教育的权利。' },
  { base: 'have', partner: 'trouble', pos: 'v', sentence: 'Foreign students have trouble with the accent.', zh: '外国学生难以适应口音。' },
  { base: 'have', partner: 'chance', pos: 'v', sentence: 'You have a chance to win the scholarship.', zh: '你有机会赢得奖学金。' },
  { base: 'raise', partner: 'fund', pos: 'v', sentence: 'They raised funds for the disaster.', zh: '他们为灾民筹款。' },
  { base: 'raise', partner: 'standard', pos: 'v', sentence: 'We should raise our living standards.', zh: '我们应提高生活水平。' },
  { base: 'raise', partner: 'issue', pos: 'v', sentence: 'The report raises an important issue.', zh: '报告提出了一个重要问题。' },
  { base: 'keep', partner: 'contact', pos: 'v', sentence: 'Keep contact with your old friends.', zh: '和老朋友保持联系。' },
  { base: 'keep', partner: 'record', pos: 'v', sentence: 'The camera keeps a record of the trip.', zh: '相机记录了旅途。' },
  { base: 'break', partner: 'record', pos: 'v', sentence: 'She broke the world record.', zh: '她打破了世界纪录。' },
  { base: 'spend', partner: 'effort', pos: 'v', sentence: 'We spend effort on the project.', zh: '我们在这个项目上付出努力。' },
  { base: 'save', partner: 'energy', pos: 'v', sentence: 'LED bulbs save energy.', zh: 'LED 灯泡节能。' },
  { base: 'save', partner: 'life', pos: 'v', sentence: 'The doctor saved his life.', zh: '医生救了他的命。' },
  { base: 'waste', partner: 'opportunity', pos: 'v', sentence: 'Do not waste this opportunity.', zh: '别浪费这个机会。' },
  { base: 'do', partner: 'homework', pos: 'v', sentence: 'Children do homework after school.', zh: '孩子们放学后做作业。' },
  { base: 'do', partner: 'damage', pos: 'v', sentence: 'The storm did damage to the roof.', zh: '暴风雨损坏了屋顶。' },
  { base: 'give', partner: 'speech', pos: 'v', sentence: 'The principal gave a speech.', zh: '校长发表了演讲。' },
  { base: 'give', partner: 'birth', pos: 'v', sentence: 'The cat gave birth to four kittens.', zh: '猫生了四只小猫。' },
  { base: 'get', partner: 'message', pos: 'v', sentence: 'I got your message yesterday.', zh: '我昨天收到了你的消息。' },
  { base: 'get', partner: 'result', pos: 'v', sentence: 'We will get the results next week.', zh: '我们下周会拿到结果。' },
  { base: 'lose', partner: 'control', pos: 'v', sentence: 'The driver lost control of the car.', zh: '司机失去了对车的控制。' },
  { base: 'lose', partner: 'interest', pos: 'v', sentence: 'He lost interest in the subject.', zh: '他对这门课失去了兴趣。' },
  { base: 'earn', partner: 'living', pos: 'v', sentence: 'He earns a living as a writer.', zh: '他靠写作谋生。' },
  { base: 'solve', partner: 'problem', pos: 'v', sentence: 'We must solve the housing problem.', zh: '我们必须解决住房问题。' },
  { base: 'achieve', partner: 'goal', pos: 'v', sentence: 'She achieved her career goal.', zh: '她实现了职业目标。' },
  { base: 'develop', partner: 'skill', pos: 'v', sentence: 'Children develop language skills fast.', zh: '孩子很快发展语言技能。' },
  { base: 'improve', partner: 'situation', pos: 'v', sentence: 'Education improves the situation.', zh: '教育改善了状况。' },
  { base: 'reduce', partner: 'cost', pos: 'v', sentence: 'Online learning reduces cost.', zh: '在线学习降低成本。' },
  { base: 'increase', partner: 'number', pos: 'v', sentence: 'Cars increase the number of accidents.', zh: '汽车增加了事故数量。' },
  { base: 'build', partner: 'confidence', pos: 'v', sentence: 'Practice builds your confidence.', zh: '练习建立自信。' },
  { base: 'face', partner: 'difficulty', pos: 'v', sentence: 'New students face many difficulties.', zh: '新生面临很多困难。' },
  { base: 'meet', partner: 'need', pos: 'v', sentence: 'The app meets our daily needs.', zh: '这个应用满足我们的日常需求。' },
  { base: 'accept', partner: 'offer', pos: 'v', sentence: 'She accepted the job offer.', zh: '她接受了工作录用。' },
  { base: 'reject', partner: 'proposal', pos: 'v', sentence: 'The committee rejected the proposal.', zh: '委员会否决了提案。' },
  { base: 'create', partner: 'opportunity', pos: 'v', sentence: 'Trade creates new opportunities.', zh: '贸易创造新机会。' },
  { base: 'close', partner: 'relationship', pos: 'adj', sentence: 'They have a close relationship.', zh: '他们关系亲密。' },
  { base: 'clear', partner: 'evidence', pos: 'adj', sentence: 'There is clear evidence of climate change.', zh: '有明确证据表明气候变化。' },
  { base: 'major', partner: 'change', pos: 'adj', sentence: 'The city underwent a major change.', zh: '这座城市经历了重大变化。' },
  { base: 'common', partner: 'mistake', pos: 'adj', sentence: 'This is a common mistake among learners.', zh: '这是学习者常犯的错误。' },
  { base: 'key', partner: 'factor', pos: 'adj', sentence: 'Motivation is a key factor in success.', zh: '动力是成功的关键因素。' },
  { base: 'social', partner: 'problem', pos: 'adj', sentence: 'Poverty is a serious social problem.', zh: '贫困是严重的社会问题。' },
  { base: 'closely', partner: 'related', pos: 'adv', sentence: 'Health is closely related to diet.', zh: '健康与饮食密切相关。' },
  { base: 'fully', partner: 'aware', pos: 'adv', sentence: 'Are you fully aware of the risk?', zh: '你完全意识到风险了吗？' },
  { base: 'greatly', partner: 'affect', pos: 'adv', sentence: 'Weather greatly affects mood.', zh: '天气极大影响情绪。' },
  { base: 'strongly', partner: 'recommend', pos: 'adv', sentence: 'I strongly recommend this method.', zh: '我强烈推荐这个方法。' },
  { base: 'poorly', partner: 'educated', pos: 'adv', sentence: 'Poorly educated workers earn less.', zh: '教育程度低的工人收入更少。' },
];

// ⑨ 搭配拼词题目构建
function buildCollocationQuestions(vocabularyList, maxCount = 20) {
  const lowerSet = new Set((vocabularyList || []).map(w => String(w).toLowerCase()));
  // 优先用老师 wordlist 中能匹配到搭配的词，否则用内置全部
  let pool = IELTS_COLLOCATIONS.filter(c => lowerSet.has(c.base.toLowerCase()));
  if (pool.length === 0) pool = IELTS_COLLOCATIONS.slice();
  pool = shuffleArray(pool).slice(0, maxCount);
  return pool.map(c => {
    const others = shuffleArray(IELTS_COLLOCATIONS.filter(x => x.partner !== c.partner)).slice(0, 3).map(x => x.partner);
    const options = shuffleArray([c.partner, ...others]);
    return {
      word: c.base,
      partner: c.partner,
      pos: c.pos,
      sentence: c.sentence,
      chinese: c.zh,
      options,
      correct_answer: c.partner,
      option_defs: options.map(() => ''),
      mode: 'collocation'
    };
  });
}

// ==================== ⑧ 形近辨析：IELTS 经典陷阱词内置库（~70 对） ====================
// 每条：target(目标词) + confusers(形近干扰词) + sentence(含 target 的例句) + zh + def
const CONFUSABLE_PAIRS = [
  { target: 'affect', confusers: ['effect', 'impact', 'influence'], sentence: 'The weather can affect your mood.', zh: '天气会影响你的心情。', def: 'v. 影响（动词）' },
  { target: 'effect', confusers: ['affect', 'result', 'outcome'], sentence: 'The new law had a positive effect.', zh: '新法律产生了积极效果。', def: 'n. 效果（名词）' },
  { target: 'personal', confusers: ['personnel', 'private', 'person'], sentence: 'This is a personal matter.', zh: '这是私人的事。', def: 'adj. 个人的' },
  { target: 'personnel', confusers: ['personal', 'people', 'staff'], sentence: 'The personnel department hired five workers.', zh: '人事部门雇了五名员工。', def: 'n. 人事/员工' },
  { target: 'principal', confusers: ['principle', 'prime', 'prior'], sentence: 'The principal reason is cost.', zh: '主要原因是成本。', def: 'adj. 主要的 / n. 校长' },
  { target: 'principle', confusers: ['principal', 'rule', 'law'], sentence: 'He refused on a matter of principle.', zh: '他基于原则拒绝了。', def: 'n. 原则' },
  { target: 'accept', confusers: ['except', 'expect', 'aspect'], sentence: 'I accept your apology.', zh: '我接受你的道歉。', def: 'v. 接受' },
  { target: 'except', confusers: ['accept', 'expect', 'excerpt'], sentence: 'Everyone came except Tom.', zh: '除了汤姆大家都来了。', def: 'prep. 除了' },
  { target: 'adapt', confusers: ['adopt', 'adept', 'adjust'], sentence: 'Children adapt to new schools quickly.', zh: '孩子很快适应新学校。', def: 'v. 适应' },
  { target: 'adopt', confusers: ['adapt', 'adept', 'admit'], sentence: 'They decided to adopt a child.', zh: '他们决定收养一个孩子。', def: 'v. 采纳/收养' },
  { target: 'advise', confusers: ['advice', 'devise', 'revise'], sentence: 'I advise you to study harder.', zh: '我建议你更努力。', def: 'v. 建议' },
  { target: 'advice', confusers: ['advise', 'device', 'service'], sentence: 'He gave me good advice.', zh: '他给了我好建议。', def: 'n. 建议' },
  { target: 'quiet', confusers: ['quite', 'quit', 'quote'], sentence: 'The library is very quiet.', zh: '图书馆很安静。', def: 'adj. 安静的' },
  { target: 'quite', confusers: ['quiet', 'quit', 'quote'], sentence: 'It is quite expensive.', zh: '它相当贵。', def: 'adv. 相当' },
  { target: 'desert', confusers: ['dessert', 'dissert', 'deserted'], sentence: 'Many soldiers desert in war.', zh: '许多士兵在战争中开小差。', def: 'v. 抛弃 / n. 沙漠' },
  { target: 'dessert', confusers: ['desert', 'dissert', 'deserted'], sentence: 'We had ice cream for dessert.', zh: '我们甜点吃了冰淇淋。', def: 'n. 甜点' },
  { target: 'ensure', confusers: ['insure', 'assure', 'secure'], sentence: 'Please ensure the door is locked.', zh: '请确保门锁好。', def: 'v. 确保' },
  { target: 'insure', confusers: ['ensure', 'assure', 'secure'], sentence: 'You should insure your car.', zh: '你应该给车投保。', def: 'v. 投保' },
  { target: 'assure', confusers: ['ensure', 'insure', 'reassure'], sentence: 'He assured me it was safe.', zh: '他向我保证是安全的。', def: 'v. 使确信' },
  { target: 'complement', confusers: ['compliment', 'complete', 'comply'], sentence: 'The wine complements the meal.', zh: '红酒与这餐很搭。', def: 'v./n. 补充' },
  { target: 'compliment', confusers: ['complement', 'complete', 'comment'], sentence: 'She gave me a nice compliment.', zh: '她赞美了我。', def: 'n./v. 赞美' },
  { target: 'stationary', confusers: ['stationery', 'station', 'stated'], sentence: 'The car was stationary at the light.', zh: '车在红灯前静止。', def: 'adj. 静止的' },
  { target: 'stationery', confusers: ['stationary', 'station', 'stated'], sentence: 'I bought some stationery.', zh: '我买了些文具。', def: 'n. 文具' },
  { target: 'loose', confusers: ['lose', 'loss', 'lost'], sentence: 'The screw is loose.', zh: '螺丝松了。', def: 'adj. 松的' },
  { target: 'lose', confusers: ['loose', 'loss', 'lost'], sentence: 'Do not lose your keys.', zh: '别丢了钥匙。', def: 'v. 丢失' },
  { target: 'breath', confusers: ['breathe', 'broth', 'breeze'], sentence: 'Take a deep breath.', zh: '深呼吸。', def: 'n. 呼吸' },
  { target: 'breathe', confusers: ['breath', 'broth', 'breeze'], sentence: 'It is hard to breathe here.', zh: '这里很难呼吸。', def: 'v. 呼吸' },
  { target: 'economic', confusers: ['economical', 'economy', 'economics'], sentence: 'The economic crisis hurt many.', zh: '经济危机伤害很多人。', def: 'adj. 经济的' },
  { target: 'economical', confusers: ['economic', 'economy', 'economics'], sentence: 'This car is very economical.', zh: '这车很省油。', def: 'adj. 节约的' },
  { target: 'rise', confusers: ['raise', 'arise', 'rose'], sentence: 'The sun will rise at six.', zh: '太阳六点升起。', def: 'v. 上升' },
  { target: 'raise', confusers: ['rise', 'arise', 'race'], sentence: 'Please raise your hand.', zh: '请举手。', def: 'v. 举起/提高' },
  { target: 'arise', confusers: ['rise', 'raise', 'arouse'], sentence: 'Problems may arise later.', zh: '问题可能稍后出现。', def: 'v. 出现' },
  { target: 'considerate', confusers: ['considerable', 'considered', 'considering'], sentence: 'She is very considerate.', zh: '她很体贴。', def: 'adj. 体贴的' },
  { target: 'considerable', confusers: ['considerate', 'considered', 'considering'], sentence: 'There was considerable damage.', zh: '损失相当大。', def: 'adj. 相当大的' },
  { target: 'sensitive', confusers: ['sensible', 'sensory', 'sensual'], sentence: 'He is sensitive to criticism.', zh: '他对批评敏感。', def: 'adj. 敏感的' },
  { target: 'sensible', confusers: ['sensitive', 'sensory', 'sensual'], sentence: 'That is a sensible choice.', zh: '那是明智的选择。', def: 'adj. 明智的' },
  { target: 'intense', confusers: ['intensive', 'intent', 'tense'], sentence: 'The pain was intense.', zh: '疼痛剧烈。', def: 'adj. 强烈的' },
  { target: 'intensive', confusers: ['intense', 'intent', 'tense'], sentence: 'He took an intensive course.', zh: '他上了密集课。', def: 'adj. 密集的' },
  { target: 'precede', confusers: ['proceed', 'president', 'process'], sentence: 'A warm-up precedes exercise.', zh: '热身先于运动。', def: 'v. 先于' },
  { target: 'proceed', confusers: ['precede', 'president', 'process'], sentence: 'Please proceed with the plan.', zh: '请继续计划。', def: 'v. 继续' },
  { target: 'perspective', confusers: ['prospective', 'prospect', 'perceptive'], sentence: 'We need a new perspective.', zh: '我们需要新视角。', def: 'n. 视角' },
  { target: 'prospective', confusers: ['perspective', 'prospect', 'perceptive'], sentence: 'We met a prospective buyer.', zh: '我们见了潜在买家。', def: 'adj. 预期的' },
  { target: 'conscious', confusers: ['conscience', 'conscientious', 'consensus'], sentence: 'He was conscious during surgery.', zh: '手术中他有意识。', def: 'adj. 有意识的' },
  { target: 'conscience', confusers: ['conscious', 'conscientious', 'consensus'], sentence: 'His conscience was clear.', zh: '他问心无愧。', def: 'n. 良心' },
  { target: 'conscientious', confusers: ['conscious', 'conscience', 'consensus'], sentence: 'She is a conscientious worker.', zh: '她是认真的员工。', def: 'adj. 认真的' },
  { target: 'comprehensive', confusers: ['comprehensible', 'compressed', 'compulsive'], sentence: 'We need a comprehensive plan.', zh: '我们需要全面计划。', def: 'adj. 全面的' },
  { target: 'comprehensible', confusers: ['comprehensive', 'compressed', 'compulsive'], sentence: 'His speech was comprehensible.', zh: '他的演讲可理解。', def: 'adj. 可理解的' },
  { target: 'implicit', confusers: ['explicit', 'illicit', 'elaborate'], sentence: 'There was an implicit agreement.', zh: '有含蓄的协议。', def: 'adj. 含蓄的' },
  { target: 'explicit', confusers: ['implicit', 'illicit', 'elaborate'], sentence: 'He gave explicit instructions.', zh: '他给了明确指示。', def: 'adj. 明确的' },
  { target: 'eligible', confusers: ['illegible', 'electable', 'elegant'], sentence: 'You are eligible for the prize.', zh: '你有资格获奖。', def: 'adj. 有资格的' },
  { target: 'illegible', confusers: ['eligible', 'electable', 'elegant'], sentence: 'His handwriting is illegible.', zh: '他字迹难辨。', def: 'adj. 难辨认的' },
  { target: 'respectable', confusers: ['respectful', 'respected', 'respective'], sentence: 'He is a respectable man.', zh: '他是可敬的人。', def: 'adj. 值得尊敬的' },
  { target: 'respectful', confusers: ['respectable', 'respected', 'respective'], sentence: 'Be respectful to elders.', zh: '对长辈要恭敬。', def: 'adj. 恭敬的' },
  { target: 'respective', confusers: ['respectable', 'respectful', 'respected'], sentence: 'They went to their respective homes.', zh: '他们回各自家。', def: 'adj. 各自的' },
  { target: 'industrial', confusers: ['industrious', 'industry', 'indent'], sentence: 'The industrial zone is large.', zh: '工业区很大。', def: 'adj. 工业的' },
  { target: 'industrious', confusers: ['industrial', 'industry', 'indent'], sentence: 'Ants are industrious.', zh: '蚂蚁很勤劳。', def: 'adj. 勤劳的' },
  { target: 'lone', confusers: ['lonely', 'loan', 'alone'], sentence: 'A lone rider crossed the desert.', zh: '孤独的骑手穿越沙漠。', def: 'adj. 单独的' },
  { target: 'lonely', confusers: ['lone', 'loan', 'alone'], sentence: 'She felt lonely in the city.', zh: '她在这城市感到寂寞。', def: 'adj. 寂寞的' },
  { target: 'later', confusers: ['latter', 'late', 'latest'], sentence: 'See you later.', zh: '回头见。', def: 'adv. 后来' },
  { target: 'latter', confusers: ['later', 'late', 'latest'], sentence: 'The latter option is better.', zh: '后一个选项更好。', def: 'adj. 后者的' },
  { target: 'beside', confusers: ['besides', 'beyond', 'behind'], sentence: 'The book is beside the lamp.', zh: '书在灯旁。', def: 'prep. 在旁边' },
  { target: 'besides', confusers: ['beside', 'beyond', 'behind'], sentence: 'Besides English, he speaks French.', zh: '除英语外他还会法语。', def: 'prep. 除…外还' },
  { target: 'weather', confusers: ['whether', 'wither', 'feather'], sentence: 'The weather is nice today.', zh: '今天天气好。', def: 'n. 天气' },
  { target: 'whether', confusers: ['weather', 'wither', 'feather'], sentence: 'I do not know whether to go.', zh: '我不知道是否去。', def: 'conj. 是否' },
  { target: 'council', confusers: ['counsel', 'console', 'cancel'], sentence: 'The city council met today.', zh: '市议会今天开会。', def: 'n. 委员会' },
  { target: 'counsel', confusers: ['council', 'console', 'cancel'], sentence: 'He sought legal counsel.', zh: '他寻求法律建议。', def: 'n./v. 建议' },
  { target: 'credible', confusers: ['credulous', 'creditable', 'incredible'], sentence: 'Her story is credible.', zh: '她的故事可信。', def: 'adj. 可信的' },
  { target: 'credulous', confusers: ['credible', 'creditable', 'incredible'], sentence: 'He is too credulous.', zh: '他太容易相信人。', def: 'adj. 易信的' },
  { target: 'defect', confusers: ['defeat', 'detect', 'deflect'], sentence: 'The product has a defect.', zh: '产品有缺陷。', def: 'n. 缺陷' },
  { target: 'defeat', confusers: ['defect', 'detect', 'deflect'], sentence: 'We defeated the opponent.', zh: '我们击败了对手。', def: 'v. 击败' },
  { target: 'access', confusers: ['assess', 'excess', 'across'], sentence: 'Students need access to the library.', zh: '学生需要能使用图书馆。', def: 'n./v. 进入/使用权' },
  { target: 'assess', confusers: ['access', 'excess', 'asset'], sentence: 'Teachers assess our essays.', zh: '老师评估我们的作文。', def: 'v. 评估' },
  { target: 'dairy', confusers: ['diary', 'daily', 'daisy'], sentence: 'She is allergic to dairy products.', zh: '她对乳制品过敏。', def: 'adj./n. 乳制品的' },
  { target: 'diary', confusers: ['dairy', 'daily', 'daddy'], sentence: 'I write in my diary every night.', zh: '我每晚写日记。', def: 'n. 日记' },
  { target: 'device', confusers: ['devise', 'desire', 'deceive'], sentence: 'This device helps blind people.', zh: '这个装置帮助盲人。', def: 'n. 装置/设备' },
  { target: 'devise', confusers: ['device', 'desire', 'revise'], sentence: 'We devised a new plan.', zh: '我们设计了一个新方案。', def: 'v. 设计/想出' },
  { target: 'emigrate', confusers: ['immigrate', 'migrate', 'integrate'], sentence: 'Many people emigrate for better jobs.', zh: '许多人移民寻求更好工作。', def: 'v. 移居国外' },
  { target: 'immigrate', confusers: ['emigrate', 'migrate', 'emigrant'], sentence: 'They immigrated to Canada last year.', zh: '他们去年移民加拿大。', def: 'v. 移入（某国）' },
  { target: 'extend', confusers: ['extent', 'intend', 'export'], sentence: 'The road extends to the coast.', zh: '这条路延伸到海岸。', def: 'v. 延伸/延长' },
  { target: 'extent', confusers: ['extend', 'intent', 'export'], sentence: 'To some extent, I agree with you.', zh: '在某种程度上我同意你。', def: 'n. 程度' },
  { target: 'farther', confusers: ['further', 'father', 'feather'], sentence: 'The school is farther than I thought.', zh: '学校比我想的更远。', def: 'adv. 更远（距离）' },
  { target: 'further', confusers: ['farther', 'father', 'feather'], sentence: 'We need to discuss this further.', zh: '我们需要进一步讨论。', def: 'adv. 进一步' },
  { target: 'formal', confusers: ['former', 'format', 'formula'], sentence: 'He sent a formal letter of complaint.', zh: '他寄了一封正式投诉信。', def: 'adj. 正式的' },
  { target: 'former', confusers: ['formal', 'format', 'formula'], sentence: 'The former president visited us.', zh: '前总统来访。', def: 'adj. 前者的/以前的' },
  { target: 'historic', confusers: ['historical', 'hysterical', 'history'], sentence: 'It was a historic victory.', zh: '那是一次历史性的胜利。', def: 'adj. 有历史意义的' },
  { target: 'historical', confusers: ['historic', 'hysterical', 'history'], sentence: 'We read a historical novel.', zh: '我们读了一本历史小说。', def: 'adj. 历史的（关于历史）' },
  { target: 'imitate', confusers: ['intimate', 'estimate', 'intimidate'], sentence: 'Children imitate their parents.', zh: '孩子模仿父母。', def: 'v. 模仿' },
  { target: 'lessen', confusers: ['lesson', 'lens', 'license'], sentence: 'Medicine lessens the pain.', zh: '药物减轻疼痛。', def: 'v. 减轻' },
  { target: 'oral', confusers: ['aural', 'moral', 'coral'], sentence: 'We took an oral exam in English.', zh: '我们参加了英语口试。', def: 'adj. 口头的' },
  { target: 'aural', confusers: ['oral', 'moral', 'coral'], sentence: 'The aural test checks your listening.', zh: '听力测试考查你的听觉。', def: 'adj. 听觉的' },
  { target: 'peace', confusers: ['piece', 'peach', 'pence'], sentence: 'We hope for world peace.', zh: '我们期盼世界和平。', def: 'n. 和平' },
  { target: 'piece', confusers: ['peace', 'peach', 'pence'], sentence: 'Can I have a piece of cake?', zh: '我能来一块蛋糕吗？', def: 'n. 块/片' },
  { target: 'plain', confusers: ['plane', 'plaintiff', 'plank'], sentence: 'She wore a plain white shirt.', zh: '她穿了件朴素的白衬衫。', def: 'adj. 朴素的/清楚的' },
  { target: 'precious', confusers: ['precise', 'previous', 'priceless'], sentence: 'Time is precious to students.', zh: '时间对学生很珍贵。', def: 'adj. 珍贵的' },
  { target: 'precise', confusers: ['precious', 'previous', 'priceless'], sentence: 'Give me a precise answer.', zh: '给我一个准确的回答。', def: 'adj. 精确的' },
  { target: 'sight', confusers: ['site', 'cite', 'sigh'], sentence: 'The sunset was a beautiful sight.', zh: '日落是美丽的景象。', def: 'n. 景象/视力' },
  { target: 'site', confusers: ['sight', 'cite', 'sigh'], sentence: 'This is the site of the new school.', zh: '这是新校址。', def: 'n. 地点/场所' },
  { target: 'storey', confusers: ['story', 'stony', 'stormy'], sentence: 'We live on the third storey.', zh: '我们住在三楼。', def: 'n. 楼层（英）' },
  { target: 'thorough', confusers: ['through', 'though', 'tough'], sentence: 'The police made a thorough search.', zh: '警方做了彻底搜查。', def: 'adj. 彻底的' },
  { target: 'wait', confusers: ['weight', 'waist', 'waste'], sentence: 'Please wait for me here.', zh: '请在这里等我。', def: 'v. 等待' },
  { target: 'weight', confusers: ['wait', 'waist', 'waste'], sentence: 'He lifted a heavy weight.', zh: '他举起了重物。', def: 'n. 重量' },
  { target: 'weak', confusers: ['week', 'weep', 'wreak'], sentence: 'She felt weak after the illness.', zh: '病后她感到虚弱。', def: 'adj. 虚弱的' },
  { target: 'week', confusers: ['weak', 'weep', 'wreck'], sentence: 'There are seven days in a week.', zh: '一周有七天。', def: 'n. 周' },
  { target: 'whose', confusers: ['who\'s', 'whom', 'those'], sentence: 'Whose book is this?', zh: '这是谁的书？', def: 'pron. 谁的' },
  { target: 'bridal', confusers: ['bridle', 'brutal', 'idle'], sentence: 'The bridal gown was elegant.', zh: '婚纱很优雅。', def: 'adj. 婚礼的' },
  { target: 'cereal', confusers: ['serial', 'cellar', 'coral'], sentence: 'I eat cereal for breakfast.', zh: '我早餐吃麦片。', def: 'n. 谷物/麦片' },
  { target: 'serial', confusers: ['cereal', 'cellar', 'coral'], sentence: 'We watched a serial on TV.', zh: '我们看了电视连续剧。', def: 'adj./n. 连续的/连续剧' },
  { target: 'medal', confusers: ['metal', 'mettle', 'model'], sentence: 'He won a gold medal.', zh: '他赢得金牌。', def: 'n. 奖章' },
  { target: 'metal', confusers: ['medal', 'mettle', 'model'], sentence: 'The gate is made of metal.', zh: '门是金属做的。', def: 'n. 金属' },
  { target: 'miner', confusers: ['minor', 'mirror', 'manner'], sentence: 'The miner works underground.', zh: '矿工在地下工作。', def: 'n. 矿工' },
  { target: 'minor', confusers: ['miner', 'mirror', 'manner'], sentence: 'It is only a minor problem.', zh: '这只是个小问题。', def: 'adj. 较小的/次要的' },
];

// ⑧ 形近辨析题目构建（不依赖 wordlist，直接走内置库）
function buildLookalikeQuestions(maxCount = 16) {
  const pool = shuffleArray(CONFUSABLE_PAIRS.slice()).slice(0, maxCount);
  return pool.map(p => ({
    word: p.target,
    confusers: p.confusers,
    sentence: p.sentence,
    chinese: p.zh,
    definition: '',   // 内置库 def 含词性+中文，不作为题目内容展示
    mode: 'lookalike'
  }));
}

app.get('/api/practice/questions', authMiddleware, async (req, res) => {
  if (req.user.type !== 'student') return res.status(403).json({ error: '无权限' });
  const { room_code, mode_type } = req.query;
  const db = readDB();
  const room = db.rooms.find(r => r.room_code === room_code);
  if (!room) return res.status(404).json({ error: '房间不存在' });

  try {
    let questions = [];
    // 确定该模式的期望题目数（与其它模式一致：=分配给该模式的词数，兜底用总词库大小）
    const vocabCount = (room.vocabulary_list || []).length;
    const modeWordCount = (room.mode_word_map && Array.isArray(room.mode_word_map[mode_type]) && room.mode_word_map[mode_type].length > 0)
      ? room.mode_word_map[mode_type].length
      : vocabCount;
    const maxCount = Math.max(2, Math.min(modeWordCount, vocabCount));  // 至少2题，上限不超总词数

    if (mode_type === 'lookalike') {
      // ⑧ 形近辨析：内置库，按期望数量裁剪
      questions = buildLookalikeQuestions(maxCount);
    } else if (mode_type === 'collocation') {
      // ⑨ 搭配拼词：优先 wordlist ∩ 内置库，否则内置库；按期望数量裁剪
      const vocabularyList = room.vocabulary_list || [];
      questions = buildCollocationQuestions(vocabularyList, maxCount);
    } else {
      // 其余模式：按练习模式筛选词汇（优先该模式分配的词）
      let vocabularyList = room.vocabulary_list || [];
      if (mode_type && room.mode_word_map && Array.isArray(room.mode_word_map[mode_type]) && room.mode_word_map[mode_type].length > 0) {
        vocabularyList = room.mode_word_map[mode_type];
      }
      if (vocabularyList.length === 0) {
        return res.status(400).json({ error: '该模式还没有分配词汇' });
      }
      questions = await getQuestionsCached(vocabularyList, room.level);
    }
    res.json(questions);
  } catch (err) {
    console.error('生成题目失败:', err);
    res.status(500).json({ error: '生成题目失败，请稍后重试' });
  }
});

// ==================== 练习记录 ====================

app.post('/api/practice/start', authMiddleware, (req, res) => {
  if (req.user.type !== 'student') return res.status(403).json({ error: '无权限' });
  const { room_code, mode_type } = req.body;
  const db = readDB();
  const room = db.rooms.find(r => r.room_code === room_code);
  if (!room) return res.status(404).json({ error: '房间不存在' });
  // 一次练习可能覆盖多个模式（学生不手动选模式，按老师房间设定练习全部模式）
  // 把每个模式的使用次数都 +1
  db.modeUsage = db.modeUsage || {};
  const modeList = String(mode_type || '').split(',').filter(Boolean);
  const keys = modeList.length > 0 ? modeList : ['unknown'];
  keys.forEach(m => {
    const usageKey = room.id + ':' + m;
    db.modeUsage[usageKey] = (db.modeUsage[usageKey] || 0) + 1;
  });
    const session = {
      id: genId(db.practiceSessions), student_id: req.user.id, room_id: room.id, mode_type: modeList.join(','),
      score: null, total_questions: 0, correct_count: 0,
      elapsed_time: 0, pause_count: 0,
      started_at: new Date().toISOString(), finished_at: null
    };
  db.practiceSessions.push(session);
  writeDB(db);
  // 增量直写（绕过全表 TRUNCATE）
  pgDirectInsertSession(session).catch(e => console.error('⚠️ 练习会话直写 PG 失败：', e.message));
  keys.forEach(m => {
    const usageKey = room.id + ':' + m;
    pgDirectUpsertModeUsage(usageKey, db.modeUsage[usageKey]).catch(e => console.error('⚠️ 模式使用计数直写 PG 失败：', e.message));
  });
  res.json({ sessionId: session.id });
});

app.post('/api/practice/answer', authMiddleware, (req, res) => {
  if (req.user.type !== 'student') return res.status(403).json({ error: '无权限' });
  const { session_id, question, student_answer, correct_answer, word, is_correct, mode, uid } = req.body;
  const db = readDB();
  const answer = {
    id: genId(db.practiceAnswers),
    session_id: parseInt(session_id),
    question, student_answer, correct_answer, word, uid,
    is_correct: is_correct ? 1 : 0,
    answered_at: new Date().toISOString()
  };
  db.practiceAnswers.push(answer);
  const stat = updateWordStats(db, req.user.id, parseInt(session_id), word, is_correct);
  // 断点续做进度记录
  db.studentProgress = db.studentProgress || [];
  const session = db.practiceSessions.find(s => s.id === parseInt(session_id));
  let progress = null;
  if (session && word) {
    progress = {
      id: genId(db.studentProgress),
      student_id: req.user.id,
      room_id: session.room_id,
      word,
      mode: mode || session.mode_type || 'unknown',
      is_correct: is_correct ? 1 : 0,
      answered_at: new Date().toISOString()
    };
    db.studentProgress.push(progress);
  }
  writeDB(db);
  // 增量直写（绕过全表 TRUNCATE）
  pgDirectInsertAnswer(answer).catch(e => console.error('⚠️ 答案直写 PG 失败：', e.message));
  if (stat) pgDirectUpsertWordStat(stat).catch(e => console.error('⚠️ 词统计直写 PG 失败：', e.message));
  if (progress) pgDirectInsertProgress(progress).catch(e => console.error('⚠️ 进度直写 PG 失败：', e.message));
  res.json({ message: '答案已记录' });
});

app.post('/api/practice/finish', authMiddleware, (req, res) => {
  if (req.user.type !== 'student') return res.status(403).json({ error: '无权限' });
    const { session_id, score, total_questions, correct_count, elapsed_time, pause_count } = req.body;
    const db = readDB();
    const session = db.practiceSessions.find(s => s.id === parseInt(session_id));
    if (session) {
      session.score = score;
      session.total_questions = total_questions;
      session.correct_count = correct_count;
      if (elapsed_time !== undefined) session.elapsed_time = Math.max(0, parseInt(elapsed_time) || 0);
      if (pause_count !== undefined) session.pause_count = Math.max(0, parseInt(pause_count) || 0);
      session.finished_at = new Date().toISOString();
    writeDB(db);
    // 增量更新会话成绩（绕过全表 TRUNCATE）
    pgDirectUpdateSessionFinish(session).catch(e => console.error('⚠️ 练习结束直写 PG 失败：', e.message));
  }
  res.json({ message: '练习会话已结束' });
});

function updateWordStats(db, student_id, session_id, word, is_correct) {
  const session = db.practiceSessions.find(s => s.id === session_id);
  if (!session) return null;
  let stat = db.wordStats.find(ws => ws.student_id === student_id && ws.room_id === session.room_id && ws.word === word);
  if (stat) {
    stat.total_attempts += 1;
    if (!is_correct) stat.error_count += 1;
    stat.error_rate = parseFloat(((stat.error_count / stat.total_attempts) * 100).toFixed(2));
    stat.updated_at = new Date().toISOString();
  } else {
    stat = {
      id: genId(db.wordStats),
      student_id,
      room_id: session.room_id,
      word,
      pos: null,
      error_count: is_correct ? 0 : 1,
      total_attempts: 1,
      error_rate: is_correct ? 0 : 100,
      updated_at: new Date().toISOString()
    };
    db.wordStats.push(stat);
  }
  return stat;
}

// ==================== 学生房间列表（含进度，用于首页展示/续做） ====================

app.get('/api/student/rooms', authMiddleware, (req, res) => {
  if (req.user.type !== 'student') return res.status(403).json({ error: '无权限' });
  const db = readDB();
  db.studentProgress = db.studentProgress || [];
  const joined = db.studentRooms.filter(sr => sr.student_id === req.user.id);
  const result = joined.map(sr => {
    const room = db.rooms.find(r => r.id === sr.room_id);
    if (!room) return null;
    const modes = room.practice_modes || [];
    // 统计该房间内已答题目数
    const progress = db.studentProgress.filter(p => p.student_id === req.user.id && p.room_id === room.id);
    const answeredCount = new Set(progress.map(p => p.word + ':' + p.mode)).size;
    const totalWords = (room.vocabulary_list || []).length;
    // 总题目数估算（每个词×模式数）
    const estimatedTotal = totalWords * modes.length;
    return {
      room_id: room.id,
      room_code: room.room_code,
      modes,
      word_count: totalWords,
      answered_count: answeredCount,
      estimated_total: estimatedTotal,
      joined_at: sr.joined_at,
      note: sr.note || '',
      level: room.level || '6',
      progress_pct: estimatedTotal > 0 ? Math.round((answeredCount / estimatedTotal) * 100) : 0
    };
  }).filter(Boolean);
  res.json(result);
});

// ==================== 学生最近一次已完成 session（用于重进恢复） ====================

app.get('/api/student/room/:room_code/session/latest', authMiddleware, (req, res) => {
  if (req.user.type !== 'student') return res.status(403).json({ error: '无权限' });
  const { room_code } = req.params;
  const db = readDB();
  const room = db.rooms.find(r => r.room_code === room_code);
  if (!room) return res.status(404).json({ error: '房间不存在' });
  const finished = db.practiceSessions
    .filter(s => s.student_id === req.user.id && s.room_id === room.id && s.finished_at)
    .sort((a, b) => new Date(b.finished_at) - new Date(a.finished_at));
  if (finished.length === 0) return res.json({ session: null, answers: [] });
  const latest = finished[0];
  const answers = db.practiceAnswers
    .filter(a => a.session_id === latest.id)
    .map(a => ({
      uid: a.uid || null,
      word: a.word,
      student_answer: a.student_answer,
      correct_answer: a.correct_answer,
      is_correct: a.is_correct === 1
    }));
  res.json({
    session: {
      session_id: latest.id,
      finished_at: latest.finished_at,
      score: latest.score,
      total_questions: latest.total_questions,
      correct_count: latest.correct_count,
      elapsed_time: latest.elapsed_time || 0,
      pause_count: latest.pause_count || 0
    },
    answers
  });
});

// ==================== 断点续做：查询该房间已答题目 ====================

app.get('/api/practice/resume', authMiddleware, (req, res) => {
  if (req.user.type !== 'student') return res.status(403).json({ error: '无权限' });
  const { room_code } = req.query;
  if (!room_code) return res.status(400).json({ error: '缺少 room_code' });
  const db = readDB();
  db.studentProgress = db.studentProgress || [];
  const room = db.rooms.find(r => r.room_code === room_code);
  if (!room) return res.status(404).json({ error: '房间不存在' });
  const progress = db.studentProgress.filter(p => p.student_id === req.user.id && p.room_id === room.id);
  // 去重：每个 word+mode 取最后一条
  const map = {};
  progress.forEach(p => {
    const key = p.word + ':' + p.mode;
    if (!map[key] || new Date(p.answered_at) > new Date(map[key].answered_at)) map[key] = p;
  });
  const result = Object.values(map).map(p => ({
    word: p.word,
    mode: p.mode,
    is_correct: p.is_correct
  }));
  res.json(result);
});

// ==================== 学生历史数据 ====================

app.get('/api/student/history', authMiddleware, (req, res) => {
  if (req.user.type !== 'student') return res.status(403).json({ error: '无权限' });
  const db = readDB();
  const sessions = db.practiceSessions.filter(s => s.student_id === req.user.id && s.finished_at);
  const history = sessions.map(s => {
    const room = db.rooms.find(r => r.id === s.room_id);
    return {
      session_id: s.id,
      room_code: room ? room.room_code : '未知',
      mode_type: s.mode_type,
      score: s.score,
      total_questions: s.total_questions,
      correct_count: s.correct_count,
      finished_at: s.finished_at,
      note: s.note || ''
    };
  }).sort((a, b) => new Date(b.finished_at) - new Date(a.finished_at));
  res.json(history);
});

// 保存某条练习历史的备注
app.post('/api/student/history/note', authMiddleware, (req, res) => {
  if (req.user.type !== 'student') return res.status(403).json({ error: '无权限' });
  const { session_id, note } = req.body;
  if (!session_id) return res.status(400).json({ error: '缺少 session_id' });
  const db = readDB();
  const session = db.practiceSessions.find(s => s.id === parseInt(session_id) && s.student_id === req.user.id);
  if (!session) return res.status(404).json({ error: '记录不存在' });
  session.note = (note || '').toString().slice(0, 200);
  writeDB(db);
  pgDirectUpdateSessionNote(session_id, session.note).catch(e => console.error('⚠️ 历史备注直写 PG 失败：', e.message));
  res.json({ message: '备注已保存', note: session.note });
});

app.post('/api/student/history/delete', authMiddleware, (req, res) => {
  if (req.user.type !== 'student') return res.status(403).json({ error: '无权限' });
  const { session_id } = req.body;
  if (!session_id) return res.status(400).json({ error: '缺少 session_id' });
  const db = readDB();
  const idx = db.practiceSessions.findIndex(s => s.id === parseInt(session_id) && s.student_id === req.user.id);
  if (idx === -1) return res.status(404).json({ error: '记录不存在' });
  db.practiceSessions.splice(idx, 1);
  writeDB(db);
  // 级联删除会话及其答案（增量，绝不全表 TRUNCATE）
  pgDirectDeleteSession(session_id).catch(e => console.error('⚠️ 历史删除直写 PG 失败：', e.message));
  res.json({ message: '已删除练习记录' });
});

/* ── 查词代理（英文释义 + 中文翻译）── */
app.get('/api/lookup', authMiddleware, async (req, res) => {
  const { word } = req.query;
  if (!word || !word.trim()) return res.status(400).json({ error: '缺少 word 参数' });
  const w = word.trim();

  try {
    // 1) 英文释义 + 音标（Free Dictionary API）
    let phonetic = '', definition = '', meanings = [];
    try {
      const engRes = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(w)}`, { timeout: 6000 });
      if (engRes.ok) {
        const data = await engRes.json();
        const first = Array.isArray(data) ? data[0] : data;
        phonetic = first.phonetic || (first.phonetics && first.phonetics.find(p => p.text)?.text) || '';
        // 收集前 2 个不同词性的释义
        if (first.meanings) {
          for (const m of first.meanings.slice(0, 2)) {
            const def = m.definitions?.[0]?.definition;
            if (def) meanings.push({ pos: m.partOfSpeech, def });
          }
        }
        definition = meanings.length > 0 ? meanings[0].def : '';
      }
    } catch (_) { /* 英文源不可达时继续尝试中文 */ }

    // 2) 中文翻译（MyMemory 免费 API，无需 key）
    let chinese = [];
    try {
      const cnRes = await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(w)}&langpair=en|zh-CN`, { timeout: 6000 });
      if (cnRes.ok) {
        const cnData = await cnRes.json();
        const t = cnData.responseData?.translatedText;
        if (t && t !== w && t.toUpperCase() !== w.toUpperCase()) {
          // 按"；/、" 分割，取最多 2 个
          const parts = t.split(/[；;、]/).map(s => s.trim()).filter(Boolean);
          chinese = parts.slice(0, 2);
        }
      }
    } catch (_) { /* 中文源不可达则 chinese 为空 */ }

    res.json({ word: w, phonetic, definition, meanings, chinese });
  } catch (e) {
    res.status(500).json({ error: '查词服务暂时不可用' });
  }
});

app.get('/api/student/weak-words', authMiddleware, async (req, res) => {
  if (req.user.type !== 'student') return res.status(403).json({ error: '无权限' });
  const { sort = 'error_rate', order = 'desc', min_error_rate, search, limit } = req.query;
  const db = readDB();
  let weakWords = db.wordStats.filter(ws => ws.student_id === req.user.id);

  // 筛选：最低错误率
  if (min_error_rate !== undefined && min_error_rate !== '') {
    const min = parseFloat(min_error_rate);
    if (!isNaN(min)) weakWords = weakWords.filter(ws => ws.error_rate >= min);
  }
  // 筛选：关键词
  if (search) {
    const s = String(search).toLowerCase();
    weakWords = weakWords.filter(ws => ws.word.toLowerCase().includes(s));
  }

  // 排序
  weakWords.sort((a, b) => {
    let av, bv;
    if (sort === 'total_attempts') { av = a.total_attempts; bv = b.total_attempts; }
    else if (sort === 'error_count') { av = a.error_count; bv = b.error_count; }
    else if (sort === 'recent') { av = new Date(a.updated_at || 0).getTime(); bv = new Date(b.updated_at || 0).getTime(); }
    else { av = a.error_rate; bv = b.error_rate; }
    if (av === bv) return 0;
    const r = av > bv ? 1 : -1;
    return order === 'asc' ? -r : r;
  });

  if (limit !== undefined && limit !== '') {
    const lim = parseInt(limit);
    if (!isNaN(lim) && lim > 0) weakWords = weakWords.slice(0, lim);
  }

  // 兜底清洗：历史脏数据（早期版本存入的 "awareness n"）在读取时也需净化
  const base = weakWords.map(w => ({ ...w, word: cleanWordEntry(w.word) }));

  // 为每词并行抓取真实词典例句（含该词本身的真实语境句，非模板套句）；
  // 模块级缓存复用，失败优雅降级，绝不阻断响应。整体加 9s 超时护栏，
  // 外部 API 过慢时直接返回无例句的主数据，不让薄弱词接口整体卡死。
  let enriched = base;
  try {
    const enrichment = Promise.allSettled(
      base.slice(0, 50).map(async (w) => {
        const ex = await fetchWordExample(w.word);
        return { ...w, example_en: ex.example_en, example_zh: ex.example_zh, word_zh: ex.word_zh };
      })
    );
    const guard = new Promise((resolve) => setTimeout(() => resolve(null), 9000));
    const results = await Promise.race([enrichment, guard]);
    if (results) {
      enriched = base.map((w, i) => (results[i] && results[i].status === 'fulfilled' ? results[i].value : w));
    }
  } catch (_) {
    // 任何意外都不影响薄弱词主数据返回
  }

  res.json(enriched);
});

// ==================== 教师数据查询 ====================

app.get('/api/teacher/room/:roomId/students', authMiddleware, (req, res) => {
  if (req.user.type !== 'teacher') return res.status(403).json({ error: '无权限' });
  const db = readDB();
  const roomId = parseInt(req.params.roomId);
  // 合并：正式加入的学生 + 有过已完成练习记录但没点加入的学生（去重）
  // 要求练习记录必须 finished_at 且 total_questions > 0，过滤掉"点开即走"的空会话（幽灵学生）
  const joinedIds = db.studentRooms.filter(sr => Number(sr.room_id) === roomId).map(sr => sr.student_id);
  // 只统计有 finished_at 且至少答了1题的已完成会话
  const meaningfulSessions = db.practiceSessions.filter(ps =>
    Number(ps.room_id) === roomId && ps.finished_at && (ps.total_questions || 0) > 0
  );
  const practiceIds = meaningfulSessions
    .map(ps => ps.student_id)
    .filter(id => !joinedIds.includes(id));
  const studentIds = [...new Set([...joinedIds, ...practiceIds])];
  const students = db.students.filter(s => studentIds.includes(s.id)).map(s => {
    const sessions = db.practiceSessions.filter(ps => ps.student_id === s.id && Number(ps.room_id) === roomId);
    const finishedSessions = sessions.filter(ps => ps.finished_at);
    const totalQ = sessions.reduce((a, b) => a + (b.total_questions || 0), 0);
    const totalC = sessions.reduce((a, b) => a + (b.correct_count || 0), 0);
    const overallAccuracy = totalQ > 0 ? Math.round((totalC / totalQ) * 100) : 0;
    const lastSubmitted = finishedSessions.length
      ? finishedSessions.reduce((mx, ps) => ps.finished_at > mx ? ps.finished_at : mx, finishedSessions[0].finished_at)
      : null;
    const { password_hash, ...safeStudent } = s;
    return { ...safeStudent, practice_count: sessions.length, avg_score: 0, overall_accuracy: overallAccuracy, submitted: finishedSessions.length > 0, last_submitted_at: lastSubmitted };
  });
  res.json(students);
});

// 获取某学生在房间内的逐题正误详情（用于教师展开查看 / 导出）
app.get('/api/teacher/room/:roomId/student/:studentId/details', authMiddleware, (req, res) => {
  if (req.user.type !== 'teacher') return res.status(403).json({ error: '无权限' });
  const db = readDB();
  const roomId = parseInt(req.params.roomId);
  const studentId = parseInt(req.params.studentId);
  const sessions = db.practiceSessions.filter(ps => ps.student_id === studentId && Number(ps.room_id) === roomId && ps.finished_at);
  const result = sessions.map(s => {
    const answers = db.practiceAnswers
      .filter(a => a.session_id === s.id)
      .map(a => ({
        word: cleanWordEntry(a.word),
        is_correct: a.is_correct === 1,
        student_answer: cleanWordEntry(a.student_answer),
        correct_answer: cleanWordEntry(a.correct_answer)
      }));
    return {
      session_id: s.id,
      finished_at: s.finished_at,
      score: s.score,
      total_questions: s.total_questions,
      correct_count: s.correct_count,
      elapsed_time: s.elapsed_time || 0,
      pause_count: s.pause_count || 0,
      accuracy: s.total_questions ? Math.round((s.correct_count / s.total_questions) * 100) : 0,
      answers
    };
  }).sort((a, b) => new Date(a.finished_at) - new Date(b.finished_at));
  res.json(result);
});

app.get('/api/teacher/room/:roomId/word-stats', authMiddleware, (req, res) => {
  if (req.user.type !== 'teacher') return res.status(403).json({ error: '无权限' });
  const db = readDB();
  const roomId = parseInt(req.params.roomId);
  // 验证房间属于该教师
  const room = db.rooms.find(r => r.id === roomId);
  if (!room || room.teacher_id !== req.user.id) return res.status(403).json({ error: '无权限' });
  res.json(db.wordStats.filter(ws => Number(ws.room_id) === roomId).map(w => ({ ...w, word: cleanWordEntry(w.word) })).sort((a, b) => b.error_rate - a.error_rate));
});

// ==================== 管理员功能 ====================

app.get('/api/admin/teachers', authMiddleware, (req, res) => {
  if (req.user.type !== 'admin') return res.status(403).json({ error: '无权限' });
  const db = readDB();
  res.json(db.teachers);
});

app.get('/api/admin/students', authMiddleware, (req, res) => {
  if (req.user.type !== 'admin') return res.status(403).json({ error: '无权限' });
  const db = readDB();
  res.json(db.students);
});

app.put('/api/admin/teacher/:id/status', authMiddleware, (req, res) => {
  if (req.user.type !== 'admin') return res.status(403).json({ error: '无权限' });
  const db = readDB();
  const teacher = db.teachers.find(t => t.id === parseInt(req.params.id));
  if (!teacher) return res.status(404).json({ error: '教师不存在' });
  teacher.is_active = req.body.is_active;
  writeDB(db);
  pgDirectUpdateTeacherStatus(teacher.id, teacher.is_active).catch(e => console.error('⚠️ 教师状态直写 PG 失败：', e.message));
  res.json({ message: '状态已更新' });
});

// ==================== 托管前端构建产物（生产部署用） ====================
// 部署时前端已 build 到 ../frontend/dist，后端单端口同时服务前后端。
const distDir = path.join(__dirname, '..', 'frontend', 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  // SPA 回退：非 /api 请求一律返回 index.html
  app.get(/^(?!\/api).*/, (req, res) => {
    res.sendFile(path.join(distDir, 'index.html'));
  });
} else {
  console.warn('⚠️  未找到前端构建目录 ../frontend/dist，请先运行 `npm run build`（仅后端模式，仅供 API 调试）。');
}

// ==================== 启动服务器 ====================

(async () => {
  try {
    await initDB();
    // 启动后立即验证 PG 模式是否生效
    const { isPG } = require('./database');
    if (isPG()) {
      console.log('🔑 数据持久化模式: ✅ PostgreSQL（推送代码不会丢失数据）');
      console.log('   DATABASE_URL:', process.env.DATABASE_URL ? '已配置 (长度:' + process.env.DATABASE_URL.length + ')' : '❌ 未配置！');
    } else {
      console.log('🔑 数据持久化模式: ⚠️ JSON 文件模式（Railway 部署会丢失数据！）');
      console.log('   原因: DATABASE_URL 未设置 或 PostgreSQL 连接失败');
      console.log('   请检查 Railway Variables 中是否正确设置了 DATABASE_URL');
    }
  } catch(e) {
    console.error('数据库初始化失败:', e.message);
  }
  app.listen(PORT, '0.0.0.0', () => console.log(`服务器运行在 http://0.0.0.0:${PORT}`));
})();
