# 日本語チャット — Docker 镜像
# 用于 Hugging Face Spaces（端口 7860）

FROM python:3.12-slim

# 设置工作目录
WORKDIR /app

# 先复制依赖清单，利用 Docker 缓存（代码改动时不用重装依赖）
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 复制整个项目（backend + frontend）
COPY . .

# Hugging Face Spaces 固定使用 7860 端口
ENV PORT=7860
EXPOSE 7860

# 启动命令：进入 backend 目录运行 server.py
CMD ["python", "backend/server.py"]
