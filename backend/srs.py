"""
日本語チャット — SRS 间隔复习引擎（SM2 算法）

基于 SuperMemo SM2 算法的简化实现。
每个生词维护：间隔天数、难度系数、复习次数、下次复习日期。
"""

import json
import os
import threading
from datetime import date, timedelta

DATA_DIR = os.path.join(os.path.dirname(__file__), "data")
SRS_FILE = os.path.join(DATA_DIR, "srs.json")

_lock = threading.Lock()

# 结构：
# {
#   session_id: {
#     word: {
#       "word": str, "kana": str, "meaning": str,
#       "interval": int,       # 当前间隔（天）
#       "ease_factor": float,  # 难度系数（≥1.3）
#       "repetitions": int,    # 连续正确次数
#       "next_review": str,    # 下次复习日期 yyyy-mm-dd
#       "last_review": str,    # 上次复习日期
#       "total_reviews": int,  # 总复习次数
#       "created": str,        # 收录日期
#     }
#   }
# }
_srs: dict[str, dict[str, dict]] = {}
_loaded = False


def _load():
    global _srs, _loaded
    if _loaded:
        return
    _loaded = True
    try:
        with open(SRS_FILE, "r", encoding="utf-8") as f:
            _srs = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        _srs = {}


def _save():
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        tmp = SRS_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(_srs, f, ensure_ascii=False, indent=1)
        os.replace(tmp, SRS_FILE)
    except OSError as e:
        print(f"[SRS] 保存失败: {e}")


def _sm2(quality: int, old_interval: int, old_ef: float, old_reps: int) -> tuple[int, float, int]:
    """SM2 核心算法

    quality: 0-5
      5 = 秒答正确
      4 = 犹豫后正确
      3 = 困难但正确
      2 = 错误但见过
      1 = 完全忘记
      0 = 彻底不会

    返回: (新间隔, 新难度系数, 新重复次数)
    """
    if quality >= 3:
        if old_reps == 0:
            new_interval = 1
        elif old_reps == 1:
            new_interval = 6
        else:
            new_interval = round(old_interval * old_ef)
        new_reps = old_reps + 1
    else:
        new_interval = 1
        new_reps = 0

    # 更新 ease factor
    new_ef = old_ef + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02))
    if new_ef < 1.3:
        new_ef = 1.3

    return new_interval, new_ef, new_reps


def add_word(session_id: str, word: str, kana: str = "", meaning: str = ""):
    """把新词加入 SRS 复习队列（不重复添加）"""
    with _lock:
        _load()
        user_words = _srs.setdefault(session_id, {})
        if word in user_words:
            return  # 已存在，跳过

        today = date.today().isoformat()
        user_words[word] = {
            "word": word,
            "kana": kana,
            "meaning": meaning,
            "interval": 0,
            "ease_factor": 2.5,
            "repetitions": 0,
            "next_review": today,   # 当天就可以开始复习
            "last_review": "",
            "total_reviews": 0,
            "created": today,
        }
        _save()


def get_due_words(session_id: str) -> list[dict]:
    """获取今日到期待复习的词（不含今天新学的）"""
    with _lock:
        _load()
        user_words = _srs.get(session_id, {})
        today = date.today().isoformat()
        due = []
        for w in user_words.values():
            if w["next_review"] <= today:
                due.append(dict(w))
        # 按间隔升序 → 新词先出
        due.sort(key=lambda x: x["interval"])
        return due


def grade_word(session_id: str, word: str, quality: int) -> dict | None:
    """评分后更新复习计划"""
    with _lock:
        _load()
        user_words = _srs.get(session_id, {})
        if word not in user_words:
            return None

        w = user_words[word]
        new_interval, new_ef, new_reps = _sm2(
            quality, w["interval"], w["ease_factor"], w["repetitions"]
        )

        today = date.today()
        w["interval"] = new_interval
        w["ease_factor"] = round(new_ef, 2)
        w["repetitions"] = new_reps
        w["last_review"] = today.isoformat()
        w["next_review"] = (today + timedelta(days=new_interval)).isoformat()
        w["total_reviews"] += 1

        _save()
        return dict(w)


def get_stats(session_id: str) -> dict:
    """复习统计"""
    with _lock:
        _load()
        user_words = _srs.get(session_id, {})
        today = date.today().isoformat()
        total = len(user_words)
        due = sum(1 for w in user_words.values() if w["next_review"] <= today)
        # 掌握 = 连续正确 ≥3 次 且间隔 ≥21 天
        mastered = sum(
            1 for w in user_words.values()
            if w["repetitions"] >= 3 and w["interval"] >= 21
        )
        learning = total - mastered
        return {
            "total": total,
            "due": due,
            "mastered": mastered,
            "learning": learning,
        }


def add_words_batch(session_id: str, words: list[dict]):
    """批量加入 SRS（配合 vocab.add_words 使用）"""
    for w in words:
        add_word(session_id, w.get("word", ""), w.get("kana", ""), w.get("meaning", ""))
