# 日本語チャット — TTS 语音模块
# 调用 ElevenLabs API 将日语文字转为语音

import requests
import base64
from config import ELEVENLABS_API_KEY, VOICE_ID


def text_to_speech(text: str) -> str | None:
    """
    将日语文字转为语音，返回 base64 编码的 mp3 数据
    失败返回 None
    """
    url = f"https://api.elevenlabs.io/v1/text-to-speech/{VOICE_ID}"
    headers = {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
    }
    payload = {
        "text": text,
        "model_id": "eleven_multilingual_v2",
        "voice_settings": {
            "stability": 0.5,
            "similarity_boost": 0.8,
            "speed": 0.9,  # 稍慢一点，方便学习者听清
        },
    }

    try:
        resp = requests.post(url, headers=headers, json=payload, timeout=20)
        if resp.status_code == 200:
            return base64.b64encode(resp.content).decode("utf-8")
        else:
            print(f"[TTS] 错误: {resp.status_code} {resp.text[:100]}")
            return None
    except Exception as e:
        print(f"[TTS] 异常: {e}")
        return None
