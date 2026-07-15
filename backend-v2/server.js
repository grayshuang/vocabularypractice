const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const { readDB, writeDB, genId, initDB } = require('./database');
require('dotenv').config();

const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY || 'sk-ws-H.EMMRIEX.R8AI.MEYCIQDJ1GJsAv151M-597KePV61HGBgNvQCCeSMk8t_cgSQ_gIhAN4qPEm62ug1YIIA4Qq920SmNn3JM2f13MpGhSCYy2a9';
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

app.post('/api/student/register', (req, res) => {
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

app.post('/api/teacher/register', (req, res) => {
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
  res.json({ message: '房间创建成功', room_code, roomId: room.id });
});

app.get('/api/teacher/rooms', authMiddleware, (req, res) => {
  if (req.user.type !== 'teacher') return res.status(403).json({ error: '无权限' });
  const db = readDB();
  const rooms = db.rooms.filter(r => r.teacher_id === req.user.id).map(room => {
    const joinedCount = db.studentRooms.filter(sr => sr.room_id === room.id).length;
    const practiceStudentIds = db.practiceSessions
      .filter(ps => ps.room_id === room.id)
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
  // 统计学生人数（合并 studentRooms + practiceSessions 去重）
  const joinedIds = db.studentRooms.filter(sr => sr.room_id === room.id).map(sr => sr.student_id);
  const practiceIds = db.practiceSessions
    .filter(ps => Number(ps.room_id) === room.id)
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

app.post('/api/room/join', authMiddleware, (req, res) => {
  if (req.user.type !== 'student') return res.status(403).json({ error: '无权限' });
  const { room_code } = req.body;
  const db = readDB();
  const room = db.rooms.find(r => r.room_code === room_code);
  if (!room) return res.status(404).json({ error: '房间不存在' });
  const exists = db.studentRooms.some(sr => sr.student_id === req.user.id && sr.room_id === room.id);
  if (!exists) {
    db.studentRooms.push({ id: genId(db.studentRooms), student_id: req.user.id, room_id: room.id, joined_at: new Date().toISOString(), note: '' });
    writeDB(db);
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
const FALLBACK_TEMPLATES = {
  adj: [
    { t: "Many people consider {w} to be an essential quality in modern society.", c: "许多人认为{w}是现代社会中一种必不可少的品质。" },
    { t: "Being {w} can have a significant impact on one's personal and professional life.", c: "{w}会对一个人的生活和事业产生重大影响。" },
    { t: "In today's competitive world, it is increasingly important to remain {w}.", c: "在当今竞争激烈的世界中，保持{w}变得越来越重要。" },
    { t: "Those who are {w} tend to achieve greater success in their endeavors.", c: "那些{w}的人往往在他们的努力中取得更大的成功。" },
    { t: "I believe that being {w} is far more valuable than having natural talent.", c: "我相信，{w}比拥有天赋更有价值。" },
  ],
  n: [
    { t: "The concept of {w} has gained increasing attention in recent years.", c: "近年来，{w}这一概念越来越受到关注。" },
    { t: "Many experts argue that {w} plays a crucial role in our daily lives.", c: "许多专家认为，{w}在我们的日常生活中起着至关重要的作用。" },
    { t: "Without proper {w}, it would be difficult to maintain a healthy lifestyle.", c: "如果没有适当的{w}，很难维持健康的生活方式。" },
    { t: "The importance of {w} cannot be overstated when it comes to personal development.", c: "就个人发展而言，{w}的重要性怎么强调都不为过。" },
    { t: "A growing number of people have come to appreciate the value of {w}.", c: "越来越多的人开始认识到{w}的价值。" },
  ],
  v: [
    { t: "If we want to succeed, we must learn how to {w} effectively.", c: "如果我们想成功，就必须学会如何有效地{w}。" },
    { t: "Those who consistently {w} are more likely to achieve their goals.", c: "那些持续{w}的人更有可能实现他们的目标。" },
    { t: "It is essential to {w} if we wish to make progress in this area.", c: "如果我们希望在这个领域取得进步，{w}是必不可少的。" },
    { t: "Many people fail to realize the importance of learning to {w}.", c: "许多人没有意识到学会{w}的重要性。" },
    { t: "The ability to {w} properly distinguishes successful people from others.", c: "正确{w}的能力是成功者与普通人的区别所在。" },
  ],
  phrase: [
    { t: "In many cultures, people often {w} as a sign of respect or affection.", c: "在许多文化中，人们经常{w}，以此表示尊重或喜爱。" },
    { t: "It is quite common to {w} in close relationships.", c: "在亲密关系中，{w}是很常见的。" },
    { t: "When you {w}, it shows that you truly care about the other person.", c: "当你{w}时，表明你真正关心对方。" },
    { t: "Most people would agree that it is better to {w} than to ignore the issue.", c: "大多数人会同意，与其忽视这个问题，不如{w}。" },
  ]
};

const BATCH_SIZE = 10;

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
1. 每个词必须生成一个独立、不同的句子。绝对禁止所有词使用相同句型！
2. 句子中用 ______ 表示空白处，正确答案就是该词本身
3. 句子必须是雅思口语Part3的回答风格（复杂句型：让步状语从句、定语从句、分词结构等）
4. 必须正确判断并使用该词的词性（adj/v/n/adv/phrase），确保语法完全正确
5. 干扰项必须与正确答案词性相同、难度相当、但意思不同
6. chinese 字段必须是对应英文句子的**完整中文翻译**（逐字对应级别），要涵盖英文句子中的**每一个**信息点，不能省略任何从句、修饰语或细节。学生需要靠中文理解整句英文的全部含义。
7. 句子（含空白标记 ______，空白计 1 个词）总长度建议控制在 25 个单词以内，允许适度使用雅思常见复杂句型（让步状语从句、定语从句、分词结构等），但避免过于冗长的嵌套从句链
8. **以下字段绝对禁止包含任何中文字符**：word、options、correct_answer、definition、option_defs。这些字段必须100%纯英文。只有 chinese 字段可以包含中文。

【字段说明】
- word: **纯英文词汇**（仅英文单词，禁止包含中文、词性标注或释义）
- pos: 词性 (adj/n/v/adv/phrase)
- sentence: 含______的完整句子
- options: [正确答案, 干扰项1, 干扰项2, 干扰项3] 共4个（每个仅英文单词）
- correct_answer: 正确答案（仅英文单词）
- topic_category: 雅思话题类别（从以下选一个）：教育类/科技类/环境类/社会类/政府类/文化类/健康类/工作类/媒体类/犯罪类/全球化类/城市化类
- thinking_tag: 思路标签（从以下选一个）：人际/身心/学习/经济/效率/环境/科技/减压/好恶/性格/能力/规划
- template: 逻辑句型模板（如 "While it's universally believed that..., I'd rather say..."）
- definition: **纯英文**简单短释义（5-10个单词，禁止包含任何中文字符）
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
- 每个词的句子必须不同！根据词义量身定制句子内容
- 一共生成 ${wordBatch.length} 道
- 只返回JSON数组`;

  try {
    console.log(`AI生成题目 - 批次 ${batchIndex + 1}/${totalBatches}，词汇数：${wordBatch.length}`);

    const response = await axios.post(DASHSCOPE_API_URL, {
      model: 'qwen-plus',
      messages: [
        { role: 'system', content: '你是雅思口语专家。只返回JSON数组，不要解释，不要markdown代码块。每个词汇必须有独特、贴合词义的句子。' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.7,
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

    // 安全清洗：确保 word/options/correct_answer/definition/option_defs 不含中文（AI 偶尔会在这些字段混入中文/词性标注）
    const CHINESE_RE = /[\u4e00-\u9fff\u3400-\u4dbf]/;
    const stripChinese = (s) => {
      if (typeof s !== 'string') return s;
      // 去掉中文及前后可能附着的 "adj./v./n./adv./phrase" 标注和多余空白
      return s.replace(/\s*(?:adj\.?|v\.?|n\.?|adv\.?|phrase\.?)\s*[\u4e00-\u9fff\u3400-\u4dbf][\u4e00-\u9fff\s（）()""''「」【】、。！？：；—…·]*$/, '').trim()
             .replace(/^[""\s]+|[""\s]+$/g, '').trim() || s;
    };
    questions.forEach(q => {
      if (!q) return;
      if (q.word) q.word = stripChinese(q.word);
      if (q.correct_answer) q.correct_answer = stripChinese(q.correct_answer);
      if (q.definition) q.definition = stripChinese(q.definition);
      if (Array.isArray(q.options)) q.options = q.options.map(stripChinese);
      if (Array.isArray(q.option_defs)) q.option_defs = q.option_defs.map(stripChinese);
    });

    console.log(`批次 ${batchIndex + 1} AI生成成功，题目数：`, questions.length);
    return questions;
  } catch (err) {
    console.error(`批次 ${batchIndex + 1} AI生成失败：`, err.message);
    // 高质量降级模板生成（每个词有独立句子）
    return generateFallback(wordBatch, level, batchIndex);
  }
}

/**
 * 高质量降级方案：每个词汇都有独立的不同句子
 */
function generateFallback(words, level, batchIndex) {
  return words.map((word, i) => {
    // 简单词性猜测
    let pos = 'n';
    if (word.length <= 4 && /^[a-z]+$/i.test(word)) pos = 'adj';
    else if (/^(be |get |go |take |make |have |do |set |put |bring |fall |grow|look|come)/i.test(word)) pos = 'v';
    else if (word.includes(' ') || word.includes('-')) pos = 'phrase';

    const templateBank = FALLBACK_TEMPLATES[pos] || FALLBACK_TEMPLATES.n;
    const tmpl = templateBank[(i + batchIndex * BATCH_SIZE) % templateBank.length];
    const sentence = truncateSentence(tmpl.t.replace('{w}', '________'), 28);
    const chinese = tmpl.c.replace('{w}', word);

    // 从同批其他词中取干扰项
    const others = words.filter(w => w !== word).sort(() => Math.random() - 0.5).slice(0, 3);
    const options = [word, ...others].sort(() => Math.random() - 0.5);

    const topicCat = TOPIC_CATEGORIES[(i + batchIndex) % TOPIC_CATEGORIES.length];
    const thinkTag = THINKING_TAGS[i % THINKING_TAGS.length];
    const pattern = SENTENCE_PATTERNS[i % SENTENCE_PATTERNS.length];

    return {
      word,
      pos,
      sentence,
      options,
      correct_answer: word,
      topic_category: topicCat,
      thinking_tag: thinkTag,
      template: pattern,
      definition: `meaning of "${word}"`,
      option_defs: options.map(o => `the word "${o}"`),
      chinese
    };
  });
}

/**
 * 分批调用AI生成所有题目
 */
async function generateQuestionsWithAI(vocabularyList, level) {
  if (!vocabularyList || vocabularyList.length === 0) return [];

  // 如果词汇数 <= BATCH_SIZE，直接生成
  if (vocabularyList.length <= BATCH_SIZE) {
    return await generateBatchWithAI(vocabularyList, level, 0, 1);
  }

  // 分批生成
  const totalBatches = Math.ceil(vocabularyList.length / BATCH_SIZE);
  const batchPromises = [];

  for (let i = 0; i < vocabularyList.length; i += BATCH_SIZE) {
    const batch = vocabularyList.slice(i, i + BATCH_SIZE);
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
  const db = readDB();
  const bank = db.wordBank || [];
  const result = [];
  const missing = [];

  for (const w of vocabularyList) {
    const key = w.toLowerCase();
    // 命中条件：同词且同目标水平（不同水平生成不同难度的句子）
    const hit = bank.find(b => b.word.toLowerCase() === key && (b.level || '6') === lv);
    if (hit) {
      result.push(applyWordCase(hit, w));
    } else {
      missing.push(w);
    }
  }

  if (missing.length > 0) {
    console.log('词库缓存未命中，调用AI生成新词：', missing, '水平：', lv);
    const generated = await generateQuestionsWithAI(missing, lv);
    generated.forEach(q => {
      const key = (q.word || '').toLowerCase();
      if (key && !bank.find(b => b.word.toLowerCase() === key && (b.level || '6') === lv)) {
        bank.push({
          word: q.word,
          level: lv,
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
        });
      }
      result.push(shuffleQuestion({ ...q, sentence: ensureBlank(q.sentence, q.word) }));
    });
    db.wordBank = bank;
    writeDB(db);
    console.log('词库缓存已更新，当前词条数：', bank.length);
  }

  return result;
}

// 正则转义
function escapeRegExp(s) {
  return (s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
function buildCollocationQuestions(vocabularyList) {
  const lowerSet = new Set((vocabularyList || []).map(w => String(w).toLowerCase()));
  // 优先用老师 wordlist 中能匹配到搭配的词，否则用内置全部
  let pool = IELTS_COLLOCATIONS.filter(c => lowerSet.has(c.base.toLowerCase()));
  if (pool.length === 0) pool = IELTS_COLLOCATIONS.slice();
  pool = shuffleArray(pool).slice(0, 20);
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
function buildLookalikeQuestions() {
  const pool = shuffleArray(CONFUSABLE_PAIRS.slice()).slice(0, 16);
  return pool.map(p => ({
    word: p.target,
    confusers: p.confusers,
    sentence: p.sentence,
    chinese: p.zh,
    definition: p.def,
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
    if (mode_type === 'lookalike') {
      // ⑧ 形近辨析：内置库，不读 wordlist
      questions = buildLookalikeQuestions();
    } else if (mode_type === 'collocation') {
      // ⑨ 搭配拼词：优先 wordlist ∩ 内置库，否则内置库
      const vocabularyList = room.vocabulary_list || [];
      questions = buildCollocationQuestions(vocabularyList);
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
  res.json({ sessionId: session.id });
});

app.post('/api/practice/answer', authMiddleware, (req, res) => {
  if (req.user.type !== 'student') return res.status(403).json({ error: '无权限' });
  const { session_id, question, student_answer, correct_answer, word, is_correct, mode, uid } = req.body;
  const db = readDB();
  db.practiceAnswers.push({
    id: genId(db.practiceAnswers),
    session_id: parseInt(session_id),
    question, student_answer, correct_answer, word, uid,
    is_correct: is_correct ? 1 : 0,
    answered_at: new Date().toISOString()
  });
  if (word) updateWordStats(db, req.user.id, parseInt(session_id), word, is_correct);
  // 断点续做进度记录
  db.studentProgress = db.studentProgress || [];
  const session = db.practiceSessions.find(s => s.id === parseInt(session_id));
  if (session && word) {
    db.studentProgress.push({
      id: genId(db.studentProgress),
      student_id: req.user.id,
      room_id: session.room_id,
      word,
      mode: mode || session.mode_type || 'unknown',
      is_correct: is_correct ? 1 : 0,
      answered_at: new Date().toISOString()
    });
  }
  writeDB(db);
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
  }
  res.json({ message: '练习会话已结束' });
});

function updateWordStats(db, student_id, session_id, word, is_correct) {
  const session = db.practiceSessions.find(s => s.id === session_id);
  if (!session) return;
  const stat = db.wordStats.find(ws => ws.student_id === student_id && ws.room_id === session.room_id && ws.word === word);
  if (stat) {
    stat.total_attempts += 1;
    if (!is_correct) stat.error_count += 1;
    stat.error_rate = parseFloat(((stat.error_count / stat.total_attempts) * 100).toFixed(2));
    stat.updated_at = new Date().toISOString();
  } else {
    db.wordStats.push({
      id: genId(db.wordStats),
      student_id,
      room_id: session.room_id,
      word,
      pos: null,
      error_count: is_correct ? 0 : 1,
      total_attempts: 1,
      error_rate: is_correct ? 0 : 100,
      updated_at: new Date().toISOString()
    });
  }
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

app.get('/api/student/weak-words', authMiddleware, (req, res) => {
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
  res.json(weakWords);
});

// ==================== 教师数据查询 ====================

app.get('/api/teacher/room/:roomId/students', authMiddleware, (req, res) => {
  if (req.user.type !== 'teacher') return res.status(403).json({ error: '无权限' });
  const db = readDB();
  const roomId = parseInt(req.params.roomId);
  // 合并：正式加入的学生 + 有过练习记录但没点加入的学生（去重）
  const joinedIds = db.studentRooms.filter(sr => sr.room_id === roomId).map(sr => sr.student_id);
  const practiceIds = db.practiceSessions
    .filter(ps => Number(ps.room_id) === roomId)
    .map(ps => ps.student_id)
    .filter(id => !joinedIds.includes(id));
  const studentIds = [...new Set([...joinedIds, ...practiceIds])];
  const students = db.students.filter(s => studentIds.includes(s.id)).map(s => {
    const sessions = db.practiceSessions.filter(ps => ps.student_id === s.id && ps.room_id === roomId);
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
  const sessions = db.practiceSessions.filter(ps => ps.student_id === studentId && ps.room_id === roomId && ps.finished_at);
  const result = sessions.map(s => {
    const answers = db.practiceAnswers
      .filter(a => a.session_id === s.id)
      .map(a => ({
        word: a.word,
        is_correct: a.is_correct === 1,
        student_answer: a.student_answer,
        correct_answer: a.correct_answer
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
  res.json(db.wordStats.filter(ws => ws.room_id === roomId).sort((a, b) => b.error_rate - a.error_rate));
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
