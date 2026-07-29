# 日本語チャット — Docker 镜像
# 用于腾讯云函数 SCF Web 函数（默认监听 9000 端口）

FROM python:3.12-slim

# 设置工作目录
WORKDIR /app

# 先复制依赖清单，利用 Docker 缓存（代码改动时不用重装依赖）
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 复制整个项目（backend + frontend）
COPY . .

# 腾讯云函数 SCF Web 函数默认监听 9000 端口
# 平台若注入 PORT 环境变量，config.py 会自动读取并覆盖
ENV PORT=9000
EXPOSE 9000

# 启动命令：进入 backend 目录运行 server.py
CMD ["python", "backend/server.py"]
