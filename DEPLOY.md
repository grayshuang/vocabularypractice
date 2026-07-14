# 部署说明（公网访问）

本项目是**全栈应用**（React 前端 + Node/Express 后端 + JSON 文件数据库 + AI 出题）。
已改造为**单端口部署**：后端 Express 同时托管前端页面和 API，部署后访问一个网址即可，
学生、教师从任何能上网的电脑/手机浏览器打开该网址就能用。

---

## 一、最快方案：Render 免费版（无需信用卡）

1. 把本目录（`vocab-practice/`）推送到你的 GitHub 新仓库（仓库已 `git init` 并 commit，
   你只需 `git remote add origin <你的仓库地址>` 然后 `git push -u origin main`）。
2. 打开 https://render.com → 用 GitHub 登录 → **New → Web Service**。
3. 选择刚才的仓库 → **Runtime 选 Docker**（Render 会自动读 `render.yaml`）。
4. 实例套餐选 **Free**（免费，休眠后首次访问稍慢）。
5. 环境变量（在 Render 后台 Environment 里）：
   - `JWT_SECRET`：已自动生成随机值，无需改。
   - `DASHSCOPE_API_KEY`：可留空（代码内置默认 key）；建议填你自己的通义千问 key。
6. 点 **Deploy** → 等 1~2 分钟构建完成。
7. 得到网址如 `https://vocab-practice-xxx.onrender.com`，分享给所有人即可访问。

> 首次部署后数据库是空的：进入网址 → 注册一个**教师账号** → 创建房间 →
> 把房间号或链接发给学生，学生加入即可。

---

## 二、备选：Railway / 任意云（Docker）

本目录含 `Dockerfile`，任何支持 Docker 的平台（Railway、Fly.io、阿里云/腾讯云容器、
自有 VPS）都能直接部署：

```bash
docker build -t vocab-practice .
docker run -d -p 3000:3000 \
  -e JWT_SECRET="你的随机密钥" \
  -e DASHSCOPE_API_KEY="你的key(可选)" \
  -v $(pwd)/data:/app/backend-v2/data \
  vocab-practice
```

`-v` 挂载数据卷用于**持久化数据库**（见下方说明）。

---

## 三、重要提醒：数据库持久化

后端用 `backend-v2/db.json` 文件存所有数据（账号、房间、答题记录）。

- **Render 免费版文件系统是临时的**：每次重新部署/休眠唤醒后，文件会被重置为空库，
  之前的账号和答题数据会丢失。适合**演示/短期课堂使用**。
- **要长期保存数据**，二选一：
  1. 在 Render 给服务挂载一个 **Persistent Disk**（挂载到 `/app/backend-v2/data`，
     并把数据库路径指过去）；或
  2. 部署到**自有 VPS / 云服务器**（用上面的 `docker run -v` 挂盘），数据永久保存。

---

## 四、本地/局域网快速验证（不改代码）

```bash
# 1) 构建前端
cd frontend && npx vite build && cd ..

# 2) 启动后端（自动托管 frontend/dist）
cd backend-v2 && node server.js
# 打开 http://localhost:3000

# 同局域网其他电脑：把 localhost 换成你电脑的 IP，如 http://192.168.1.10:3000
```

---

## 五、环境变量一览

| 变量 | 说明 | 默认 |
|---|---|---|
| `PORT` | 服务端口 | `3000` |
| `JWT_SECRET` | JWT 签名密钥，生产务必改 | 内置占位值 |
| `DASHSCOPE_API_KEY` | 通义千问 key（AI 出题） | 代码内置默认 key |
