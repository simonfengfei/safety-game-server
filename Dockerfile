FROM node:18-slim

WORKDIR /app

# 先复制依赖文件，利用Docker层缓存
COPY package*.json ./
RUN npm install --production

# 复制应用代码
COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
