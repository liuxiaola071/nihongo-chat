# 日本語チャット — AI 对话模块
# 调用 DeepSeek API，扮演日语老师角色

import time
import json
import os
import threading
import requests
from config import DEEPSEEK_API_KEY, DEEPSEEK_MODEL, MAX_HISTORY_TURNS
from scenarios import get_scenario

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

# N5-N1 难度提示
LEVEL_INSTRUCTIONS = {
    "N5": "\n\n【レベル：N5】学習者は日本語初心者です。"
           "ひらがなを多めに、漢字には必ずふりがなを（例：天気（てんき））。"
           "文法は N5 レベルのみ（～です・ます、～たい、～たことがある など）。"
           "一文は短く、単語も基本的なものだけ使ってください。",
    "N4": "\n\n【レベル：N4】学習者は初級後半です。"
           "簡単な漢字ならふりがな不要。"
           "文法は N4 まで（～かもしれない、～ようだ、～てもいい など）。"
           "文は中程度の長さで、日常会話レベルの単語を使ってください。",
    "N3": "\n\n【レベル：N3】学習者は中級です。"
           "常用漢字はほぼ読めるので、ふりがな不要。"
           "少し複雑な文型（～わけではない、～べきだ など）も使ってOK。"
           "自然なスピードの日常会話ができるレベル。",
    "N2": "\n\n【レベル：N2】学習者は中上級です。"
           "敬語・謙譲語を使い分けられるレベル。新聞やニュースの話題もOK。"
           "抽象的な話題や意見交換もでき、フォーマルな場面も扱える。",
    "N1": "\n\n【レベル：N1】学習者は上級です。ネイティブに近いレベル。"
           "複雑な文章、専門的な話題、ビジネス会話もOK。"
           "表現のニュアンスや微妙な言い回しも教えられるように。",
}

# 生词本用：让 AI 在回复最后单独列出这轮出现的重点单词
VOCAB_INSTRUCTION = """

【単語リスト（必須）】
返事の最後に必ず改行して、この会話で学習者が覚えるべき単語を1行で出力すること。
フォーマット（厳守）：
###WORDS### 単語|ひらがな|中国語の意味; 単語2|ひらがな2|中国語の意味2

ルール：
- 1〜4語まで。あなたが使った少し難しい単語や、学習者が間違えた表現を優先する
- ひらがな読みと中国語訳を必ず両方書く
- 新しい単語がない場合は「###WORDS### なし」と書く
- この行は会話文の一部ではないので、絶対に本文の中に混ぜないこと"""

# 纠错模式专用指令
FIX_INSTRUCTION = """

【添削モード：最重要ルール】
今は「添削モード」です。学習者は自分の日本語を直してもらうことを一番期待しています。
会話は通常通り続けながら、返事の最後に必ず以下のブロックを出力してください。
このブロックを省略することは絶対に許されません。

###FIX###
❌ 間違えた表現 → ✅ 正しい表現
（なぜそうなるのか、簡単な説明）
###FIXEND###

厳守事項：
- 文法・助詞・活用・語彙選択・敬語レベル・自然さ、どの観点でも直せる点があれば必ず指摘する
- 間違いが複数ある場合は1行ずつ、すべて列挙する
- 文法的に正しくても不自然な表現なら「より自然な言い方」として指摘する
- 文体が混ざっている場合（です・ます体と普通体の混在など）も必ず指摘する
- 本当に一切直す点がない場合のみ「###FIX### なし ###FIXEND###」と書く
- 「なし」と書くのは極めて稀なケースです。まず直せる点を探してください"""

# 翻译模式专用指令
TRANS_MODE_INSTRUCTION = """

【翻訳モード：絶対ルール】
あなたは今「翻訳モード」です。会話の相手ではなく翻訳機です。
学習者の入力テキストを中国語に翻訳することだけがあなたの仕事です。
以下のルールを絶対に守ってください：

1. 翻訳結果だけを出力する。会話を続けてはいけない
2. 質問しない。相槌を打たない。自己紹介しない
3. 自然な中国語で翻訳すること
4. 補足説明が必要な場合（文化的表現や特殊な言い回し）は翻訳の後に()で簡潔に書く"""

# 查词模式专用指令
WORD_MODE_INSTRUCTION = """

【辞書モード】
学習者が単語の意味を調べています。以下の形式で返信してください：
📖 単語：
🔊 読み方：
📝 意味：
💬 例文：
（あれば）類義語・反意語："""

# ── 语气切换指令 ──
TONE_INSTRUCTIONS = {
    "polite": "\n\n【話し方：敬語】です・ます体で、丁寧な言葉遣いを徹底してください。"
              "初対面の相手や目上の人と話すように、礼儀正しく。",
    "casual": "\n\n【話し方：タメ口】友達同士の気軽な話し方で。だ・である体を使い、"
              "「～だよ」「～ね」「～じゃん」などくだけた表現で。"
              "語尾を伸ばしたり、絵文字も多めに。敬語は一切使わないで。",
    "kansai": "\n\n【話し方：関西弁】関西のお姉さんとして話して。"
              "語尾は「～やで」「～やん」「～なぁ」「～してん」。「だ」→「や」、"
              "「～ている」→「～とる」、「～ない」→「～へん」など自然な関西弁で。"
              "「ほんま」「あかん」「ええ」「なんでやねん」などの関西弁フレーズを積極的に使って。",
}


# 按会话（session）隔离的对话历史，多人同时用互不串话
# key = session_id, value = [{"role": "user"/"assistant", "content": "..."}, ...]
_histories: dict[str, list[dict]] = {}
_last_active: dict[str, float] = {}   # session_id → 最后活跃时间戳
MAX_SESSIONS = 200                     # 最多同时保留多少个会话
SESSION_TTL = 86400                    # 超过 24 小时没活动的会话自动清理

# ── 对话历史持久化 ──
HISTORY_FILE = os.path.join(os.path.dirname(__file__), "data", "chat_history.json")
_history_lock = threading.Lock()
_history_loaded = False
_save_timer: threading.Timer | None = None
SAVE_DEBOUNCE_SEC = 3  # 3秒内多次写入合并为一次


def _load_histories():
    """从磁盘恢复对话历史（服务器重启后保留记忆）"""
    global _histories, _last_active, _history_loaded
    if _history_loaded:
        return
    _history_loaded = True
    try:
        with open(HISTORY_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        _histories = data.get("histories", {})
        _last_active = data.get("last_active", {})
        # 只恢复最近 N 轮，节省内存
        max_msgs = MAX_HISTORY_TURNS * 2
        for sid in list(_histories.keys()):
            if len(_histories[sid]) > max_msgs:
                _histories[sid] = _histories[sid][-max_msgs:]
        print(f"[AI] 已恢复 {len(_histories)} 个会话的历史记录")
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        pass


def _save_histories():
    """把对话历史写入磁盘（线程安全）"""
    try:
        os.makedirs(os.path.dirname(HISTORY_FILE), exist_ok=True)
        tmp = HISTORY_FILE + ".tmp"
        with _history_lock:
            data = {
                "histories": _histories,
                "last_active": _last_active,
            }
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
        os.replace(tmp, HISTORY_FILE)
    except OSError as e:
        print(f"[AI] 历史保存失败: {e}")


def _save_histories_debounced():
    """防抖写入：N秒内多次调用只写一次磁盘，减少 IO"""
    global _save_timer
    if _save_timer is not None:
        _save_timer.cancel()
    _save_timer = threading.Timer(SAVE_DEBOUNCE_SEC, _save_histories)
    _save_timer.daemon = True
    _save_timer.start()


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
    _save_histories()


def get_history(session_id: str) -> list[dict]:
    """返回某个会话的对话历史"""
    return list(_histories.get(session_id, []))


def export_markdown(session_id: str) -> str:
    """将会话历史导出为 Markdown 格式"""
    _load_histories()
    history = _histories.get(session_id, [])
    if not history:
        return "# 日本語チャット — 会話記録\n\n*会話履歴がありません*"

    now = time.strftime("%Y-%m-%d %H:%M")
    lines = [
        "# 日本語チャット — 会話記録",
        f"*エクスポート日時: {now}*",
        "",
        "---",
        "",
    ]
    for msg in history:
        role_label = "🧑 あなた" if msg["role"] == "user" else "🌸 さくら"
        lines.append(f"### {role_label}")
        lines.append("")
        lines.append(msg["content"])
        lines.append("")
    return "\n".join(lines)


def chat_with_sakura(
    user_text: str,
    session_id: str,
    scenario_id: str | None = None,
    mode: str = "chat",
    level: str = "N4",
    tone: str = "polite",
) -> str:
    """发送用户消息，返回 AI 日语回复

    返回的文本可能带有 ###WORDS###（生词）和 ###FIX###（纠错）标记行，
    由调用方自行解析拆分。

    mode 支持: chat(默认)/correct(纠错)/translate(翻译)/word(查词)
    level: N5|N4|N3|N2|N1，默认 N4
    tone: polite(敬語)|casual(タメ口)|kansai(関西弁)，默认 polite
    """
    _cleanup_stale()
    _load_histories()
    history = _histories.setdefault(session_id, [])
    _last_active[session_id] = time.time()

    # === 构建系统提示 ===
    system_content = SYSTEM_PROMPT

    # 场景设定
    scenario = get_scenario(scenario_id)
    if scenario["prompt"]:
        system_content += "\n\n" + scenario["prompt"]

    # 难度级别
    level_key = level.upper() if level.upper() in LEVEL_INSTRUCTIONS else "N4"
    system_content += LEVEL_INSTRUCTIONS[level_key]

    # 语气设定
    tone_key = tone if tone in TONE_INSTRUCTIONS else "polite"
    system_content += TONE_INSTRUCTIONS[tone_key]

    # 模式指令
    mode_map = {
        "correct": FIX_INSTRUCTION,
        "translate": TRANS_MODE_INSTRUCTION,
        "word": WORD_MODE_INSTRUCTION,
    }
    if mode in mode_map:
        system_content += "\n\n" + mode_map[mode]

    # 生词本（翻译/查词模式不需要生词收集）
    if mode not in ("translate", "word"):
        system_content += VOCAB_INSTRUCTION

    # === 构建消息列表 ===
    messages = [{"role": "system", "content": system_content}]
    # 翻译模式是无状态的，不带历史上下文，否则 AI 会继续对话而非翻译
    if mode != "translate":
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
            timeout=45,
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

    # 成功了才记进历史（失败不污染记忆）
    # 翻译模式不入历史——它是无状态的独立操作
    if mode != "translate":
        # 历史只存正文部分，去掉 ###WORDS### 和 ###FIX### 标记块，省 token
        clean = reply
        for marker in ("###WORDS###", "###FIX###"):
            if marker in clean:
                clean = clean.split(marker)[0].strip()
        if not clean:
            clean = reply
        history.append({"role": "user", "content": user_text})
        history.append({"role": "assistant", "content": clean})

        # 超出上限就丢掉最老的一轮
        max_messages = MAX_HISTORY_TURNS * 2
        while len(history) > max_messages:
            history.pop(0)
            history.pop(0)

        _save_histories_debounced()

    return reply
