# 词汇练习全栈应用 —— 单镜像部署
# 前端（Vite）构建后由后端 Express 同源托管，最终只暴露一个端口。
FROM node:18-alpine

WORKDIR /app

# 1) 前端：安装依赖并构建到 frontend/dist
COPY frontend/package*.json ./frontend/
RUN cd frontend && npm install && npx vite build

# 2) 后端：仅安装运行时依赖
COPY backend-v2/package*.json ./backend/
RUN cd backend && npm install --omit=dev

# 3) 复制源码与前端构建产物
COPY backend-v2/ ./backend/
COPY frontend/dist/ ./frontend/dist/

WORKDIR /app/backend
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
