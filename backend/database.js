const { Low, JSONFile } = require('lowdb');
const { join } = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const dbPath = join(__dirname, 'db.json');
const adapter = new JSONFile(dbPath);
const db = new Low(adapter, { defaultValue: {
  admins: [],
  teachers: [],
  students: [],
  rooms: [],
  studentRooms: [],
  practiceSessions: [],
  practiceAnswers: [],
  wordStats: []
}});

// 初始化数据库
async function initDB() {
  await db.read();
  // 初始化超级管理员
  const adminExists = db.data.admins.some(a => a.username === 'admin');
  if (!adminExists) {
    db.data.admins.push({
      id: 1,
      username: 'admin',
      password_hash: bcrypt.hashSync('admin123456', 10)
    });
    await db.write();
    console.log('超级管理员账号已初始化: admin / admin123456');
  } else {
    console.log('数据库连接成功（lowdb JSON）');
  }
}

// 工具函数：生成ID
function genId(arr) {
  return arr.length > 0 ? Math.max(...arr.map(x => x.id)) + 1 : 1;
}

module.exports = { db, initDB, genId };
