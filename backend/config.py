# 日本語チャット — 后端配置

import os


def _load_dotenv():
    """读取项目根目录的 .env 文件，把里面的配置塞进环境变量。

    .env 文件格式（每行一个）：
        DEEPSEEK_API_KEY=sk-xxxxxx
        ELEVENLABS_API_KEY=xxxxxx

    已经存在的环境变量优先，不会被 .env 覆盖。
    """
    env_path = os.path.join(os.path.dirname(__file__), "..", ".env")
    if not os.path.exists(env_path):
        return

    with open(env_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            # 跳过空行和注释行
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            # 系统环境变量优先级更高
            if key and key not in os.environ:
                os.environ[key] = value


_load_dotenv()

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

# Edge TTS（微软 Edge 浏览器同款语音，完全免费·无额度上限·跨平台）
# 可用日语声音:
#   ja-JP-NanamiNeural (七海 - 女声, 自然温柔)  ← 推荐
#   ja-JP-KeitaNeural  (圭太 - 男声)
EDGE_TTS_VOICE = os.getenv("EDGE_TTS_VOICE", "ja-JP-NanamiNeural")

# 语速调节：负数变慢方便初学者听清，例如 "-10%" / "-20%" / "+0%"
EDGE_TTS_RATE = os.getenv("EDGE_TTS_RATE", "-10%")

# 访问口令（部署到公网后防止陌生人烧 API 额度）
# 留空 = 不设保护（本地开发时无需口令）
# ⚠️ 部署时通过环境变量注入，不要写在代码里
ACCESS_CODE = os.getenv("ACCESS_CODE", "")

# 服务器配置
HOST = "0.0.0.0"
PORT = int(os.getenv("PORT", "8765"))  # Render 自动注入 PORT 环境变量

# 对话限制
MAX_INPUT_LENGTH = 500   # 单条输入最大字数，防止刷爆 API
MAX_HISTORY_TURNS = 10   # 记住最近 10 轮对话（1 轮 = 你说 + さくら答）
