# 词汇练习全栈应用 —— 单镜像部署
# 前端（Vite）构建后由后端 Express 同源托管，最终只暴露一个端口。
FROM node:22

WORKDIR /app

# 国内 npm 镜像加速（Railway 部署可忽略，国内 ECS 构建必需）
RUN npm config set registry https://registry.npmmirror.com

# 1) 前端：复制全部源码，安装依赖并构建到 frontend/dist
COPY frontend/ ./frontend/
RUN cd frontend && npm install && npx vite build

# 2) 后端：仅安装运行时依赖
COPY backend-v2/package*.json ./backend/
RUN cd backend && npm install --omit=dev

# 3) 复制源码（前端 dist 已在第 9 行构建于镜像内，无需从上下文拷贝）
COPY backend-v2/ ./backend/

WORKDIR /app/backend
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
