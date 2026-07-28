# 日本語チャット — AI 对话模块
# 调用 DeepSeek API，扮演日语老师角色

import time
import requests
from config import DEEPSEEK_API_KEY, DEEPSEEK_MODEL, MAX_HISTORY_TURNS

DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions"

SYSTEM_PROMPT = """あなたは日本語会話の練習相手です。以下のルールを厳守してください：

1. 基本は日本語で返事すること。ただし、学習者が中国語で質問した場合や「これは日本語で何と言いますか」のように言い方を尋ねた場合は、中国語での説明＋日本語の例文をセットで答えること
2. 学習者のレベルに合わせて、優しく自然な日本語で話すこと
3. 相手が文法や単語を間違えたら、まず正しい表現を明示すること（例：「〇〇より△△の方が自然だよ😊」）。さりげなく直すだけでは学習者が気づけないので、はっきり教えてから会話を続けること
4. 返事は2〜3文程度にまとめること（長すぎない）
5. 相手が話を続けやすいように、必ず質問で終わること
6. 難しい単語を使ったら、簡単な言い換えも添えること
7. 前の会話の内容を覚えていて、自然に話をつなげること

あなたは20代の明るい日本人女性です。名前は「さくら」です。"""


# 按会话（session）隔离的对话历史，多人同时用互不串话
# key = session_id, value = [{"role": "user"/"assistant", "content": "..."}, ...]
_histories: dict[str, list[dict]] = {}
_last_active: dict[str, float] = {}   # session_id → 最后活跃时间戳
MAX_SESSIONS = 200                     # 最多同时保留多少个会话
SESSION_TTL = 86400                    # 超过 24 小时没活动的会话自动清理


def _cleanup_stale():
    """清理过期会话，防止服务器内存无限增长"""
    now = time.time()
    stale = [sid for sid, t in _last_active.items() if now - t > SESSION_TTL]
    for sid in stale:
        _histories.pop(sid, None)
        _last_active.pop(sid, None)
    # 会话数超上限时，踢掉最老的
    while len(_histories) > MAX_SESSIONS:
        oldest = min(_last_active, key=_last_active.get)
        _histories.pop(oldest, None)
        _last_active.pop(oldest, None)


def reset_history(session_id: str):
    """清空某个会话的对话记忆"""
    _histories.pop(session_id, None)
    _last_active.pop(session_id, None)


def get_history(session_id: str) -> list[dict]:
    """返回某个会话的对话历史"""
    return list(_histories.get(session_id, []))


def chat_with_sakura(user_text: str, session_id: str) -> str:
    """发送用户消息，返回 AI 日语回复（带对话记忆，按会话隔离）"""
    _cleanup_stale()
    history = _histories.setdefault(session_id, [])
    _last_active[session_id] = time.time()

    # 系统提示 + 历史对话 + 这次的新消息
    messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    messages.extend(history)
    messages.append({"role": "user", "content": user_text})

    payload = {
        "model": DEEPSEEK_MODEL,
        "messages": messages,
        "temperature": 0.7,
        "max_tokens": 400,
    }

    try:
        resp = requests.post(
            DEEPSEEK_URL,
            headers={
                "Authorization": f"Bearer {DEEPSEEK_API_KEY}",
                "Content-Type": "application/json",
            },
            json=payload,
            timeout=15,
        )
        resp.raise_for_status()
        data = resp.json()
        reply = data["choices"][0]["message"]["content"].strip()

    except requests.exceptions.Timeout:
        print("[AI ERROR] DeepSeek 请求超时")
        return "ごめんね、ちょっと聞こえなかった。もう一度言ってくれる？"
    except requests.exceptions.RequestException as e:
        print(f"[AI ERROR] DeepSeek 请求失败: {e}")
        return "ごめんね、今ちょっと調子が悪いみたい。あとでまた話そう？"
    except (KeyError, IndexError, ValueError) as e:
        print(f"[AI ERROR] DeepSeek 返回格式异常: {e}")
        return "うーん、うまく答えられなかった。もう一度お願い！"

    # 成功了才记进历史（失败的话不污染记忆）
    history.append({"role": "user", "content": user_text})
    history.append({"role": "assistant", "content": reply})

    # 超出上限就丢掉最老的一轮（一轮 = 2 条消息）
    max_messages = MAX_HISTORY_TURNS * 2
    while len(history) > max_messages:
        history.pop(0)
        history.pop(0)

    return reply
