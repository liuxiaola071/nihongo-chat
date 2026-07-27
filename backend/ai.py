# 日本語チャット — AI 对话模块
# 调用 DeepSeek API，扮演日语老师角色

import requests
from config import DEEPSEEK_API_KEY, DEEPSEEK_MODEL, MAX_HISTORY_TURNS

DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions"

SYSTEM_PROMPT = """あなたは日本語会話の練習相手です。以下のルールを厳守してください：

1. 必ず日本語で返事すること（英語や中国語は使わない）
2. 学習者のレベルに合わせて、優しく自然な日本語で話すこと
3. 相手が言い間違えたら、さりげなく正しい表現で返すこと（「それは間違いです」とは言わず、自然に直す）
4. 返事は2〜3文程度にまとめること（長すぎない）
5. 相手が話を続けやすいように、必ず質問で終わること
6. 難しい単語を使ったら、簡単な言い換えも添えること
7. 前の会話の内容を覚えていて、自然に話をつなげること

あなたは20代の明るい日本人女性です。名前は「さくら」です。"""


# 对话历史。每个元素形如 {"role": "user"/"assistant", "content": "..."}
# 只保留最近 MAX_HISTORY_TURNS 轮，太长会让 API 费用飙升
_history: list[dict] = []


def reset_history():
    """清空对话记忆，从头开始聊"""
    _history.clear()


def get_history() -> list[dict]:
    """返回当前对话历史（前端刷新页面时可以用来恢复）"""
    return list(_history)


def chat_with_sakura(user_text: str) -> str:
    """发送用户消息，返回 AI 日语回复（带对话记忆）"""

    # 系统提示 + 历史对话 + 这次的新消息
    messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    messages.extend(_history)
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
    _history.append({"role": "user", "content": user_text})
    _history.append({"role": "assistant", "content": reply})

    # 超出上限就丢掉最老的一轮（一轮 = 2 条消息）
    max_messages = MAX_HISTORY_TURNS * 2
    while len(_history) > max_messages:
        _history.pop(0)
        _history.pop(0)

    return reply
