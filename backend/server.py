# 日本語チャット — FastAPI 服务器
# 启动: python server.py

import sys
import os
sys.path.insert(0, os.path.dirname(__file__))

import uuid

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from ai import chat_with_sakura, reset_history
from tts import text_to_speech
from config import HOST, PORT, MAX_INPUT_LENGTH, ACCESS_CODE
import uvicorn

app = FastAPI(title="日本語チャット", version="1.2")

# ---------- 认证 & 会话 ----------
AUTH_COOKIE = "nihongo_auth"
SESSION_COOKIE = "nihongo_sid"


def _require_auth(request: Request):
    """如果配置了访问口令，检查 cookie 是否已认证"""
    if ACCESS_CODE and request.cookies.get(AUTH_COOKIE) != "1":
        raise HTTPException(status_code=401, detail="認証が必要です")


def _get_session(request: Request, response: Response) -> str:
    """获取或创建会话 ID（写入 cookie），用于隔离不同用户的对话记忆"""
    sid = request.cookies.get(SESSION_COOKIE)
    if not sid:
        sid = uuid.uuid4().hex
        response.set_cookie(
            SESSION_COOKIE, sid,
            max_age=86400 * 30, httponly=True, samesite="lax",
        )
    return sid


class ChatRequest(BaseModel):
    text: str


class ChatResponse(BaseModel):
    reply: str       # AI 的文字回复
    audio_b64: str | None  # 语音 base64（可能为 None）


class UnlockRequest(BaseModel):
    code: str


@app.get("/api/auth-check")
def auth_check(request: Request):
    """前端启动时调用：检查是否已认证（或无需认证）"""
    if not ACCESS_CODE:
        return {"status": "ok"}
    if request.cookies.get(AUTH_COOKIE) == "1":
        return {"status": "ok"}
    raise HTTPException(status_code=401, detail="認証が必要です")


@app.post("/api/unlock")
def unlock(req: UnlockRequest, response: Response):
    """输入访问口令，验证通过后种 cookie"""
    if not ACCESS_CODE:
        return {"status": "ok"}
    if req.code.strip() != ACCESS_CODE:
        raise HTTPException(status_code=403, detail="パスワードが違います")
    response.set_cookie(
        AUTH_COOKIE, "1",
        max_age=86400 * 30, httponly=True, samesite="lax",
    )
    return {"status": "ok"}


@app.post("/api/chat")
def chat(req: ChatRequest, request: Request, response: Response) -> ChatResponse:
    """对话接口：接收用户日语文字，返回 AI 回复 + 语音"""
    _require_auth(request)
    sid = _get_session(request, response)

    text = req.text.strip()

    if not text:
        raise HTTPException(status_code=400, detail="空メッセージ")

    if len(text) > MAX_INPUT_LENGTH:
        raise HTTPException(
            status_code=400,
            detail=f"メッセージが長すぎます（{MAX_INPUT_LENGTH}文字以内）",
        )

    # 1. AI 对话（按会话隔离记忆）
    reply_text = chat_with_sakura(text, sid)

    # 2. 生成语音
    audio_b64 = text_to_speech(reply_text)

    return ChatResponse(reply=reply_text, audio_b64=audio_b64)


@app.post("/api/reset")
def reset(request: Request, response: Response):
    """清空当前会话的对话记忆，重新开始聊天"""
    _require_auth(request)
    sid = _get_session(request, response)
    reset_history(sid)
    return {"status": "ok"}


@app.get("/api/health")
def health():
    return {"status": "ok", "service": "日本語チャット"}


# 前端静态文件
frontend_dir = os.path.join(os.path.dirname(__file__), "..", "frontend")
app.mount("/", StaticFiles(directory=frontend_dir, html=True), name="frontend")


if __name__ == "__main__":
    print(f"""
╔══════════════════════════════════╗
║     🎌 日本語チャット v1.2      ║
║   http://localhost:{PORT}        ║
║  iPhoneでSafariを開いてね ☺     ║
╚══════════════════════════════════╝
""")
    uvicorn.run(app, host=HOST, port=PORT)
