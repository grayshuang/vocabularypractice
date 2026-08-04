#!/bin/bash
# ============================================================
#  词汇练习网站 · 阿里云 ECS 一键部署脚本（国内环境优化）
#  用法： bash deploy_ecs.sh
#  前置：ECS 安全组已放行 22(SSH) 与 3000(应用) 入方向
# ============================================================
set -e

echo "===== [1/6] 安装 Docker（阿里云镜像源，国内快） ====="
if command -v docker >/dev/null 2>&1; then
  echo "Docker 已安装，跳过"
else
  if command -v dnf >/dev/null 2>&1; then
    dnf install -y yum-utils >/dev/null 2>&1 || true
    yum-config-manager --add-repo https://mirrors.aliyun.com/docker-ce/linux/centos/docker-ce.repo >/dev/null 2>&1 || true
    dnf install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
  elif command -v yum >/dev/null 2>&1; then
    yum install -y yum-utils >/dev/null 2>&1 || true
    yum-config-manager --add-repo https://mirrors.aliyun.com/docker-ce/linux/centos/docker-ce.repo >/dev/null 2>&1 || true
    yum install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
  elif command -v apt-get >/dev/null 2>&1; then
    apt-get update >/dev/null 2>&1
    apt-get install -y ca-certificates curl >/dev/null 2>&1
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://mirrors.aliyun.com/docker-ce/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://mirrors.aliyun.com/docker-ce/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
    apt-get update >/dev/null 2>&1
    apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
  else
    echo "❌ 不支持的包管理器，请手动安装 Docker"; exit 1
  fi
fi

echo "===== [2/6] 配置 Docker 国内镜像加速（解决 Docker Hub 国内拉取慢） ====="
mkdir -p /etc/docker
cat > /etc/docker/daemon.json <<'EOF'
{
  "registry-mirrors": [
    "https://docker.m.daocloud.io",
    "https://hub-mirror.c.163.com",
    "https://mirror.baidubce.com"
  ]
}
EOF
systemctl enable docker >/dev/null 2>&1 || true
systemctl restart docker
sleep 3
docker info >/dev/null 2>&1 && echo "✅ Docker 已启动" || { echo "❌ Docker 启动失败"; exit 1; }

echo "===== [3/6] 获取代码 ====="
cd /root
if [ -d vocabularypractice ]; then
  echo "已存在，拉取最新..."
  cd vocabularypractice && git pull --ff-only
else
  git clone https://github.com/grayshuang/vocabularypractice.git
  cd vocabularypractice
fi

echo "===== [4/6] 配置环境变量 ====="
if [ ! -f .env ]; then
  cp .env.example .env
  echo "✅ 已生成 .env（默认密码 vocab_practice_2026，可在 .env 自行修改）"
else
  echo ".env 已存在，保留"
fi

echo "===== [5/6] 构建并启动（首次约 3-10 分钟，取决于镜像拉取速度） ====="
docker compose up -d --build

echo "===== [6/6] 等待启动并查看状态 ====="
sleep 25
docker compose ps
echo "----- 应用日志（最后 30 行）-----"
docker compose logs --tail=30 app

echo ""
echo "✅ 部署完成！"
echo "   浏览器访问： http://$(curl -s --connect-timeout 5 http://100.100.100.200/latest/meta-data/eipv4 2>/dev/null || hostname -I | awk '{print $1}'):3000"
echo "   管理员后台『📚 词库管理』应列出 795 条带『4分』标签。"
echo "   如需绑定域名 vocab-practice.website，请在阿里云万网控制台添加 A 记录指向本机公网 IP，并用 Nginx/Caddy 反代 3000 端口（或暂用 IP:3000 访问）。"
