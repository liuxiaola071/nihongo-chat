# 日本語チャット — AI 对话模块
# 调用 DeepSeek API，扮演日语老师角色

import requests
from config import DEEPSEEK_API_KEY, DEEPSEEK_MODEL

SYSTEM_PROMPT = """あなたは日本語会話の練習相手です。以下のルールを厳守してください：

1. 必ず日本語で返事すること（英語や中国語は使わない）
2. 学習者のレベルに合わせて、優しく自然な日本語で話すこと
3. 相手が言い間違えたら、さりげなく正しい表現で返すこと（「それは間違いです」とは言わず、自然に直す）
4. 返事は2〜3文程度にまとめること（長すぎない）
5. 相手が話を続けやすいように、必ず質問で終わること
6. 難しい単語を使ったら、簡単な言い換えも添えること

あなたは20代の明るい日本人女性です。名前は「さくら」です。"""


def chat_with_sakura(user_text: str) -> str:
    """发送用户消息，返回 AI 日语回复"""
    url = "https://api.deepseek.com/v1/chat/completions"

    payload = {
        "model": DEEPSEEK_MODEL,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_text},
        ],
        "temperature": 0.7,
        "max_tokens": 200,
    }

    try:
        resp = requests.post(
            url,
            headers={
                "Authorization": f"Bearer {DEEPSEEK_API_KEY}",
                "Content-Type": "application/json",
            },
            json=payload,
            timeout=15,
        )
        data = resp.json()
        return data["choices"][0]["message"]["content"].strip()
    except Exception as e:
        return f"[エラー] もう一度試してください: {e}"
