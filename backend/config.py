# 日本語チャット — 后端配置

import os

# DeepSeek API（对话用，便宜好用）
# 免费获取 Key: https://platform.deepseek.com/api_keys
# ⚠️ 部署时通过环境变量注入，不要写在代码里
DEEPSEEK_API_KEY = os.getenv("DEEPSEEK_API_KEY", "")

# DeepSeek 模型选择
# deepseek-chat: 最新版本，推荐使用
DEEPSEEK_MODEL = "deepseek-chat"

# ElevenLabs API（语音朗读用）
# 免费注册: https://elevenlabs.io
# ⚠️ 部署时通过环境变量注入，不要写在代码里
ELEVENLABS_API_KEY = os.getenv("ELEVENLABS_API_KEY", "")

# 日语语音 ID（ElevenLabs 免费预置声音，付费库里声音不可用）
# 免费可用:
#   EXAVITQu4vr4xnSDxMaL (Bella - 女声, 日语效果不错)  ← 推荐
#   ErXwobaYiN019PkySvjV (Antoni - 男声)
#   pNInz6obpgDQGcFmaJgB (Adam - 男声)
# 付费需要: jsCqWAovK2LkecY7zXl4 (日文原生女声)
VOICE_ID = "EXAVITQu4vr4xnSDxMaL"

# 服务器配置
HOST = "0.0.0.0"
PORT = int(os.getenv("PORT", "8765"))  # Render 自动注入 PORT 环境变量
