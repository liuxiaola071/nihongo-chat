# 日本語チャット — Docker 镜像
# 用于 ClawCloud Run / Zeabur / 任何支持 Docker 的平台

FROM python:3.12-slim

# 设置工作目录
WORKDIR /app

# 先复制依赖清单，利用 Docker 缓存（代码改动时不用重装依赖）
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 复制整个项目（backend + frontend）
COPY . .

# 平台会注入 PORT 环境变量，默认 8765
ENV PORT=8765
EXPOSE 8765

# 启动命令：进入 backend 目录运行 server.py
CMD ["python", "backend/server.py"]
