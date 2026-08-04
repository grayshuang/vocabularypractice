# 词汇练习网站 — 本地部署 + Cloudflare 免费隧道（Windows）

> 目标：在你自己的 Windows 电脑上跑应用，用 Cloudflare 免费隧道暴露到公网，国内学生直接访问，零成本。

---

## 第一步：安装 Docker Desktop（约 5 分钟）

1. 打开 https://www.docker.com/products/docker-desktop/
2. 下载 **Docker Desktop for Windows**（Stable 版）
3. 双击安装，**勾选 "Use WSL 2 instead of Hyper-V"**（默认勾选即可）
4. 安装完重启电脑
5. 打开 Docker Desktop，看到鲸鱼图标转完、左下角显示 "Running" 就成功了

---

## 第二步：准备项目文件

你的项目已经在本地：
```
C:\Users\grays\WorkBuddy\2026-07-05-20-40-33\vocab-practice
```

在该目录打开 **PowerShell（管理员）** 或 **Git Bash**，确认文件齐全：
```powershell
cd C:\Users\grays\WorkBuddy\2026-07-05-20-40-33\vocab-practice
ls docker-compose.yml    # 应该能看到
```

如果还没有 `.env` 文件，先创建：
```powershell
cp .env.example .env
```

---

## 第三步：一键启动（构建 + 数据库 + 种子）

```powershell
cd C:\Users\grays\WorkBuddy\2026-07-05-20-40-33\vocab-practice
docker compose up -d --build
```

首次构建会花 3-8 分钟（要构建前端 + 安装依赖）。完成后查看日志：
```powershell
docker compose logs -f app
```
看到 `服务器运行在 http://0.0.0.0:3000` 和 `[lexicon] 已从 PG 载入词库缓存，词条数：795` 就成功了。

本地验证：浏览器打开 `http://localhost:3000` 应该能看到网站。

---

## 第四步：安装 Cloudflare 隧道（cloudflared）

1. 下载 Windows 版：https://github.com/cloudflare/cloudflared/releases
   - 找 `cloudflared-windows-amd64.exe`，下载后重命名为 `cloudflared.exe`
2. 把它放到一个目录，比如 `C:\cloudflared\cloudflared.exe`
3. （可选）把 `C:\cloudflared` 加到系统 PATH，方便全局调用

---

## 第五步：启动隧道，获得公网地址

```powershell
cloudflared tunnel --url http://localhost:3000
```

首次运行会显示一个链接让你登录 Cloudflare 账号（免费），登录后隧道建立。
终端会输出一行：
```
Your quick Tunnel has been created! Visit it at: https://xxxx.trycloudflare.com
```

**这个 `https://xxxx.trycloudflare.com` 就是给学生访问的公网地址！**

---

## 注意事项

| 问题 | 解决 |
|---|---|
| 电脑关机后学生访问不了 | 上课前启动 Docker + 隧道即可；长期方案建议买轻量服务器 |
| 隧道地址每次随机变化 | 免费版每次不同；如需固定域名，可注册 Cloudflare 账号配置Named Tunnel（免费） |
| 速度慢 | Cloudflare 香港/新加坡节点，国内一般可用；如卡顿可换时间再试 |
| 数据库数据 | 存在 Docker 卷 `pgdata` 里，重启容器数据不丢；重装系统前需备份该卷 |

---

## 停止 / 重启

```powershell
# 停止应用（保留数据）
docker compose down

# 重新启动
docker compose up -d

# 停止隧道：在运行 cloudflared 的窗口按 Ctrl+C
```

---

## 紧急情况：Railway 还能用吗？

你的 Railway 部署其实是正常的，只是国内网络直接访问不了。如果临时需要，开代理/VPN 访问 `vocab-practice-production.up.railway.app` 仍然可用。等本地隧道配好后，以学生方便为准。
