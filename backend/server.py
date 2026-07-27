# 日本語チャット — FastAPI 服务器
# 启动: python server.py

import sys
import os
sys.path.insert(0, os.path.dirname(__file__))

from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from ai import chat_with_sakura
from tts import text_to_speech
from config import HOST, PORT
import uvicorn

app = FastAPI(title="日本語チャット", version="1.0")


class ChatRequest(BaseModel):
    text: str


class ChatResponse(BaseModel):
    reply: str       # AI 的文字回复
    audio_b64: str | None  # 语音 base64（可能为 None）


@app.post("/api/chat")
def chat(req: ChatRequest) -> ChatResponse:
    """对话接口：接收用户日语文字，返回 AI 回复 + 语音"""
    if not req.text.strip():
        raise HTTPException(status_code=400, detail="空メッセージ")

    # 1. AI 对话
    reply_text = chat_with_sakura(req.text.strip())

    # 2. 生成语音
    audio_b64 = text_to_speech(reply_text)

    return ChatResponse(reply=reply_text, audio_b64=audio_b64)


@app.get("/api/health")
def health():
    return {"status": "ok", "service": "日本語チャット"}


# 前端静态文件
frontend_dir = os.path.join(os.path.dirname(__file__), "..", "frontend")
app.mount("/", StaticFiles(directory=frontend_dir, html=True), name="frontend")


if __name__ == "__main__":
    print(f"""
╔══════════════════════════════════╗
║     🎌 日本語チャット v1.0      ║
║   http://localhost:{PORT}        ║
║  iPhoneでSafariを開いてね ☺     ║
╚══════════════════════════════════╝
""")
    uvicorn.run(app, host=HOST, port=PORT)
