# 日本語チャット — TTS 语音模块
# 优先级：Edge TTS（免费无限量·跨平台）→ ElevenLabs API → Windows 内置日语 TTS

import requests
import base64
import platform
import hashlib
from collections import OrderedDict
from config import ELEVENLABS_API_KEY, VOICE_ID, EDGE_TTS_VOICE, EDGE_TTS_RATE

# ============================================================
# LRU 缓存：相同文本不重复合成（maxsize=256，够日常用）
# ============================================================

_tts_cache: OrderedDict[str, str] = OrderedDict()
_tts_cache_max = 256


def _cache_key(text: str, rate: str = "") -> str:
    return hashlib.md5((text + "|" + rate).encode("utf-8")).hexdigest()


def _tts_get(text: str, rate: str = "") -> str | None:
    key = _cache_key(text, rate)
    if key in _tts_cache:
        _tts_cache.move_to_end(key)  # 命中时移到末尾（最近使用）
        return _tts_cache[key]
    return None


def _tts_set(text: str, b64: str, rate: str = ""):
    key = _cache_key(text, rate)
    if key in _tts_cache:
        _tts_cache.move_to_end(key)
    else:
        if len(_tts_cache) >= _tts_cache_max:
            _tts_cache.popitem(last=False)  # 淘汰最久未用
    _tts_cache[key] = b64


def text_to_speech_edge(text: str, rate: str = "") -> str | None:
    """
    用微软 Edge TTS 生成日语语音，返回 base64 编码的 mp3。

    优点：完全免费、无额度限制、Linux/Windows/Mac 都能跑，
    用的是日语原生神经网络声音（Nanami / Keita），音质接近付费服务。
    失败返回 None。

    rate: 语速调整，如 "-20%"、"+10%"、""（默认）
    """
    import asyncio

    try:
        import edge_tts
    except ImportError:
        print("[TTS-Edge] 未安装 edge-tts，跳过（pip install edge-tts）")
        return None

    # 确定实际语速：优先用传入的 rate，否则用配置默认值
    actual_rate = rate if rate else EDGE_TTS_RATE

    async def _synthesize() -> bytes:
        comm = edge_tts.Communicate(text, EDGE_TTS_VOICE, rate=actual_rate)
        chunks = bytearray()
        async for chunk in comm.stream():
            if chunk["type"] == "audio":
                chunks.extend(chunk["data"])
        return bytes(chunks)

    try:
        # 先查缓存（含语速）
        cached = _tts_get(text, actual_rate)
        if cached is not None:
            return cached

        # 用独立事件循环，避免并发请求时 "loop already running" 崩溃
        loop = asyncio.new_event_loop()
        try:
            audio = loop.run_until_complete(
                asyncio.wait_for(_synthesize(), timeout=15)
            )
        finally:
            loop.close()
        if len(audio) > 100:
            result = base64.b64encode(audio).decode("utf-8")
            _tts_set(text, result, actual_rate)
            return result
        print("[TTS-Edge] 返回的音频太小，可能合成失败")
        return None
    except asyncio.TimeoutError:
        print("[TTS-Edge] 合成超时（15秒），跳过")
        return None
    except Exception as e:
        print(f"[TTS-Edge] 异常: {e}")
        return None


def text_to_speech_elevenlabs(text: str, rate: str = "") -> str | None:
    """
    调用 ElevenLabs API 将日语文字转为语音，返回 base64 编码的 mp3 数据
    失败返回 None

    rate: 语速调整，如 "-20%"、"+10%"、""（默认）
    """
    url = f"https://api.elevenlabs.io/v1/text-to-speech/{VOICE_ID}"
    headers = {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
    }
    # 解析语速：rate 如 "-20%" → 0.8, "+10%" → 1.1, "" → 0.9
    speed = 0.9
    if rate:
        try:
            pct = int(rate.replace("%", ""))
            speed = round(0.9 * (1 + pct / 100), 2)
            speed = max(0.3, min(3.0, speed))
        except ValueError:
            pass

    payload = {
        "text": text,
        "model_id": "eleven_multilingual_v2",
        "voice_settings": {
            "stability": 0.5,
            "similarity_boost": 0.8,
            "speed": speed,
        },
    }

    try:
        # 先查缓存（含语速）
        cached = _tts_get(text, rate)
        if cached is not None:
            return cached

        resp = requests.post(url, headers=headers, json=payload, timeout=20)
        if resp.status_code == 200:
            result = base64.b64encode(resp.content).decode("utf-8")
            _tts_set(text, result, rate)
            return result
        else:
            print(f"[TTS-ElevenLabs] 错误: {resp.status_code} {resp.text[:100]}")
            return None
    except Exception as e:
        print(f"[TTS-ElevenLabs] 异常: {e}")
        return None


def text_to_speech_windows(text: str) -> str | None:
    """
    使用 Windows 内置日语 TTS（Microsoft Haruka/Ayumi），返回 base64 WAV 数据
    无需安装任何额外软件，用 PowerShell 调用 System.Speech
    """
    import subprocess
    import tempfile
    import os

    try:
        # 把日文文本 base64 编码，避免 PowerShell 命令行转义问题
        text_b64 = base64.b64encode(text.encode("utf-8")).decode("ascii")

        # WAV 临时文件
        wav_fd, wav_path = tempfile.mkstemp(suffix=".wav")
        os.close(wav_fd)

        # PowerShell 脚本：用 System.Speech 选日语语音 → 输出 WAV
        ps = f'''
$text = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('{text_b64}'))
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$ja = $s.GetInstalledVoices() | Where-Object {{ $_.VoiceInfo.Culture.Name -like 'ja*' }} | Select-Object -First 1
if ($ja) {{ $s.SelectVoice($ja.VoiceInfo.Name) }}
$s.SetOutputToWaveFile('{wav_path}')
$s.Speak($text)
$s.Dispose()
'''
        result = subprocess.run(
            ["powershell", "-NoProfile", "-Command", ps],
            capture_output=True,
            timeout=30,
        )

        if result.returncode != 0:
            stderr = result.stderr.decode("utf-8", errors="ignore")[:200]
            print(f"[TTS-Windows] PowerShell 错误: {stderr}")
            if os.path.exists(wav_path):
                os.unlink(wav_path)
            return None

        # 读取 WAV → base64
        with open(wav_path, "rb") as f:
            wav_data = f.read()
        os.unlink(wav_path)

        if len(wav_data) > 100:
            return base64.b64encode(wav_data).decode("utf-8")

        print("[TTS-Windows] 生成的 WAV 太小，TTS 可能失败")
        return None

    except FileNotFoundError:
        print("[TTS-Windows] PowerShell 不可用（非 Windows 系统？）")
        return None
    except Exception as e:
        print(f"[TTS-Windows] 异常: {e}")
        return None


def text_to_speech(text: str, rate: str = "") -> str | None:
    """
    TTS 主入口，按优先级依次尝试：
      1. Edge TTS —— 免费无限量、跨平台、日语原生声音（首选，含缓存）
      2. ElevenLabs —— 音质最好但有免费额度上限
      3. Windows 内置语音 —— 仅本机开发时的最后兜底
    全部失败返回 None（前端会退化成浏览器自带朗读）。

    rate: 语速，如 "-30%"、"+10%"、""（默认正常速度）
    """
    # 1. Edge TTS（首选：免费且服务器上也能用）
    result = text_to_speech_edge(text, rate)
    if result:
        return result
    print("[TTS] Edge TTS 失败，尝试 ElevenLabs...")

    # 2. ElevenLabs（有 Key 才尝试）
    if ELEVENLABS_API_KEY:
        result = text_to_speech_elevenlabs(text, rate)
        if result:
            return result
        print("[TTS] ElevenLabs 失败，尝试 Windows 内置语音...")

    # 3. Windows 内置 TTS（只在本机 Windows 上有效）
    if platform.system() == "Windows":
        return text_to_speech_windows(text)

    # 4. 都没辙，交给前端浏览器朗读
    print("[TTS] 无可用的服务端语音引擎，前端将使用浏览器朗读")
    return None
