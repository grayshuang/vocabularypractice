#!/usr/bin/env node
/**
 * 教师账号本地急救脚本（无需部署，本机直连 PostgreSQL 运行）
 *
 * 用法（在本机 backend-v2 目录下，git bash / powershell 执行）：
 *
 *   1) 列出数据库里所有教师账号
 *      node reset_teacher.js --url="postgresql://postgres:密码@主机:端口/railway"
 *
 *   2) 重置某个教师的密码（立刻生效）
 *      node reset_teacher.js --url="同上" reset <用户名> <新密码>
 *
 * 注意：密码区分大小写，建议直接从 Railway 后台 Variables 里复制 DATABASE_URL 整串，
 *      不要手打，避免大小写拼错导致 password authentication failed。
 */

const { execSync } = require('child_process');

// ── 自动安装依赖（pg / bcryptjs）──
try { require('pg'); } catch (_) {
  console.log('📦 正在安装缺失依赖 pg + bcryptjs ...');
  try {
    execSync('npm install pg bcryptjs --no-save', { cwd: __dirname, stdio: 'inherit', timeout: 60000 });
  } catch (e) {
    console.error('❌ 依赖安装失败，请手动执行：cd backend-v2 && npm install pg bcryptjs');
    process.exit(1);
  }
}

const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const args = process.argv.slice(2);
const urlArg = args.find(a => a.startsWith('--url='));
const DATABASE_URL = urlArg ? urlArg.slice('--url='.length) : process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('❌ 请提供数据库连接串：');
  console.error('   node reset_teacher.js --url="postgresql://postgres:xxxx@tokaido.proxy.rlwy.net:43302/railway"');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
});

(async () => {
  try {
    const resetIdx = args.indexOf('reset');

    if (resetIdx > -1 && args[resetIdx + 1] && args[resetIdx + 2]) {
      const username = args[resetIdx + 1];
      const newPassword = args[resetIdx + 2];
      const find = await pool.query('SELECT id, username, email FROM teachers WHERE username = $1', [username]);
      if (find.rows.length === 0) {
        console.log('\n⚠️  未找到教师账号：' + username);
        console.log('   可用账号见下方列表。\n');
      } else {
        await pool.query(
          'UPDATE teachers SET password_hash = $1 WHERE username = $2',
          [bcrypt.hashSync(newPassword, 10), username]
        );
        console.log('\n✅ 已重置「' + username + '」的密码为：「' + newPassword + '」，请用新密码登录。\n');
      }
    }

    // ── 列出所有教师 ──
    const res = await pool.query(
      "SELECT id, username, email, to_char(created_at,'YYYY-MM-DD HH24:MI') as created FROM teachers ORDER BY id"
    );
    console.log('📋 数据库中的教师账号（共 ' + res.rows.length + ' 个）：');
    if (res.rows.length === 0) {
      console.log('   （空）—— 教师表已被清空，需用 /register 重新注册教师账号');
    } else {
      console.table(res.rows);
    }
  } catch (e) {
    console.error('\n❌ 执行失败：', e.message);
    if (/password authentication failed/i.test(e.message)) {
      console.error('   → 密码错误。PostgreSQL 密码区分大小写，请从 Railway Variables 复制 DATABASE_URL 整串，不要手打。');
    } else if (/ECONNREFUSED|getaddrinfo|timeout/i.test(e.message)) {
      console.error('   → 网络不通或地址错误，请检查主机名 / 端口。');
    } else if (/relation .* does not exist/i.test(e.message)) {
      console.error('   → 表不存在，数据库可能尚未初始化（先访问一次线上应用让它建表）。');
    }
  } finally {
    await pool.end();
  }
})();
