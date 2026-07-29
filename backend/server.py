# 日本語チャット — FastAPI 服务器
# 启动: python server.py

import sys
import os
sys.path.insert(0, os.path.dirname(__file__))

import uuid
import re
import json
import time
import threading
from datetime import date, datetime, timedelta

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from ai import chat_with_sakura, reset_history, export_markdown
from tts import text_to_speech
import config as _cfg
from config import HOST, PORT, MAX_INPUT_LENGTH, ACCESS_CODE
from scenarios import list_scenarios, get_scenario
from assist import get_translation_quiz, RESCUE_PHRASES, check_completion, get_counter_quiz
from furigana import analyze as furigana_analyze, to_ruby_html
from vocab import add_words, get_words, get_all_days, clear_words, to_anki_csv, split_reply
import srs
import uvicorn

app = FastAPI(title="日本語チャット", version="1.6")

# CORS：允许前端从 GitHub Pages 等跨域调用 API
# 认证走请求头（X-Access-Code），不依赖 cookie，所以不需要 allow_credentials
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def _fix_content_disposition(request: Request, call_next):
    """腾讯云 SCF 网关默认给所有响应加 Content-Disposition: attachment，
    导致浏览器把 HTML 页面当文件下载。改成 inline 让浏览器正常渲染。"""
    resp = await call_next(request)
    cd = resp.headers.get("content-disposition")
    if cd and cd.startswith("attachment"):
        resp.headers["content-disposition"] = cd.replace("attachment", "inline", 1)
    return resp


# ---------- 认证 & 会话 ----------
AUTH_COOKIE = "nihongo_auth"
SESSION_COOKIE = "nihongo_sid"


def _require_auth(request: Request):
    """如果配置了访问口令，检查 cookie 或请求头是否已认证"""
    if ACCESS_CODE:
        # cookie（本地同源）或 X-Access-Code 头（跨域部署）
        if request.cookies.get(AUTH_COOKIE) == "1":
            return
        if request.headers.get("x-access-code") == ACCESS_CODE:
            return
        raise HTTPException(status_code=401, detail="認証が必要です")


def _get_session(request: Request, response: Response) -> str:
    """获取或创建会话 ID，用于隔离不同用户的对话记忆"""
    # 优先用请求头 X-Session-Id（跨域部署），其次用 cookie（本地开发）
    sid = request.headers.get("x-session-id")
    if not sid:
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
    scenario: str | None = None   # 场景 id
    mode: str = "chat"            # chat|correct|translate|word
    level: str = "N4"             # N5|N4|N3|N2|N1
    rate: str = ""                # 语速: "-30%" / "+10%" / ""
    tone: str = "polite"          # polite|casual|kansai


class VocabItem(BaseModel):
    word: str
    kana: str = ""
    meaning: str = ""


class FixItem(BaseModel):
    wrong: str = ""    # 错误表达
    correct: str = ""  # 正确表达
    note: str = ""     # 解释说明


class ChatResponse(BaseModel):
    reply: str                     # AI 的文字回复（正文）
    audio_b64: str | None          # 语音 base64
    new_words: list[VocabItem] = []   # 这轮新学到的单词
    fix_items: list[FixItem] = []    # 纠错项（correct 模式用）
    scene_done: bool = False         # 场景是否已达成目标


class UnlockRequest(BaseModel):
    code: str


@app.get("/api/auth-check")
def auth_check(request: Request):
    """前端启动时调用：检查是否已认证（或无需认证）"""
    if not ACCESS_CODE:
        return {"status": "ok"}
    if request.cookies.get(AUTH_COOKIE) == "1":
        return {"status": "ok"}
    if request.headers.get("x-access-code") == ACCESS_CODE:
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

    # 1. AI 对话（按会话隔离记忆 + 场景设定 + 模式 + 难度 + 语气）
    raw_reply = chat_with_sakura(text, sid, req.scenario, req.mode, req.level, req.tone)

    # 1.5 打卡
    _record_checkin(sid)

    # 2. 解析 ###FIX### 纠错块
    fix_items = _parse_fix(raw_reply)
    
    # 如果本次有纠错，自动存入错误本
    if fix_items:
        _save_errors(sid, fix_items)

    # 3. 把 ###FIX### 块从正文里剥掉（纠错内容单独用卡片展示，不能混在气泡正文和语音里）
    raw_reply = _strip_fix(raw_reply)

    # 4. 把 ###WORDS### 生词行拆出来
    reply_text, words = split_reply(raw_reply)
    add_words(sid, words)
    # 同步到 SRS 复习系统
    srs.add_words_batch(sid, words)

    # 5. 生成语音（只读正文，传语速）
    audio_b64 = text_to_speech(reply_text, req.rate)

    # 6. 检查场景是否达成
    scene_done = check_completion(req.scenario, reply_text) if req.scenario else False
    if scene_done and req.scenario:
        _record_scene_done(sid, req.scenario)

    return ChatResponse(
        reply=reply_text,
        audio_b64=audio_b64,
        new_words=[VocabItem(**w) for w in words],
        fix_items=[FixItem(**f) for f in fix_items],
        scene_done=scene_done,
    )


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


# ---------- 纠错解析 ----------

# 预编译正则，避免每条消息都重新编译
_FIX_BLOCK_RE = re.compile(r"###FIX###\s*(.*?)\s*###FIXEND###", re.DOTALL)
_FIX_STRIP_RE = re.compile(r"###FIX###.*?###FIXEND###", re.DOTALL)
_FIX_STRIP_FALLBACK_RE = re.compile(r"###FIX###.*?(?=###WORDS###|$)", re.DOTALL)
_MULTI_NL_RE = re.compile(r"\n{3,}")
_ARROW_RE = re.compile(r"(.+?)→(.+)")
_NO_FIX_CLEAN_RE = re.compile(r"[（）()\s。、.]")
_NO_FIX_TEXTS = frozenset({"なし", "無し", "特になし", "問題なし"})


def _parse_fix(raw_reply: str) -> list[dict]:
    """从 AI 回复中提取 ###FIX###...###FIXEND### 纠错块"""
    match = _FIX_BLOCK_RE.search(raw_reply)
    if not match:
        return []
    block = match.group(1).strip()
    if not block or _is_no_fix(block):
        return []
    items = []
    for line in block.split("\n"):
        line = line.strip()
        if not line:
            continue
        # 格式: ❌（错误）→ ✅（正确）  或 带解释的第二行
        arrow = _ARROW_RE.search(line)
        if arrow:
            wrong = arrow.group(1).strip().lstrip("❌").strip()
            correct = arrow.group(2).strip().lstrip("✅").strip()
            # AI 有时写「❌（なし）→ ✅（なし）」表示没有错误，跳过避免出现空卡片
            if _is_no_fix(wrong) or _is_no_fix(correct):
                continue
            items.append({"wrong": wrong, "correct": correct, "note": ""})
        elif items:
            # 续行：追加到上一项的 note
            items[-1]["note"] += line
    return items


def _is_no_fix(text: str) -> bool:
    """判断一段文本是否表示「没有错误」（なし/無し/なし。/（なし）等）"""
    cleaned = _NO_FIX_CLEAN_RE.sub("", text)
    return cleaned in _NO_FIX_TEXTS


def _strip_fix(raw_reply: str) -> str:
    """从回复正文中移除 ###FIX###...###FIXEND### 整块

    纠错内容会以卡片形式单独展示，正文和语音里都不该出现这些标记。
    AI 偶尔漏写 ###FIXEND###，所以第二个正则兜底：从 ###FIX### 一直截到结尾。
    """
    cleaned = _FIX_STRIP_RE.sub("", raw_reply)
    cleaned = _FIX_STRIP_FALLBACK_RE.sub("", cleaned)
    # 合并剥离后留下的多余空行
    return _MULTI_NL_RE.sub("\n\n", cleaned).strip()


# ---------- TTS 独立接口 ----------
class TTSRequest(BaseModel):
    text: str
    rate: str = ""  # 语速: "-30%" / "+10%" / ""


class FuriganaRequest(BaseModel):
    text: str
    format: str = "json"  # "json" | "html"


@app.post("/api/tts")
def tts_endpoint(req: TTSRequest, request: Request):
    """单独请求语音合成，返回 base64 音频"""
    _require_auth(request)
    text = req.text.strip()
    if not text or len(text) > 500:
        raise HTTPException(status_code=400, detail="文字が長すぎます")
    audio_b64 = text_to_speech(text, req.rate)
    return {"audio_b64": audio_b64}


# ---------- 辅助功能 ----------
@app.get("/api/assist/quiz")
def assist_quiz(
    request: Request,
    direction: str = "j2c",
    count: int = 5,
    difficulty: int = 0,
):
    """获取翻译练习题"""
    _require_auth(request)
    questions = get_translation_quiz(direction, count, difficulty)
    return {"questions": questions}


@app.get("/api/assist/rescue")
def assist_rescue(request: Request):
    """获取救急短语句子列表"""
    _require_auth(request)
    return {"phrases": RESCUE_PHRASES}


# ---------- 振假名 ----------

@app.post("/api/furigana")
def furigana(req: FuriganaRequest, request: Request):
    """给日语文本标注振假名（汉字读音）

    POST /api/furigana
    {"text": "今日はいい天気ですね", "format": "json"}

    format=json → {"tokens": [{"surface":"今日","reading":"きょう","has_kanji":true,"pos":"名詞"}, ...]}
    format=html → {"html": "<ruby>今日<rt>きょう</rt></ruby>はいい<ruby>天気<rt>てんき</rt></ruby>ですね"}
    """
    _require_auth(request)
    text = req.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="テキストを入力してください")
    if len(text) > 2000:
        raise HTTPException(status_code=400, detail="2000文字以内で入力してください")

    if req.format == "html":
        return {"html": to_ruby_html(text)}
    return {"tokens": furigana_analyze(text)}


@app.get("/api/scenarios")
def scenarios(request: Request):
    """返回可选场景列表，供前端渲染按钮"""
    _require_auth(request)
    return {"scenarios": list_scenarios()}


@app.post("/api/scenario/{scenario_id}")
def switch_scenario(scenario_id: str, request: Request, response: Response):
    """切换场景：清空旧记忆，返回该场景的开场白"""
    _require_auth(request)
    sid = _get_session(request, response)
    sc = get_scenario(scenario_id)
    reset_history(sid)   # 换场景等于重新开一段角色扮演，旧对话会干扰
    return {
        "id": sc["id"],
        "emoji": sc["emoji"],
        "name": sc["name"],
        "jp_name": sc["jp_name"],
        "opening": sc["opening"],
    }


# ---------- 今日生词本 ----------
@app.get("/api/vocab")
def vocab_today(request: Request, response: Response, day: str | None = None):
    """取生词本（默认今天），顺带返回有记录的日期列表"""
    _require_auth(request)
    sid = _get_session(request, response)
    return {
        "day": day or "today",
        "words": get_words(sid, day),
        "days": get_all_days(sid),
    }


@app.get("/api/vocab/export")
def vocab_export(request: Request, response: Response, day: str | None = None):
    """导出 Anki CSV：正面=単語（かな），背面=中文意思"""
    _require_auth(request)
    sid = _get_session(request, response)
    csv_text = to_anki_csv(sid, day)
    filename = f"nihongo_vocab_{day or 'today'}.csv"
    return PlainTextResponse(
        # 加 BOM，Excel 打开不会乱码
        content="\ufeff" + csv_text,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.delete("/api/vocab")
def vocab_clear(request: Request, response: Response, day: str | None = None):
    """清空某天的生词本"""
    _require_auth(request)
    sid = _get_session(request, response)
    clear_words(sid, day)
    return {"status": "ok"}


class SrsGradeRequest(BaseModel):
    word: str
    quality: int  # 0-5


# ============================================================
# 打卡 & 场景通关 & 错误本 — 追踪数据
# ============================================================

DATA_DIR = _cfg.DATA_DIR
STATS_FILE = os.path.join(DATA_DIR, "stats.json")
ERRORS_FILE = os.path.join(DATA_DIR, "errors.json")
_stats_lock = threading.Lock()
_errors_lock = threading.Lock()
SAVE_DEBOUNCE_SEC = 3  # 防抖：连续写入只落盘一次

# stats.json 结构: { sid: { "checkins": ["2026-07-28",...], "scenes_done": {"free": true, "cafe": "2026-07-28",...}, "last_active": 1234567890 } }
_stats: dict[str, dict] = {}
_stats_loaded = False

# errors.json 结构: { sid: [{"wrong":"...","correct":"...","note":"...","date":"2026-07-28","scenario":"..."}] }
_errors: dict[str, list[dict]] = {}
_errors_loaded = False


def _load_stats():
    global _stats, _stats_loaded
    if _stats_loaded:
        return
    _stats_loaded = True
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        with open(STATS_FILE, "r", encoding="utf-8") as f:
            _stats = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        pass


_stats_save_timer: threading.Timer | None = None


def _save_stats():
    """防抖写入：连续调用只落盘一次"""
    global _stats_save_timer
    if _stats_save_timer:
        _stats_save_timer.cancel()
    _stats_save_timer = threading.Timer(SAVE_DEBOUNCE_SEC, _flush_stats)
    _stats_save_timer.daemon = True
    _stats_save_timer.start()


def _flush_stats():
    try:
        tmp = STATS_FILE + ".tmp"
        with _stats_lock:
            data = dict(_stats)
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
        os.replace(tmp, STATS_FILE)
    except OSError:
        pass


def _record_checkin(sid: str):
    """记录今日打卡"""
    _load_stats()
    today = date.today().isoformat()
    s = _stats.setdefault(sid, {})
    checkins = s.setdefault("checkins", [])
    if today not in checkins:
        checkins.append(today)
        checkins.sort()
    s["last_active"] = time.time()
    _save_stats()


def _record_scene_done(sid: str, scene_id: str):
    """记录场景通关"""
    _load_stats()
    today = date.today().isoformat()
    s = _stats.setdefault(sid, {})
    scenes = s.setdefault("scenes_done", {})
    if scene_id not in scenes:
        scenes[scene_id] = today
    s["last_active"] = time.time()
    _save_stats()


def _load_errors():
    global _errors, _errors_loaded
    if _errors_loaded:
        return
    _errors_loaded = True
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        with open(ERRORS_FILE, "r", encoding="utf-8") as f:
            _errors = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        pass


_errors_save_timer: threading.Timer | None = None


def _save_errors_data():
    """防抖写入：连续调用只落盘一次"""
    global _errors_save_timer
    if _errors_save_timer:
        _errors_save_timer.cancel()
    _errors_save_timer = threading.Timer(SAVE_DEBOUNCE_SEC, _flush_errors)
    _errors_save_timer.daemon = True
    _errors_save_timer.start()


def _flush_errors():
    try:
        tmp = ERRORS_FILE + ".tmp"
        with _errors_lock:
            data = dict(_errors)
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
        os.replace(tmp, ERRORS_FILE)
    except OSError:
        pass


def _save_errors(sid: str, items: list[dict]):
    """将纠错项存入错误本，去重合并"""
    _load_errors()
    today = date.today().isoformat()
    existing = _errors.setdefault(sid, [])
    seen = {(e.get("wrong", ""), e.get("correct", "")) for e in existing}
    for item in items:
        key = (item.get("wrong", ""), item.get("correct", ""))
        if key not in seen:
            item["date"] = today
            existing.append(item)
            seen.add(key)
    _save_errors_data()


def _get_weakness(sid: str) -> dict:
    """分析弱项：从错误本统计最常见的错误类型

    优先用 note 字段分类（AI 返回的解释通常包含明确分类信息），
    回退到基于 correct 表达特征的启发式判断。
    """
    _load_errors()
    items = _errors.get(sid, [])
    if not items:
        return {"total_errors": 0, "categories": [], "recent": []}

    categories = {"助詞": 0, "時制・活用": 0, "敬語": 0, "語彙・表現": 0, "その他": 0}

    # note 关键词映射（AI 纠错解释中常出现的分类词）
    note_patterns = [
        ("助詞", ["助詞", "particle", "は/が", "を/に", "で/に", "へ/に"]),
        ("時制・活用", ["時制", "活用", "動詞", "過去", "て形", "ない形", "ます形", "tense", "conjugat"]),
        ("敬語", ["敬語", "丁寧", "ます", "です", "尊敬", "謙譲", "keigo", "polite"]),
        ("語彙・表現", ["語彙", "単語", "表現", "言い方", "vocabulary", "expression"]),
    ]

    for item in items:
        note = item.get("note", "").lower()
        correct = item.get("correct", "")
        classified = False

        # 优先用 note 分类
        if note:
            for cat, keywords in note_patterns:
                if any(kw in note for kw in keywords):
                    categories[cat] += 1
                    classified = True
                    break

        # 回退：用 correct 表达特征判断
        if not classified:
            if any(k in correct for k in ["ました", "ています", "ていた", "でしょう"]):
                categories["時制・活用"] += 1
            elif any(k in correct for k in ["ください", "いただく", "なさる", "ございます"]):
                categories["敬語"] += 1
            elif len(correct) <= 4:  # 短答案多为助詞/单词级修正
                categories["助詞"] += 1
            else:
                categories["語彙・表現"] += 1

    sorted_cats = sorted(categories.items(), key=lambda x: -x[1])
    return {
        "total_errors": len(items),
        "categories": [{"name": k, "count": v} for k, v in sorted_cats if v > 0],
        "recent": items[-10:][::-1],  # 最近10条，倒序
    }


# ---------- SRS 间隔复习 ----------
@app.get("/api/srs/due")
def srs_due(request: Request, response: Response):
    """获取今日到期待复习的词"""
    _require_auth(request)
    sid = _get_session(request, response)
    due = srs.get_due_words(sid)
    stats = srs.get_stats(sid)
    return {"words": due, "stats": stats}


@app.post("/api/srs/grade")
def srs_grade(req: SrsGradeRequest, request: Request, response: Response):
    """评分一个词的复习效果，更新 SRS 排期"""
    _require_auth(request)
    sid = _get_session(request, response)

    if req.quality < 0 or req.quality > 5:
        raise HTTPException(status_code=400, detail="quality は 0〜5 で指定してください")

    result = srs.grade_word(sid, req.word.strip(), req.quality)
    if result is None:
        raise HTTPException(status_code=404, detail="単語が見つかりません")

    return {"word": result, "stats": srs.get_stats(sid)}


@app.get("/api/srs/stats")
def srs_stats(request: Request, response: Response):
    """复习统计"""
    _require_auth(request)
    sid = _get_session(request, response)
    return srs.get_stats(sid)


# ---------- 导出 Markdown ----------
@app.get("/api/export/markdown")
def export_md(request: Request, response: Response):
    """导出当前会话的对话记录为 Markdown"""
    _require_auth(request)
    sid = _get_session(request, response)
    md = export_markdown(sid)
    return PlainTextResponse(
        content=md,
        media_type="text/markdown; charset=utf-8",
        headers={
            "Content-Disposition": f"attachment; filename=nihongo_chat_{date.today().isoformat()}.md"
        },
    )


# ---------- 统计：打卡 + 场景通关 + 弱项 ----------
@app.get("/api/stats")
def get_stats(request: Request, response: Response):
    """获取用户统计数据：连续打卡、场景通关、弱项概览"""
    _require_auth(request)
    sid = _get_session(request, response)
    _load_stats()
    s = _stats.get(sid, {})
    checkins = s.get("checkins", [])
    scenes_done = s.get("scenes_done", {})
    
    # 计算连续打卡天数
    today = date.today()
    streak = 0
    for i in range(365):
        d = (today - timedelta(days=i)).isoformat()
        if d in checkins:
            streak += 1
        else:
            break
    
    # 弱项报告
    weakness = _get_weakness(sid)
    
    return {
        "streak": streak,
        "total_days": len(checkins),
        "today_active": today.isoformat() in checkins,
        "scenes_done": scenes_done,
        "total_scenes_done": len(scenes_done),
        "weakness": weakness,
    }


@app.get("/api/stats/weakness")
def get_weakness_report(request: Request, response: Response):
    """弱项详细分析"""
    _require_auth(request)
    sid = _get_session(request, response)
    return _get_weakness(sid)


# ---------- 错误本 ----------
@app.get("/api/errors")
def get_errors(request: Request, response: Response):
    """获取错误本"""
    _require_auth(request)
    sid = _get_session(request, response)
    _load_errors()
    items = _errors.get(sid, [])
    # 按日期分组
    grouped = {}
    for item in items:
        d = item.get("date", "unknown")
        grouped.setdefault(d, []).append(item)
    return {
        "total": len(items),
        "by_date": grouped,
        "items": items[-50:][::-1],  # 最近50条
    }


@app.delete("/api/errors")
def clear_errors(request: Request, response: Response):
    """清空错误本"""
    _require_auth(request)
    sid = _get_session(request, response)
    _load_errors()
    _errors.pop(sid, None)
    _save_errors_data()
    return {"status": "ok"}


# ---------- 量词专项练习 ----------
@app.get("/api/assist/counter")
def counter_quiz(request: Request, count: int = 5):
    """获取日语量词练习题"""
    _require_auth(request)
    questions = get_counter_quiz(count)
    return {"questions": questions}


# 前端静态文件
frontend_dir = os.path.join(os.path.dirname(__file__), "..", "frontend")
app.mount("/", StaticFiles(directory=frontend_dir, html=True), name="frontend")


if __name__ == "__main__":
    print(f"""
╔══════════════════════════════════╗
║     🎌 日本語チャット v1.6      ║
║   http://localhost:{PORT}        ║
║  iPhoneでSafariを開いてね ☺     ║
╚══════════════════════════════════╝
""")
    uvicorn.run(app, host=HOST, port=PORT)
