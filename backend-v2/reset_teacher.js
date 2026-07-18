#!/usr/bin/env node
/**
 * 教师账号本地急救脚本（无需部署，本机直连 PostgreSQL 运行）
 *
 * 用法（在本机 backend-v2 目录下，git bash / powershell 执行）：
 *
 *   1) 列出数据库里所有教师账号（诊断：账号是否还在？用户名是什么？）
 *      node reset_teacher.js --url="postgresql://postgres:密码@主机:端口/railway"
 *
 *   2) 重置某个教师的密码（立刻生效，不用等部署）
 *      node reset_teacher.js --url="postgresql://postgres:密码@主机:端口/railway" reset <用户名> <新密码>
 *
 * 注意：--url 整串用双引号包住，里面含 @ : 等特殊字符，不要拆开。
 */

const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const args = process.argv.slice(2);
const urlArg = args.find(a => a.startsWith('--url='));
const DATABASE_URL = urlArg ? urlArg.slice('--url='.length) : process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('❌ 请提供数据库连接串，例如：');
  console.error('   node reset_teacher.js --url="postgresql://postgres:xxxx@tokaido.proxy.rlwy.net:43302/railway"');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
});

(async () => {
  try {
    const cmd = args.find(a => a === 'reset');
    const resetIdx = args.indexOf('reset');

    if (cmd && resetIdx > -1 && args[resetIdx + 1] && args[resetIdx + 2]) {
      // ── 重置密码 ──
      const username = args[resetIdx + 1];
      const newPassword = args[resetIdx + 2];

      const find = await pool.query('SELECT id, username, email FROM teachers WHERE username = $1', [username]);
      if (find.rows.length === 0) {
        console.log('⚠️  未找到教师账号：', username);
        console.log('   可用账号见下方列表。');
      } else {
        const hash = bcrypt.hashSync(newPassword, 10);
        await pool.query('UPDATE teachers SET password_hash = $1 WHERE username = $2', [hash, username]);
        console.log('✅ 已重置教师「' + username + '」的密码为：「' + newPassword + '」，请用此密码登录。');
      }
    }

    // ── 列出所有教师（无论是否执行重置，都打印一遍便于核对）──
    const res = await pool.query('SELECT id, username, email, created_at FROM teachers ORDER BY id');
    console.log('\n📋 数据库中的教师账号（共 ' + res.rows.length + ' 个）：');
    if (res.rows.length === 0) {
      console.log('   （空）——说明教师表已被清空，需用 /register 重新注册教师账号');
    } else {
      console.table(res.rows);
    }
  } catch (e) {
    console.error('❌ 执行失败：', e.message);
    console.error('   请确认 DATABASE_URL 正确、数据库可访问、backend-v2 下已安装 pg 依赖（npm install）。');
  } finally {
    await pool.end();
  }
})();
