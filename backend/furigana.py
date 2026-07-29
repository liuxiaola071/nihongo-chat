"""
日本語チャット — 振假名（ふりがな）引擎

用 janome（纯 Python 日语分词器）把汉字自动标上读音。
支持两种输出：
  - JSON 格式：前端用 <ruby> 标签自己渲染
  - HTML 格式：直接嵌入页面
"""

from janome.tokenizer import Tokenizer
import re

# 全局单例，避免反复初始化
_tokenizer: Tokenizer | None = None


def _get_tokenizer() -> Tokenizer:
    global _tokenizer
    if _tokenizer is None:
        _tokenizer = Tokenizer()
    return _tokenizer


def _kata_to_hira(text: str) -> str:
    """片假名 → 平假名（振假名一般用平假名标注）"""
    result = []
    for ch in text:
        code = ord(ch)
        if 0x30A1 <= code <= 0x30F6:  # ァ～ヶ
            result.append(chr(code - 0x60))
        else:
            result.append(ch)
    return "".join(result)


# 匹配任意汉字
_KANJI_RE = re.compile(r"[\u4E00-\u9FFF\u3400-\u4DBF]")


def _has_kanji(text: str) -> bool:
    return bool(_KANJI_RE.search(text))


def analyze(text: str) -> list[dict]:
    """分词并返回每个词的读音信息

    返回: [{"surface": "今日", "reading": "きょう", "has_kanji": True, "pos": "名詞"}, ...]
    """
    t = _get_tokenizer()
    tokens = []
    for tok in t.tokenize(text):
        surface = tok.surface
        reading = tok.reading if tok.reading != "*" else surface  # 読めない場合は表層形
        reading = _kata_to_hira(reading)
        tokens.append({
            "surface": surface,
            "reading": reading,
            "has_kanji": _has_kanji(surface),
            "pos": tok.part_of_speech.split(",")[0] if tok.part_of_speech else "",
        })
    return tokens


def to_ruby_html(text: str) -> str:
    """生成带 <ruby> 标签的 HTML

    只有含汉字且读音和表层形不同的词才加振假名，假名部分直接输出。
    """
    tokens = analyze(text)
    parts = []
    for tok in tokens:
        if tok["has_kanji"] and tok["reading"] != tok["surface"]:
            parts.append(f'<ruby>{tok["surface"]}<rt>{tok["reading"]}</rt></ruby>')
        else:
            parts.append(tok["surface"])
    return "".join(parts)
