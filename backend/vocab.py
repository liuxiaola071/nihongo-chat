# 日本語チャット — 今日生词本
# 自动收集聊天中出现的新单词，支持导出成 Anki 可导入的 CSV

import json
import os
import re
import threading
from datetime import date

import config as _cfg

# 单词本存放位置（默认 backend/data/vocab.json，云函数上由 NIHONGO_DATA_DIR 指到 /tmp）
# ⚠️ 磁盘是临时的，重启会清空 → 记得定期导出
DATA_DIR = _cfg.DATA_DIR
VOCAB_FILE = os.path.join(DATA_DIR, "vocab.json")

# AI 回复末尾的生词标记，例如：
#   ###WORDS### 天気|てんき|天气; 暖かい|あたたかい|暖和的
WORDS_MARKER = "###WORDS###"
_MARKER_RE = re.compile(re.escape(WORDS_MARKER) + r".*", re.DOTALL)

MAX_WORDS_PER_DAY = 300     # 单日上限，防止文件无限膨胀
_lock = threading.Lock()    # 多请求同时写文件时加锁

# 结构：{ session_id: { "2026-07-28": [ {word, kana, meaning}, ... ] } }
_vocab: dict[str, dict[str, list[dict]]] = {}
_loaded = False


def _load():
    """第一次用时从磁盘读进内存"""
    global _vocab, _loaded
    if _loaded:
        return
    _loaded = True
    try:
        with open(VOCAB_FILE, "r", encoding="utf-8") as f:
            _vocab = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        _vocab = {}


def _save():
    """写回磁盘（失败不影响聊天，只打日志）"""
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        tmp = VOCAB_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(_vocab, f, ensure_ascii=False, indent=1)
        os.replace(tmp, VOCAB_FILE)   # 先写临时文件再替换，避免写坏
    except OSError as e:
        print(f"[VOCAB] 保存失败: {e}")


def split_reply(reply: str) -> tuple[str, list[dict]]:
    """把 AI 回复拆成「给用户看的正文」和「生词列表」

    AI 被要求在回复最后加一行：
        ###WORDS### 単語|かな|中文意思; 単語2|かな2|意思2
    这一段不能读给用户听，所以要先切掉。
    """
    idx = reply.find(WORDS_MARKER)
    if idx == -1:
        return reply.strip(), []

    clean = reply[:idx].strip()
    raw = reply[idx + len(WORDS_MARKER):].strip()
    return clean, _parse_words(raw)


def _parse_words(raw: str) -> list[dict]:
    """解析 `単語|かな|意思; 単語2|かな2|意思2` 这种格式"""
    words = []
    for chunk in re.split(r"[;；\n]", raw):
        chunk = chunk.strip()
        if not chunk:
            continue
        parts = [p.strip() for p in re.split(r"[|｜]", chunk)]
        word = parts[0] if parts else ""
        # AI 偶尔会写成「なし」「無し」表示没有新词
        if not word or word in ("なし", "無し", "none", "-"):
            continue
        if len(word) > 30:      # 明显解析歪了，丢掉
            continue
        words.append({
            "word": word,
            "kana": parts[1] if len(parts) > 1 else "",
            "meaning": parts[2] if len(parts) > 2 else "",
        })
    return words


def add_words(session_id: str, words: list[dict]):
    """把新词记进今天的生词本（同一个词不重复记）"""
    if not words:
        return
    with _lock:
        _load()
        today = date.today().isoformat()
        day_list = _vocab.setdefault(session_id, {}).setdefault(today, [])
        existing = {w["word"] for w in day_list}

        changed = False
        for w in words:
            if w["word"] in existing or len(day_list) >= MAX_WORDS_PER_DAY:
                continue
            day_list.append(w)
            existing.add(w["word"])
            changed = True

        if changed:
            _save()


def get_words(session_id: str, day: str | None = None) -> list[dict]:
    """取某天的生词（默认今天）"""
    with _lock:
        _load()
        target = day or date.today().isoformat()
        return list(_vocab.get(session_id, {}).get(target, []))


def get_all_days(session_id: str) -> dict[str, int]:
    """返回 {日期: 生词数}，按日期倒序，用于前端显示历史"""
    with _lock:
        _load()
        days = _vocab.get(session_id, {})
        return {d: len(days[d]) for d in sorted(days, reverse=True)}


def clear_words(session_id: str, day: str | None = None):
    """清空某天的生词（默认今天）"""
    with _lock:
        _load()
        target = day or date.today().isoformat()
        if _vocab.get(session_id, {}).pop(target, None) is not None:
            _save()


def to_anki_csv(session_id: str, day: str | None = None) -> str:
    """导出成 Anki 能直接导入的 CSV

    Anki 导入时选「逗号分隔」，字段顺序：正面(単語+かな) / 背面(中文)
    """
    words = get_words(session_id, day)
    lines = []
    for w in words:
        front = w["word"]
        if w.get("kana"):
            front += f"（{w['kana']}）"
        back = w.get("meaning", "")
        lines.append(f'"{_csv_escape(front)}","{_csv_escape(back)}"')
    return "\n".join(lines)


def _csv_escape(s: str) -> str:
    """CSV 里的双引号要写两遍，换行换成空格"""
    return s.replace('"', '""').replace("\n", " ").replace("\r", " ")
