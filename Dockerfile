FROM node:18-slim

# 安装 better-sqlite3 的编译依赖
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先复制依赖文件，利用Docker层缓存
COPY package*.json ./
RUN npm install --production

# 复制应用代码
COPY . .

# 创建数据持久化目录
RUN mkdir -p /data /app/uploads

# 使用环境变量指向持久化存储
ENV DATA_DIR=/data
ENV UPLOAD_DIR=/data/uploads

EXPOSE 3000

CMD ["node", "server.js"]
