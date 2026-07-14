const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const dbPath = path.join(__dirname, 'db.json');

// 读取数据库
function readDB() {
  if (!fs.existsSync(dbPath)) {
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
    fs.writeFileSync(dbPath, JSON.stringify(defaultData, null, 2));
    return defaultData;
  }
  return JSON.parse(fs.readFileSync(dbPath, 'utf8'));
}

// 写入数据库
function writeDB(data) {
  fs.writeFileSync(dbPath, JSON.stringify(data, null, 2));
}

// 生成ID
function genId(arr) {
  return arr.length > 0 ? Math.max(...arr.map(x => x.id)) + 1 : 1;
}

// 初始化（启动时调用）
function initDB() {
  readDB();
  console.log('数据库连接成功（JSON文件）');
  console.log('超级管理员账号: admin / admin123456');
}

module.exports = { readDB, writeDB, genId, initDB };
