// ==================== 日语聊天 v1.6 — App ====================
// 跟小樱聊天。AI 日语会话练习 PWA

// 视口铺满由 CSS 负责（body 用 position:fixed + inset:0 钉满全屏）
// 不再用 JS 读 innerHeight：PWA 启动瞬间该值不稳，且无 resize 触发会导致底部露黑边

// ==================== 配置 ====================
const isApp = location.protocol === 'file:' || location.protocol === 'capacitor:';
// 跨域部署：前端 GitHub Pages + 后端 SCF
const SERVER_URL = localStorage.getItem('nihongo_server') || (isApp ? 'http://10.240.124.21:8765' : 'https://1460182223-jzjbeeenh6.ap-shanghai.tencentscf.com');
const API = SERVER_URL + '/api/chat';

// ---------- 跨域认证（用请求头代替 cookie）----------
let _accessCode = localStorage.getItem('nihongo_code') || '';
let _sessionId = localStorage.getItem('nihongo_sid') || '';
if (!_sessionId) {
  _sessionId = crypto.randomUUID().replace(/-/g, '');
  localStorage.setItem('nihongo_sid', _sessionId);
}

/** 构建认证请求头 */
function authHeaders(extra = {}) {
  const h = { ...extra };
  if (_accessCode) h['X-Access-Code'] = _accessCode;
  if (_sessionId) h['X-Session-Id'] = _sessionId;
  return h;
}

// ==================== 全局网络错误检测 ====================
let _lastNetErrorTime = 0;

/** 包装 fetch：自动带认证头 + 网络断开时给用户一个明确提示 */
async function safeFetch(url, opts = {}) {
  opts.headers = authHeaders(opts.headers);
  try {
    return await fetch(url, opts);
  } catch (err) {
    const nowTs = Date.now();
    if (nowTs - _lastNetErrorTime > 3000) {
      _lastNetErrorTime = nowTs;
      showNotice('⚠️ 无法连接到服务器', 3000);
    }
    throw err;
  }
}

// ==================== 全局状态 ====================
let currentScenario = 'free';
let currentMode = 'chat';      // chat|correct|translate|word
let currentLevel = localStorage.getItem('nihongo_level') || 'N4';  // N5|N4|N3|N2|N1
let currentRate = localStorage.getItem('nihongo_rate') || '';  // 语速
let currentTone = localStorage.getItem('nihongo_tone') || 'polite';  // polite|casual|kansai
let listeningMode = false;    // 听力模式：只显示文字不自动读
let handsFreeMode = false;    // 免提对话：自动 听→说→听 循环
let scenarioList = [];
let isSending = false;
let _suppressRecognition = false;  // 发送后抑制语音识别残余事件
let isMuted = localStorage.getItem('nihongo_muted') === '1';  // 静音状态
let recognitionLang = 'ja-JP';    // 语音识别语言: ja-JP | zh-CN

// ==================== 访问认证 ====================
async function checkAuth() {
  try {
    const r = await safeFetch(SERVER_URL + '/api/auth-check');
    if (r.ok) {
      document.getElementById('auth-overlay').classList.add('hidden');
      onUnlocked();
      return;
    }
  } catch (e) { /* 网络错误也显示锁屏 */ }
  document.getElementById('auth-overlay').classList.remove('hidden');
}

function onUnlocked() {
  loadScenarios();
  loadRescuePhrases();
  initLocalVocab();
  loadHistory();  // 恢复对话历史
}

async function tryUnlock() {
  const input = document.getElementById('auth-input');
  const errEl = document.getElementById('auth-error');
  const code = input.value.trim();
  if (!code) return;
  errEl.textContent = '';
  try {
    // 先验证口令是否正确
    const r = await fetch(SERVER_URL + '/api/auth-check', {
      headers: { 'X-Access-Code': code },
    });
    if (r.ok) {
      // 口令正确，存到本地，后续所有请求自动带上
      _accessCode = code;
      localStorage.setItem('nihongo_code', code);
      document.getElementById('auth-overlay').classList.add('hidden');
      onUnlocked();
    } else {
      errEl.textContent = '口令不对';
      input.value = '';
      input.focus();
    }
  } catch (e) {
    errEl.textContent = '网络错误';
  }
}

// form 提交 = 点 OK 按钮 或 键盘按回车/go，统一走这里。
// iOS 软键盘在输入法激活时不触发 keydown 的 Enter，但一定会触发表单 submit，
// 所以用 submit 事件是最可靠的写法。
document.getElementById('auth-form').addEventListener('submit', (e) => {
  e.preventDefault();   // 阻止表单默认跳转行为
  tryUnlock();
});

// 服务器地址设置
const serverInput = document.getElementById('server-input');
serverInput.value = localStorage.getItem('nihongo_server') || '';
document.getElementById('server-toggle').addEventListener('click', () => {
  const cfg = document.getElementById('server-config');
  cfg.style.display = cfg.style.display === 'none' ? 'block' : 'none';
});
document.getElementById('server-save').addEventListener('click', () => {
  const url = serverInput.value.trim();
  if (url) {
    localStorage.setItem('nihongo_server', url);
    document.getElementById('server-msg').textContent = '✅ 已保存';
  } else {
    localStorage.removeItem('nihongo_server');
    document.getElementById('server-msg').textContent = '🗑 已清空';
  }
  setTimeout(() => { document.getElementById('server-msg').textContent = ''; }, 2000);
});

// ==================== DOM ====================
const chatEl = document.getElementById('chat');
const inputEl = document.getElementById('input-box');
const sendBtn = document.getElementById('send-btn');
const micBtn = document.getElementById('mic-btn');
const statusEl = document.getElementById('status');
const noticeEl = document.getElementById('notice');

// ==================== 工具函数 ====================
function scrollBottom() {
  chatEl.scrollTop = chatEl.scrollHeight;
}

let _noticeTimer = null;

function showNotice(text, duration = 2000) {
  // 清除上一个还在显示的提示
  if (_noticeTimer) {
    clearTimeout(_noticeTimer);
    noticeEl.classList.remove('show');
  }
  noticeEl.textContent = text;
  noticeEl.classList.add('show');
  _noticeTimer = setTimeout(() => {
    noticeEl.classList.remove('show');
    _noticeTimer = null;
  }, duration);
}

function now() {
  const d = new Date();
  return `${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ==================== 可点击句子 ====================
function _renderSentences(text) {
  // 按日文句号/问号/感叹号拆分，保留分隔符
  const parts = text.split(/(?<=[。！？!?\n])/g);
  return parts.map(p => {
    const trimmed = p.trim();
    if (!trimmed) return '';
    return `<span class="sentence-click" data-sentence="${escapeHtml(trimmed)}">${escapeHtml(trimmed)}</span>`;
  }).join('');
}

// ==================== 消息渲染 ====================
const audioCache = new Map();
const textCache = new Map();
const MAX_AUDIO_CACHE = 50;   // 音频缓存上限（占用内存大）
const MAX_TEXT_CACHE  = 200;  // 文本缓存上限

/** 向 Map 写入并控制容量：超过上限则删最旧的条目 */
function _cacheSet(map, key, value, maxSize) {
  map.set(key, value);
  if (map.size > maxSize) {
    const oldest = map.keys().next().value;
    map.delete(oldest);
  }
}

let audioSeq = 0;

function addMsg(role, text, opts = {}) {
  const { withAudio = false, audioB64 = null, newWords = null, fixItems = null, sceneDone = false } = opts;
  const div = document.createElement('div');
  div.className = `msg ${role}`;

  // 模式卡片：翻译/查词/纠错模式下给 AI 消息加额外 CSS 类
  if (role === 'ai' && ['translate','word','correct'].includes(currentMode)) {
    div.classList.add(`mode-${currentMode}`);
  }

  // 正文：AI 消息拆成可点击句子
  let bodyHtml;
  if (role === 'ai') {
    bodyHtml = _renderSentences(text);
  } else {
    bodyHtml = escapeHtml(text).replace(/\n/g, '<br>');
  }
  let html = `<div class="msg-body">${bodyHtml}</div>`;

  // 纠错卡片
  if (fixItems && fixItems.length) {
    const fixLines = fixItems.map(f => {
      const noteHtml = f.note ? `<div class="fix-note">${escapeHtml(f.note)}</div>` : '';
      return `<div class="fix-line">
        <span class="fix-wrong">❌${escapeHtml(f.wrong)}</span>
        <span class="fix-arrow">→</span>
        <span class="fix-correct">✅${escapeHtml(f.correct)}</span>
        ${noteHtml}
      </div>`;
    }).join('');
    html += `<div class="fix-card">
      <div class="fix-title">📝 修正要点</div>
      ${fixLines}
    </div>`;
  }

  // 场景达成
  if (sceneDone) {
    html += '<span class="scene-done-badge">🎉 任务完成！</span>';
  }

  // 重听按钮
  if (role === 'ai' && withAudio) {
    const id = `audio-${audioSeq++}`;
    if (audioB64) {
      _cacheSet(audioCache, id, audioB64, MAX_AUDIO_CACHE);
    } else {
      _cacheSet(textCache, id, text, MAX_TEXT_CACHE);
    }
    html += `<br><span class="play-btn" data-audio-id="${id}">🔊 再听一遍</span>`;
    html += `<span class="furi-btn" data-furi-text="${escapeHtml(text)}">注假名</span>`;
    html += `<span class="shadow-btn" data-shadow-text="${escapeHtml(text)}">🗣️ 跟读</span>`;
  }

  // 译文折叠按钮（AI 消息都有）
  if (role === 'ai') {
    html += `<span class="trans-btn" data-trans-text="${escapeHtml(text)}">中 訳文</span>`;
    html += `<div class="trans-fold hidden"></div>`;
  }

  // 生词 chips
  if (newWords && newWords.length) {
    const chips = newWords.map(w => {
      const kana = w.kana ? `<span class="kana">（${escapeHtml(w.kana)}）</span>` : '';
      const mean = w.meaning ? ` ${escapeHtml(w.meaning)}` : '';
      return `<span class="word-chip"><b>${escapeHtml(w.word)}</b>${kana}${mean}</span>`;
    }).join('');
    html += `<div class="word-chips">${chips}</div>`;
  }

  const label = role === 'me' ? now() : '小樱';
  html += `<div class="time">${escapeHtml(label)}</div>`;
  // 纠错提示
  if (fixItems && fixItems.length > 0) {
    showCorrectionBar(fixItems);
  }

  div.innerHTML = html;

  chatEl.appendChild(div);
  scrollBottom();
  return div;
}

function showTyping() {
  const div = document.createElement('div');
  div.className = 'typing';
  div.id = 'typing-indicator';
  div.innerHTML = '<span></span><span></span><span></span>';
  chatEl.appendChild(div);
  scrollBottom();
}

function hideTyping() {
  const el = document.getElementById('typing-indicator');
  if (el) el.remove();
}

// ==================== 播放语音 ====================
let audioCtx = null;
let masterGain = null;  // 主音量控制节点

function _ensureAudioCtx() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    masterGain = audioCtx.createGain();
    masterGain.gain.value = isMuted ? 0 : 1;
    masterGain.connect(audioCtx.destination);
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
}

function setMuted(muted) {
  isMuted = muted;
  localStorage.setItem('nihongo_muted', muted ? '1' : '0');
  if (masterGain) masterGain.gain.value = muted ? 0 : 1;
  updateMuteBtn();
}

function updateMuteBtn() {
  const ico = document.getElementById('mute-btn')?.querySelector('.ico');
  if (ico) ico.textContent = isMuted ? '🔇' : '🔊';
}

function playAudio(base64) {
  return new Promise((resolve) => {
    if (!base64) { resolve(); return; }
    try {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

      _ensureAudioCtx();

      audioCtx.decodeAudioData(bytes.buffer, (buffer) => {
        const source = audioCtx.createBufferSource();
        source.buffer = buffer;
        source.connect(masterGain);  // 通过 GainNode 控制音量
        source.onended = () => resolve();
        source.start(0);
      }, () => resolve());  // 解码失败也 resolve，不阻塞流程
    } catch (e) {
      console.error('Audio play error:', e);
      resolve();
    }
  });
}

function speakByBrowser(text) {
  return new Promise((resolve) => {
    if (!('speechSynthesis' in window)) {
      showNotice('当前设备不支持语音朗读');
      resolve(false); return;
    }
    const voices = window.speechSynthesis.getVoices();
    const ja = voices.find(v => v.lang && v.lang.toLowerCase().startsWith('ja'));
    if (!ja) {
      showNotice('当前设备没有日语语音包');
      resolve(false); return;
    }
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'ja-JP';
    u.rate = 0.9;
    u.volume = isMuted ? 0 : 1;  // 静音控制
    u.voice = ja;
    u.onend = () => resolve(true);
    u.onerror = () => resolve(false);
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  });
}

async function playReply(audioB64, text) {
  if (audioB64) {
    await playAudio(audioB64);
  } else if (text) {
    await speakByBrowser(text);
  }
}

chatEl.addEventListener('click', (e) => {
  if (e.target.classList.contains('play-btn')) {
    const id = e.target.dataset.audioId;
    const cached = audioCache.get(id);
    if (cached) {
      playAudio(cached);
    } else if (textCache.has(id)) {
      speakByBrowser(textCache.get(id));
    } else {
      showNotice('没找到语音');
    }
  }

  if (e.target.classList.contains('furi-btn')) {
    toggleFurigana(e.target);
  }

  // 点击句子 → 单独朗读
  if (e.target.classList.contains('sentence-click')) {
    const s = e.target.dataset.sentence;
    if (s) speakSentence(s);
  }

  // 译文折叠
  if (e.target.classList.contains('trans-btn')) {
    toggleTranslation(e.target);
  }

  // 跟读发音打分
  if (e.target.classList.contains('shadow-btn')) {
    const s = e.target.dataset.shadowText;
    if (s) startShadowing(s);
  }
});

// ==================== 振假名（注假名）====================
const furiCache = new Map();   // 原文 -> ruby HTML，避免重复请求
const MAX_FURI_CACHE = 100;

async function fetchFurigana(text) {
  if (furiCache.has(text)) return furiCache.get(text);
  const resp = await safeFetch(SERVER_URL + '/api/furigana', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, format: 'html' }),
  });
  if (!resp.ok) throw new Error('furigana failed');
  const html = (await resp.json()).html;
  _cacheSet(furiCache, text, html, MAX_FURI_CACHE);
  return html;
}

async function toggleFurigana(btn) {
  const msg = btn.closest('.msg');
  const body = msg && msg.querySelector('.msg-body');
  if (!body) return;

  // 已经开着就关掉，恢复原文
  if (msg.dataset.furiOn === '1') {
    body.innerHTML = msg.dataset.plainHtml || body.innerHTML;
    msg.dataset.furiOn = '0';
    btn.classList.remove('active');
    return;
  }

  const text = btn.dataset.furiText;
  if (!text) return;

  btn.textContent = '注 ...';
  try {
    const rubyHtml = await fetchFurigana(text);
    if (!msg.dataset.plainHtml) msg.dataset.plainHtml = body.innerHTML;
    body.innerHTML = rubyHtml.replace(/\n/g, '<br>');
    msg.dataset.furiOn = '1';
    btn.classList.add('active');
  } catch (err) {
    console.error(err);
    showNotice('注假名获取失败');
  } finally {
    btn.textContent = '注假名';
  }
}

// ==================== 句子点读 ====================
const sentenceAudioCache = new Map();
const MAX_SENTENCE_AUDIO_CACHE = 30;  // 音频数据更大，限制更严格

async function speakSentence(text) {
  // 先用缓存
  if (sentenceAudioCache.has(text)) {
    await playAudio(sentenceAudioCache.get(text));
    return;
  }
  statusEl.textContent = '🔊 朗读中…';
  try {
    const resp = await safeFetch(SERVER_URL + '/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, rate: currentRate }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    if (data.audio_b64) {
      _cacheSet(sentenceAudioCache, text, data.audio_b64, MAX_SENTENCE_AUDIO_CACHE);
      await playAudio(data.audio_b64);
    } else {
      await speakByBrowser(text);
    }
  } catch (err) {
    console.error('Sentence TTS error:', err);
    await speakByBrowser(text);
  }
  statusEl.textContent = '';
}

// ==================== 译文折叠 ====================
const transCache = new Map();
const MAX_TRANS_CACHE = 100;

async function toggleTranslation(btn) {
  const msg = btn.closest('.msg');
  const fold = msg && msg.querySelector('.trans-fold');
  if (!fold) return;

  // 已展开 → 收起
  if (!fold.classList.contains('hidden')) {
    fold.classList.add('hidden');
    btn.classList.remove('active');
    return;
  }

  const text = btn.dataset.transText;
  if (!text) return;

  // 有缓存直接用
  if (transCache.has(text)) {
    fold.innerHTML = transCache.get(text);
    fold.classList.remove('hidden');
    btn.classList.add('active');
    return;
  }

  btn.textContent = '中 …';
  try {
    const resp = await safeFetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        mode: 'translate',
        level: currentLevel,
      }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const transHtml = `<div class="trans-text">${escapeHtml(data.reply).replace(/\n/g, '<br>')}</div>`;
    _cacheSet(transCache, text, transHtml, MAX_TRANS_CACHE);
    fold.innerHTML = transHtml;
    fold.classList.remove('hidden');
    btn.classList.add('active');
  } catch (err) {
    console.error('Translation error:', err);
    showNotice('翻译失败', 2000);
  } finally {
    btn.textContent = '中 訳文';
  }
}
let recognition = null;
let isListening = false;

function initSpeech() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    micBtn.style.display = 'none';
    showNotice('当前浏览器不支持语音输入');
    return;
  }

  recognition = new SpeechRecognition();
  recognition.lang = recognitionLang;
  recognition.interimResults = true;
  recognition.continuous = false;
  recognition.maxAlternatives = 1;

  recognition.onresult = (event) => {
    // 发送后抑制残余事件，避免已清空的输入框被重新填入文字
    if (_suppressRecognition) return;
    let transcript = '';
    for (let i = 0; i < event.results.length; i++) {
      transcript += event.results[i][0].transcript;
    }
    inputEl.value = transcript;
    if (event.results[0].isFinal && transcript.trim()) {
      setTimeout(() => sendMessage(), 300);
    }
  };

  recognition.onerror = (event) => {
    console.error('Speech error:', event.error);
    stopListening();
    if (event.error === 'not-allowed') {
      showNotice('需要允许使用麦克风');
      stopHandsFree();  // 权限被拒 → 退出免提
    } else if (event.error === 'no-speech') {
      if (handsFreeMode) {
        // 免提模式下没检测到语音 → 短暂等待后重新听
        statusEl.textContent = '🎧 …';
        setTimeout(() => { if (handsFreeMode) startListening(); }, 1500);
      } else {
        showNotice('没有检测到语音');
      }
    }
  };

  recognition.onend = () => {
    stopListening();
    // 免提模式：如果还在等待（非发送中），自动重新听
    if (handsFreeMode && !isSending) {
      setTimeout(() => { if (handsFreeMode && !isSending) startListening(); }, 800);
    }
  };

  // 跟读发音打分用的语音识别也一起初始化
  initScoreSpeech();
}

function startListening() {
  if (!recognition) return;
  try {
    _suppressRecognition = false;  // 重置抑制标志
    recognition.lang = recognitionLang;  // 同步当前语言
    isListening = true;
    micBtn.classList.add('listening');
    statusEl.textContent = recognitionLang === 'zh-CN' ? '🎤 听中文中…' : '🎤 听日语中…';
    recognition.start();
  } catch (e) {
    stopListening();
  }
}

function stopListening() {
  isListening = false;
  micBtn.classList.remove('listening');
  statusEl.textContent = '';
  // 强制中断并抑制残余事件
  _suppressRecognition = true;
  if (recognition) {
    try { recognition.abort(); } catch (_) {}
  }
}

micBtn.addEventListener('click', () => {
  if (!recognition) {
    showNotice('不支持语音输入，请用键盘输入');
    return;
  }
  if (isListening) {
    recognition.stop();
    stopListening();
  } else {
    startListening();
  }
});

// ==================== 免提对话模式 🎧 ====================
const handsFreeBtn = document.getElementById('handsfree-btn');

function startHandsFree() {
  if (!recognition) {
    showNotice('不支持语音输入');
    return;
  }
  handsFreeMode = true;
  handsFreeBtn.classList.add('active');
  showNotice('🎧 免提模式已开 — 直接说话吧', 2500);
  // 立即开始听
  setTimeout(() => startListening(), 300);
}

function stopHandsFree() {
  handsFreeMode = false;
  handsFreeBtn.classList.remove('active');
  statusEl.textContent = '';
}

handsFreeBtn.addEventListener('click', () => {
  if (handsFreeMode) {
    stopHandsFree();
    if (isListening) { recognition.stop(); stopListening(); }
    showNotice('🎧 免提模式已关', 1500);
  } else {
    startHandsFree();
  }
});

// ==================== 静音控制 🔊 ====================
const muteBtn = document.getElementById('mute-btn');
updateMuteBtn();  // 初始化按钮状态

muteBtn.addEventListener('click', () => {
  setMuted(!isMuted);
  showNotice(isMuted ? '🔇 静音 ON' : '🔊 静音 OFF', 1500);
});

// ==================== 语音识别语言切换 🌐 ====================
const langToggleBtn = document.getElementById('lang-toggle-btn');
const langToggleIco = langToggleBtn.querySelector('.ico');
recognitionLang = localStorage.getItem('nihongo_recog_lang') || 'ja-JP';
langToggleIco.textContent = recognitionLang === 'zh-CN' ? '🇨🇳' : '🇯🇵';

langToggleBtn.addEventListener('click', () => {
  recognitionLang = recognitionLang === 'ja-JP' ? 'zh-CN' : 'ja-JP';
  localStorage.setItem('nihongo_recog_lang', recognitionLang);
  langToggleIco.textContent = recognitionLang === 'zh-CN' ? '🇨🇳' : '🇯🇵';
  showNotice(recognitionLang === 'zh-CN'
    ? '🇨🇳 中文语音识别 — 说中文问日语'
    : '🇯🇵 日本語音声認識', 2000);
});

// ==================== 模式切换 ====================
const MODES = [
  { id: 'chat',      emoji: '💬', name: '会話' },
  { id: 'correct',   emoji: '📝', name: '添削' },
  { id: 'translate', emoji: '🔄', name: '翻訳' },
  { id: 'word',      emoji: '📖', name: '辞書' },
];

function switchMode(modeId) {
  currentMode = modeId;
  document.querySelectorAll('.mode-chip').forEach(c => {
    c.classList.toggle('active', c.dataset.mode === modeId);
  });
  // 更新 placeholder
  const placeholders = {
    chat: '用日语或中文跟我说话…',
    correct: '输入日语，我帮你批改…',
    translate: '输入要翻译的句子（中日互译）…',
    word: '输入要查的单词…',
  };
  inputEl.placeholder = placeholders[modeId] || '用日语或中文跟我说话…';
}

document.getElementById('mode-bar').addEventListener('click', (e) => {
  const chip = e.target.closest('.mode-chip');
  // 工具按钮没有 data-mode，不参与模式切换，否则点工具会把所有工具按钮一起点亮
  if (chip && chip.dataset.mode) switchMode(chip.dataset.mode);
});

// 难度选择
document.getElementById('level-select').addEventListener('change', (e) => {
  currentLevel = e.target.value;
  localStorage.setItem('nihongo_level', currentLevel);
});
document.getElementById('level-select').value = currentLevel;  // 恢复上次选择

// 语速选择
const speedSelect = document.getElementById('speed-select');
speedSelect.value = currentRate;
speedSelect.addEventListener('change', (e) => {
  currentRate = e.target.value;
  localStorage.setItem('nihongo_rate', currentRate);
});

// ==================== 场景模式 ====================
const sceneSheet = document.getElementById('scene-sheet');
const sceneGrid  = document.getElementById('scene-grid');
const sceneLabel = document.getElementById('scene-label');

async function loadScenarios() {
  try {
    const resp = await safeFetch(SERVER_URL + '/api/scenarios');
    if (!resp.ok) return;
    const data = await resp.json();
    scenarioList = data.scenarios || [];
    renderScenarios();
  } catch (_) {}
}

function renderScenarios() {
  // 按分类分组渲染
  const cats = new Map();
  for (const s of scenarioList) {
    const cat = s.category || 'other';
    if (!cats.has(cat)) cats.set(cat, []);
    cats.get(cat).push(s);
  }
  const catNames = {
    social: '🤝 社交', shop: '🛒 购物', travel: '🧳 旅行',
    work: '💼 工作', study: '🎓 学习', emergency: '🚨 紧急', other: '💬 其他',
  };

  let html = '';
  for (const [cat, items] of cats) {
    html += `<div class="scene-cat">${catNames[cat] || cat}</div>`;
    for (const s of items) {
      html += `<button class="scene-item ${s.id === currentScenario ? 'active' : ''}" data-sid="${s.id}">
        <span class="ico">${s.emoji}</span>
        <div class="nm">${escapeHtml(s.name)}</div>
        <div class="jp">${escapeHtml(s.jp_name)}</div>
      </button>`;
    }
  }
  sceneGrid.innerHTML = html;
}

async function switchScenario(sid) {
  if (isSending) { showNotice('稍等一下…'); return; }
  closeSheet('scene-sheet');
  try {
    const resp = await safeFetch(SERVER_URL + `/api/scenario/${encodeURIComponent(sid)}`, { method: 'POST' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const sc = await resp.json();

    currentScenario = sc.id;
    sceneLabel.textContent = sc.name;
    document.getElementById('scene-btn').firstChild.textContent = sc.emoji + ' ';

    // 不清空聊天窗口，历史对话一直保留，只在末尾接上新场景的开场白
    addMsg('ai', sc.opening, { withAudio: true });
    _saveHistoryLocally('ai', sc.opening);
    showNotice(`${sc.emoji} ${sc.name}模式`, 2000);
  } catch (err) {
    showNotice('出错了: ' + err.message, 3000);
  }
}

sceneGrid.addEventListener('click', (e) => {
  const btn = e.target.closest('.scene-item');
  if (btn) switchScenario(btn.dataset.sid);
});

document.getElementById('scene-btn').addEventListener('click', () => {
  renderScenarios();
  openSheet('scene-sheet');
});

// ==================== 救急短语 ====================
async function loadRescuePhrases() {
  try {
    const resp = await safeFetch(SERVER_URL + '/api/assist/rescue');
    if (!resp.ok) return;
    const data = await resp.json();
    renderRescue(data.phrases);
  } catch (_) {}
}

function renderRescue(phrases) {
  const grid = document.getElementById('rescue-grid');
  if (!grid || !phrases) return;
  let html = '';
  for (const [cat, items] of Object.entries(phrases)) {
    html += `<div class="rescue-cat">${escapeHtml(cat)}</div>`;
    for (const item of items) {
      html += `<div class="rescue-item" data-text="${escapeHtml(item.jp)}">
        <div class="jp">${escapeHtml(item.jp)}</div>
        <div class="cn">${escapeHtml(item.cn)}</div>
      </div>`;
    }
  }
  grid.innerHTML = html;
}

document.getElementById('rescue-grid')?.addEventListener('click', (e) => {
  const item = e.target.closest('.rescue-item');
  if (item) {
    const text = item.dataset.text;
    if (text) {
      // 填入输入框并自动发送
      inputEl.value = text;
      sendMessage();
      closeSheet('rescue-sheet');
    }
  }
});

document.getElementById('rescue-btn')?.addEventListener('click', () => {
  openSheet('rescue-sheet');
});

// ==================== 今日生词本 ====================
const VOCAB_KEY = 'nihongo_vocab';
let vocabCount = 0;
let vocabDay   = null;

const vocabListEl = document.getElementById('vocab-list');
const vocabDaysEl = document.getElementById('vocab-days');
const vocabBadge  = document.getElementById('vocab-badge');

function _readVocab() {
  try { return JSON.parse(localStorage.getItem(VOCAB_KEY) || '{}'); } catch (_) { return {}; }
}

function _writeVocab(data) {
  localStorage.setItem(VOCAB_KEY, JSON.stringify(data));
}

function getToday() {
  return new Date().toISOString().slice(0, 10);
}

function saveVocab(words) {
  if (!words || !words.length) return;
  const all  = _readVocab();
  const today = getToday();
  if (!all[today]) all[today] = [];
  const existing = new Set(all[today].map(w => w.word));
  for (const w of words) {
    if (!existing.has(w.word)) {
      all[today].push({ word: w.word, kana: w.kana || '', meaning: w.meaning || '' });
      existing.add(w.word);
    }
  }
  _writeVocab(all);
}

function initLocalVocab() {
  const all   = _readVocab();
  const today = getToday();
  vocabCount  = (all[today] || []).length;
  renderBadge();
  renderVocab(all[today] || [], all);
}

function renderBadge() {
  vocabBadge.textContent = vocabCount;
  vocabBadge.classList.toggle('show', vocabCount > 0);
}

function loadVocab(day = null) {
  vocabDay = day;
  const all = _readVocab();
  const words = day ? (all[day] || []) : (all[getToday()] || []);
  renderVocab(words, all);
  if (!day) { vocabCount = words.length; renderBadge(); }
}

function renderVocab(words, allDays) {
  const dayKeys = Object.keys(allDays).filter(d => allDays[d].length > 0).sort().reverse();
  vocabDaysEl.innerHTML = dayKeys.length > 1
    ? dayKeys.map(d => {
        const active = (vocabDay === d) || (!vocabDay && d === dayKeys[0]);
        return `<button data-day="${d}" class="${active ? 'active' : ''}">${d.slice(5)}（${allDays[d].length}）</button>`;
      }).join('')
    : '';

  vocabListEl.innerHTML = words.length
    ? words.map(w => `
        <div class="vocab-row">
          <span class="w">${escapeHtml(w.word)}</span>
          <span class="k">${escapeHtml(w.kana || '')}</span>
          <span class="m">${escapeHtml(w.meaning || '')}</span>
        </div>`).join('')
    : '<div class="vocab-empty">还没有生词。<br>跟小樱聊天会自动收集🌸</div>';
}

vocabDaysEl.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-day]');
  if (btn) loadVocab(btn.dataset.day);
});

document.getElementById('vocab-btn').addEventListener('click', () => {
  loadVocab(null);
  openSheet('vocab-sheet');
});

document.getElementById('vocab-export').addEventListener('click', () => {
  const all    = _readVocab();
  const day    = vocabDay || getToday();
  const words  = all[day] || [];
  if (!words.length) { showNotice('这一天没有生词', 2000); return; }

  let csv = '\ufeff正面,背面\n';
  for (const w of words) {
    const front   = w.kana ? `${w.word}（${w.kana}）` : w.word;
    const back    = w.meaning || '';
    const esc = (s) => '"' + s.replace(/"/g, '""') + '"';
    csv += esc(front) + ',' + esc(back) + '\n';
  }

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `nihongo_vocab_${day}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  showNotice('📥 已下载', 2000);
});

document.getElementById('vocab-clear').addEventListener('click', () => {
  const day = vocabDay || getToday();
  if (!confirm(`${day}  的生词全部删除吗？`)) return;
  const all = _readVocab();
  delete all[day];
  _writeVocab(all);
  loadVocab(day);
  if (!vocabDay || vocabDay === getToday()) { vocabCount = 0; renderBadge(); }
  showNotice('已清空', 1500);
});

// ==================== 对话历史持久化 ====================
const LOCAL_HISTORY_KEY = 'nihongo_history';
const MAX_LOCAL_HISTORY = 100;  // 本地最多保存100条消息

/** 保存一条消息到 localStorage（客户端兜底，SCF 文件系统不可靠） */
function _saveHistoryLocally(role, text) {
  try {
    const arr = JSON.parse(localStorage.getItem(LOCAL_HISTORY_KEY) || '[]');
    arr.push({ role: role === 'me' ? 'user' : 'assistant', content: text });
    // 超出上限只保留最近的
    while (arr.length > MAX_LOCAL_HISTORY) arr.shift();
    localStorage.setItem(LOCAL_HISTORY_KEY, JSON.stringify(arr));
  } catch (_) {}
}

/** 从后端拉取历史，失败则用 localStorage 兜底，渲染到聊天窗口 */
async function loadHistory() {
  let msgs = [];
  // 1. 尝试从服务器拉取
  try {
    const resp = await safeFetch(SERVER_URL + '/api/history');
    if (resp.ok) {
      const data = await resp.json();
      msgs = data.messages || [];
    }
  } catch (_) {}

  // 2. 服务器没有（冷启动/SCF重启）→ 用本地缓存兜底
  if (!msgs.length) {
    try {
      msgs = JSON.parse(localStorage.getItem(LOCAL_HISTORY_KEY) || '[]');
    } catch (_) { msgs = []; }
  }

  if (!msgs.length) return;

  // 清空默认欢迎消息，渲染历史
  chatEl.innerHTML = '';
  for (const m of msgs) {
    const role = m.role === 'user' ? 'me' : 'ai';
    addMsg(role, m.content, { withAudio: role === 'ai' });
  }
}

/** 清空本地历史缓存（手动清空按钮调用） */
function clearLocalHistory() {
  localStorage.removeItem(LOCAL_HISTORY_KEY);
}

// 手动清空对话历史（唯一清理入口，切换场景不再清空）
document.getElementById('clear-history-btn')?.addEventListener('click', async () => {
  if (!confirm('要清空全部对话历史吗？')) return;
  clearLocalHistory();
  try { await safeFetch(SERVER_URL + '/api/reset', { method: 'POST' }); } catch (_) {}
  chatEl.innerHTML = '';
  audioCache.clear();
  textCache.clear();
  showNotice('对话历史已清空', 1500);
});

// ==================== 弹层开关 ====================
function openSheet(id)  { document.getElementById(id).classList.remove('hidden'); }
function closeSheet(id) { document.getElementById(id).classList.add('hidden'); }

document.querySelectorAll('.sheet').forEach(sheet => {
  sheet.addEventListener('click', (e) => {
    if (e.target.dataset.close || e.target === sheet) sheet.classList.add('hidden');
  });
});

// ==================== 发送消息 ====================
async function sendToAI(text) {
  if (isSending) return;
  isSending = true;
  sendBtn.disabled = true;

  statusEl.textContent = '小樱正在思考…';
  addMsg('me', text);
  _saveHistoryLocally('me', text);  // 保存用户消息到本地
  showTyping();

  try {
    const resp = await safeFetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        scenario: currentScenario,
        mode: currentMode,
        level: currentLevel,
        rate: currentRate,
        tone: currentTone,
      }),
    });

    if (!resp.ok) {
      let msg = `HTTP ${resp.status}`;
      try {
        const errData = await resp.json();
        if (errData.detail) msg = errData.detail;
      } catch (_) {}
      throw new Error(msg);
    }

    const data = await resp.json();
    hideTyping();

    addMsg('ai', data.reply, {
      withAudio: true,
      audioB64: data.audio_b64,
      newWords: data.new_words,
      fixItems: data.fix_items || [],
      sceneDone: data.scene_done || false,
    });
    _saveHistoryLocally('ai', data.reply);  // 保存 AI 回复到本地

    if (data.new_words && data.new_words.length) {
      saveVocab(data.new_words);
      vocabCount += data.new_words.length;
      renderBadge();
    }

    if (!listeningMode) {
      statusEl.textContent = '🔊 朗读中…';
      await playReply(data.audio_b64, data.reply);
    }
    statusEl.textContent = '';
    // 免提模式：朗读结束后自动开始听（此时仍在 try 块内，isSending 尚为 true，
    // finally 会先把它置回 false，600ms 后定时器触发时已是空闲状态）
    if (handsFreeMode) {
      setTimeout(() => { if (handsFreeMode && !isSending) startListening(); }, 600);
    }
  } catch (err) {
    hideTyping();
    statusEl.textContent = '';
    showNotice('出错了: ' + err.message, 3000);
    console.error(err);
  } finally {
    isSending = false;
    sendBtn.disabled = false;
  }
}

async function sendMessage() {
  const text = inputEl.value.trim();
  if (!text) return;
  if (isSending) {
    showNotice('稍等一下…');
    return;
  }

  inputEl.value = '';
  inputEl.style.height = 'auto';
  stopListening();

  await sendToAI(text);
}

// ==================== 事件绑定 ====================
sendBtn.addEventListener('click', sendMessage);

inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

inputEl.addEventListener('input', () => {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 100) + 'px';
});

// ==================== 纠错条 ====================
function showCorrectionBar(items) {
  const bar = document.getElementById('correction-bar');
  const content = document.getElementById('correction-content');
  if (!bar || !content) return;
  content.innerHTML = items.map((it) => {
    const wrong = escapeHtml(it.wrong || '');
    const fix   = escapeHtml(it.correct || '');
    const tip   = escapeHtml(it.note   || '');
    const cls   = ['grammar','word','collocation','particle'].includes(it.type) ? it.type : '';
    return `<span class="corr-item ${cls}"><b>❌${wrong}</b> → <b>✅${fix}</b>${tip ? ' ' + tip : ''}</span>`;
  }).join(' ');
  bar.classList.remove('hidden');
  clearTimeout(bar._timeout);
  bar._timeout = setTimeout(() => bar.classList.add('hidden'), 8000);
}

document.getElementById('correction-close')?.addEventListener('click', () => {
  document.getElementById('correction-bar').classList.add('hidden');
});

// ==================== 翻訳練習 Quiz ====================
let quizQuestions = [];
let quizIndex = 0;
let quizScore = 0;
let quizTotal = 10;          // 每轮 10 题
let quizDirection = 'jp2cn'; // jp2cn | cn2jp
let quizChecked = false;     // 当前题是否已判

const QUIZ_TOTAL = 10;

async function loadQuiz(level) {
  try {
    const diffParam = level ? `&difficulty=${level}` : '';
    const resp = await safeFetch(`${SERVER_URL}/api/assist/quiz?count=20${diffParam}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    // 随机抽 QUIZ_TOTAL 题
    const pool = data.questions || [];
    shuffleArray(pool);
    quizQuestions = pool.slice(0, QUIZ_TOTAL);
    quizIndex = 0;
    quizScore = 0;
    quizChecked = false;
    if (quizQuestions.length === 0) {
      showQuizEmpty();
      return;
    }
    showQuizQuestion();
  } catch (err) {
    console.error('Quiz load error:', err);
    showNotice('题目加载失败', 2000);
  }
}

function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function showQuizQuestion() {
  const q = quizQuestions[quizIndex];
  if (!q) { showQuizResult(); return; }

  const questionEl = document.getElementById('quiz-question');
  const inputEl = document.getElementById('quiz-input');
  const feedbackEl = document.getElementById('quiz-feedback');
  const checkBtn = document.getElementById('quiz-check');
  const progressEl = document.getElementById('quiz-progress');
  const barFill = document.getElementById('quiz-bar-fill');
  const cardEl = document.getElementById('quiz-card');
  const resultEl = document.getElementById('quiz-result');

  // 切换可见性
  cardEl.style.display = 'block';
  resultEl.classList.add('hidden');
  feedbackEl.classList.add('hidden');
  inputEl.value = '';
  inputEl.className = '';
  inputEl.disabled = false;
  inputEl.focus();
  checkBtn.disabled = false;
  quizChecked = false;

  questionEl.textContent = quizDirection === 'jp2cn' ? q.jp : q.cn;
  progressEl.textContent = `${quizIndex + 1} / ${QUIZ_TOTAL}`;
  barFill.style.width = `${((quizIndex) / QUIZ_TOTAL) * 100}%`;

  // 更新题目标签
  document.querySelector('.quiz-question-label').textContent =
    quizDirection === 'jp2cn' ? '请翻译成中文：' : '请翻译成日语：';
}

function checkQuizAnswer() {
  if (quizChecked) return;
  quizChecked = true;

  const q = quizQuestions[quizIndex];
  const inputEl = document.getElementById('quiz-input');
  const feedbackEl = document.getElementById('quiz-feedback');
  const checkBtn = document.getElementById('quiz-check');
  const userAnswer = inputEl.value.trim();
  const correctAnswer = quizDirection === 'jp2cn' ? q.cn : q.jp;

  // 简单比对：忽略全角/半角空格差异
  const norm = (s) => s.replace(/[\s\u3000]+/g, '').toLowerCase();
  const isCorrect = norm(userAnswer) === norm(correctAnswer);

  if (isCorrect) {
    quizScore++;
    inputEl.classList.add('correct');
    feedbackEl.className = 'quiz-feedback ok';
    feedbackEl.innerHTML = '✅ 答对啦！🎉';
  } else {
    inputEl.classList.add('wrong');
    feedbackEl.className = 'quiz-feedback ng';
    feedbackEl.innerHTML = `❌ 不对<br>正确答案：<b>${escapeHtml(correctAnswer)}</b>`;
  }
  feedbackEl.classList.remove('hidden');
  inputEl.disabled = true;
  checkBtn.disabled = true;

  // 1.5 秒后自动跳到下一题
  setTimeout(() => {
    quizIndex++;
    const barFill = document.getElementById('quiz-bar-fill');
    barFill.style.width = `${(quizIndex / QUIZ_TOTAL) * 100}%`;
    if (quizIndex >= QUIZ_TOTAL || quizIndex >= quizQuestions.length) {
      showQuizResult();
    } else {
      showQuizQuestion();
    }
  }, 1400);
}

function showQuizEmpty() {
  const cardEl = document.getElementById('quiz-card');
  const resultEl = document.getElementById('quiz-result');
  const resultText = document.getElementById('quiz-result-text');
  const resultEmoji = document.getElementById('quiz-result-emoji');
  cardEl.style.display = 'none';
  resultEl.classList.remove('hidden');
  resultEmoji.textContent = '📭';
  resultText.textContent = '这个难度还没有题目。';
}

function showQuizResult() {
  const cardEl = document.getElementById('quiz-card');
  const resultEl = document.getElementById('quiz-result');
  const resultText = document.getElementById('quiz-result-text');
  const resultEmoji = document.getElementById('quiz-result-emoji');
  const barFill = document.getElementById('quiz-bar-fill');

  cardEl.style.display = 'none';
  resultEl.classList.remove('hidden');
  barFill.style.width = '100%';

  const pct = QUIZ_TOTAL > 0 ? Math.round((quizScore / QUIZ_TOTAL) * 100) : 0;
  if (pct >= 90) resultEmoji.textContent = '🏆';
  else if (pct >= 70) resultEmoji.textContent = '😊';
  else if (pct >= 50) resultEmoji.textContent = '🤔';
  else resultEmoji.textContent = '📚';

  resultText.innerHTML = `${QUIZ_TOTAL} 题中答对 <b style="color:var(--accent);font-size:22px">${quizScore}</b> 题！<br>
    <span style="color:var(--text-dim);font-size:14px">正确率 ${pct}%</span>`;
}

function toggleQuizDirection() {
  quizDirection = quizDirection === 'jp2cn' ? 'cn2jp' : 'jp2cn';
  const btn = document.getElementById('quiz-direction');
  btn.textContent = quizDirection === 'jp2cn' ? '🇯🇵 → 🇨🇳' : '🇨🇳 → 🇯🇵';
  btn.classList.toggle('cn2jp', quizDirection === 'cn2jp');
  // 重新加载当前轮
  if (quizQuestions.length > 0) {
    quizIndex = 0;
    quizScore = 0;
    showQuizQuestion();
  }
}

function startQuiz() {
  const levelVal = document.getElementById('quiz-level').value;
  loadQuiz(levelVal === 'all' ? null : parseInt(levelVal));
}

// 事件绑定
document.getElementById('quiz-direction').addEventListener('click', toggleQuizDirection);
document.getElementById('quiz-check').addEventListener('click', checkQuizAnswer);
document.getElementById('quiz-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !quizChecked) checkQuizAnswer();
});
document.getElementById('quiz-level').addEventListener('change', startQuiz);
document.getElementById('quiz-restart').addEventListener('click', startQuiz);

document.getElementById('quiz-btn')?.addEventListener('click', () => {
  startQuiz();
  openSheet('quiz-sheet');
});

// ==================== 语气切换 ====================
document.getElementById('tone-select')?.addEventListener('change', (e) => {
  currentTone = e.target.value;
  localStorage.setItem('nihongo_tone', currentTone);  // 持久化说话风格
  const labels = { polite: '😊 敬语', casual: '😎 随意', kansai: '🐙 关西话' };
  showNotice('说话风格: ' + (labels[currentTone] || currentTone), 1500);
});
if (document.getElementById('tone-select')) document.getElementById('tone-select').value = currentTone;  // 恢复上次选择

// ==================== 听力模式 ====================
document.getElementById('listening-toggle')?.addEventListener('click', () => {
  listeningMode = !listeningMode;
  const btn = document.getElementById('listening-toggle');
  btn.querySelector('.ico').textContent = listeningMode ? '🔈' : '🔇';
  btn.classList.toggle('active', listeningMode);
  showNotice(listeningMode ? '🔇 听力模式 ON（不自动朗读）' : '🔈 听力模式 OFF', 1500);
});

// ==================== 量词专项 ====================
let counterQuestions = [];
let counterIndex = 0;
let counterScore = 0;
let counterTotal = 5;

async function loadCounter() {
  try {
    const resp = await safeFetch(SERVER_URL + '/api/assist/counter?count=5');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    counterQuestions = data.questions || [];
    counterIndex = 0;
    counterScore = 0;
    counterTotal = counterQuestions.length;
    if (!counterQuestions.length) {
      document.getElementById('counter-card').style.display = 'none';
      document.getElementById('counter-result').classList.remove('hidden');
      document.getElementById('counter-result-emoji').textContent = '📭';
      document.getElementById('counter-result-text').textContent = '没有题目';
      return;
    }
    showCounterQuestion();
  } catch (err) {
    showNotice('题目加载失败: ' + err.message, 2500);
  }
}

function showCounterQuestion() {
  const q = counterQuestions[counterIndex];
  if (!q) { showCounterResult(); return; }
  document.getElementById('counter-card').style.display = 'block';
  document.getElementById('counter-result').classList.add('hidden');
  document.getElementById('counter-q').textContent = q.q;
  document.getElementById('counter-hint').textContent = `💡 ${q.hint}（${escapeHtml(q.cn)}）`;
  document.getElementById('counter-input').value = '';
  document.getElementById('counter-input').disabled = false;
  document.getElementById('counter-feedback').classList.add('hidden');
  document.getElementById('counter-check').disabled = false;
  document.getElementById('counter-progress').textContent = `${counterIndex + 1} / ${counterTotal}`;
  document.getElementById('counter-input').focus();
}

function checkCounterAnswer() {
  const q = counterQuestions[counterIndex];
  const input = document.getElementById('counter-input');
  const feedback = document.getElementById('counter-feedback');
  const answer = input.value.trim();
  
  if (!answer) return;
  
  const isCorrect = answer === q.reading || answer === q.a;
  
  if (isCorrect) {
    counterScore++;
    feedback.className = 'quiz-feedback ok';
    feedback.innerHTML = `✅ 答对啦！「${escapeHtml(q.reading)}」`;
  } else {
    feedback.className = 'quiz-feedback ng';
    feedback.innerHTML = `❌ 正确答案是「<b>${escapeHtml(q.reading)}</b>」(${escapeHtml(q.a)})`;
  }
  feedback.classList.remove('hidden');
  input.disabled = true;
  document.getElementById('counter-check').disabled = true;
  
  setTimeout(() => {
    counterIndex++;
    if (counterIndex >= counterTotal) showCounterResult();
    else showCounterQuestion();
  }, 1500);
}

function showCounterResult() {
  document.getElementById('counter-card').style.display = 'none';
  document.getElementById('counter-result').classList.remove('hidden');
  const pct = counterTotal > 0 ? Math.round((counterScore / counterTotal) * 100) : 0;
  const emoji = pct >= 80 ? '🏆' : pct >= 60 ? '😊' : '📚';
  document.getElementById('counter-result-emoji').textContent = emoji;
  document.getElementById('counter-result-text').innerHTML = 
    `${counterTotal}問中 <b style="color:var(--accent);font-size:22px">${counterScore}</b> 問正解！（${pct}%）`;
}

document.getElementById('counter-check')?.addEventListener('click', checkCounterAnswer);
document.getElementById('counter-input')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') checkCounterAnswer();
});
document.getElementById('counter-restart')?.addEventListener('click', loadCounter);

// 量词按钮在 header 中
(function addCounterBtn() {
  const header = document.querySelector('header');
  if (!header) return;
  const btn = document.createElement('button');
  btn.className = 'hdr-btn';
  btn.id = 'counter-btn';
  btn.textContent = '🔢 量词';
  const quizBtn = document.getElementById('quiz-btn');
  if (quizBtn) quizBtn.after(btn);
  else header.appendChild(btn);
  
  btn.addEventListener('click', () => {
    loadCounter();
    openSheet('counter-sheet');
  });
})();

// ==================== 划选查词 ====================
let wordPopupTimer = null;

document.addEventListener('mouseup', (e) => {
  // 提前过滤：不在聊天区域内直接跳过，避免无意义的定时器
  if (!chatEl.contains(e.target)) return;

  clearTimeout(wordPopupTimer);
  wordPopupTimer = setTimeout(() => {
    const sel = window.getSelection();
    if (!sel || !sel.toString().trim()) return;
    const text = sel.toString().trim();
    // 只有日语才触发查词
    if (!/[\u3040-\u309f\u30a0-\u30ff\u4e00-\u9fff]/.test(text)) return;
    if (text.length > 15) return;
    
    // 二次确认选区仍在聊天区域内
    const range = sel.getRangeAt(0);
    if (!range || !chatEl.contains(range.commonAncestorContainer)) return;
    
    showWordLookup(text, sel);
  }, 400);
});

async function showWordLookup(text, sel) {
  const popup = document.getElementById('word-popup');
  const content = document.getElementById('word-popup-content');
  if (!popup || !content) return;
  
  // 定位在选区附近
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  popup.style.top = (rect.bottom + 8) + 'px';
  popup.style.left = Math.min(rect.left, window.innerWidth - 280) + 'px';
  popup.classList.remove('hidden');
  content.innerHTML = '<span style="color:var(--text-dim)">検索中…</span>';
  
  try {
    const resp = await safeFetch(SERVER_URL + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, mode: 'word', level: 'N4', tone: 'polite' }),
    });
    if (!resp.ok) throw new Error('');
    const data = await resp.json();
    content.innerHTML = escapeHtml(data.reply).replace(/\n/g, '<br>');
  } catch (_) {
    content.innerHTML = '🔍 検索失敗';
  }
}

document.getElementById('word-popup-close')?.addEventListener('click', () => {
  document.getElementById('word-popup').classList.add('hidden');
});

// 点击空白处关闭查词弹窗
document.addEventListener('click', (e) => {
  const popup = document.getElementById('word-popup');
  if (!popup || popup.classList.contains('hidden')) return;
  if (!popup.contains(e.target)) {
    popup.classList.add('hidden');
  }
});

// ==================== 跟读发音打分（免费版）====================
// 原理：浏览器 Web Speech API 只把语音转成文字，本身不会逐音打分。
// 这里用「识别结果 vs 目标句」的文字相似度（编辑距离）+ 识别置信度 + 候选词，
// 粗略判断说得清不清楚。无法精确到单个假名（那需要付费 API）。
let scoreRecognition = null;
let scoreSupported = false;

function initScoreSpeech() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return;
  scoreSupported = true;
  scoreRecognition = new SR();
  scoreRecognition.lang = 'ja-JP';
  scoreRecognition.continuous = false;
  scoreRecognition.interimResults = false;
  scoreRecognition.maxAlternatives = 3;   // 多拿几个候选词用于反馈
}

/** 跟读一条句子：示范朗读 → 倒计时 → 录音 → 评分卡片 */
async function startShadowing(sentence) {
  if (!scoreSupported || !scoreRecognition) {
    showNotice('当前设备不支持发音检测（建议用 Chrome / Safari）', 2500);
    return;
  }
  // 1) 小樱先示范朗读
  await speakSentence(sentence);

  // 2) 倒计时提示
  showShadowStatus('🎧 仔细听…我再读一遍');
  await speakSentence(sentence);

  showShadowStatus('🗣️ 3 秒后开始录音…请跟着读！');
  await sleep(3000);

  // 3) 开始录音识别
  showShadowStatus('🎤 录音中…请说！');
  scoreRecognition.onresult = (event) => {
    const res = event.results[0];
    const best = res[0];
    const transcript = best.transcript;
    const confidence = best.confidence || 0;
    const alts = [];
    for (let i = 0; i < res.length; i++) {
      alts.push({ text: res[i].transcript, conf: res[i].confidence || 0 });
    }
    const verdict = comparePronunciation(sentence, transcript, confidence);
    showShadowResult(sentence, transcript, verdict, alts);
  };
  scoreRecognition.onerror = (e) => {
    if (e.error === 'no-speech') {
      showShadowStatus('😶 没有检测到声音，再试一次吧');
    } else if (e.error === 'not-allowed') {
      showShadowStatus('🎤 需要允许使用麦克风');
    } else {
      showShadowStatus('🎤 没听清（' + e.error + '）');
    }
    setTimeout(hideShadowStatus, 2500);
  };
  try {
    scoreRecognition.start();
  } catch (_) {}
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** 编辑距离相似度 + 置信度 → 综合一致度 */
function comparePronunciation(original, spoken, confidence) {
  const o = original.replace(/[\s\u3000。、！？!?,，.\-…〜~]+/g, '');
  const s = spoken.replace(/[\s\u3000。、！？!?,，.\-…〜~]+/g, '');

  const m = o.length, n = s.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = Math.min(
        dp[i-1][j] + 1,
        dp[i][j-1] + 1,
        dp[i-1][j-1] + (o[i-1] === s[j-1] ? 0 : 1)
      );
    }
  }
  const textSim = Math.max(0, 1 - dp[m][n] / Math.max(m, 1));   // 0~1 文字相似度
  // 综合分 = 文字相似度 70% + 识别置信度 30%
  const score = Math.round((textSim * 0.7 + confidence * 0.3) * 100);

  let emoji, comment;
  if (score >= 90)      { emoji = '😎'; comment = '完美！像母语者一样！'; }
  else if (score >= 75) { emoji = '😊'; comment = '很棒！保持这个状态！'; }
  else if (score >= 55) { emoji = '🤔'; comment = '还行。再慢慢读一遍试试'; }
  else                  { emoji = '😅'; comment = '有点听不清，仔细听示范再模仿一下'; }
  return { score, emoji, comment };
}

// ----- 跟读用的临时浮层（状态提示 + 结果卡片）-----
let _shadowStatusEl = null;
function _ensureShadowStatus() {
  if (_shadowStatusEl) return _shadowStatusEl;
  const el = document.createElement('div');
  el.id = 'shadow-status';
  document.body.appendChild(el);
  _shadowStatusEl = el;
  return el;
}
function showShadowStatus(text) {
  const el = _ensureShadowStatus();
  el.textContent = text;
  el.classList.add('show');
}
function hideShadowStatus() {
  if (_shadowStatusEl) _shadowStatusEl.classList.remove('show');
}

function showShadowResult(target, spoken, verdict, alts) {
  hideShadowStatus();
  const altHtml = alts.length
    ? `<div class="shadow-alts">認識候補：${alts.map(a =>
        `「${escapeHtml(a.text)}」<small>${Math.round(a.conf*100)}%</small>`).join(' / ')}</div>`
    : '';
  const card = document.createElement('div');
  card.className = 'shadow-card';
  card.innerHTML = `
    <div class="shadow-head">🗣️ 发音检测 <button class="shadow-close">×</button></div>
    <div class="shadow-score ${verdict.score>=75?'good':verdict.score>=55?'mid':'low'}">
      <span class="shadow-emoji">${verdict.emoji}</span>
      <span class="shadow-num">${verdict.score}<small>点</small></span>
    </div>
    <div class="shadow-comment">${escapeHtml(verdict.comment)}</div>
    <div class="shadow-target"><b>示范：</b>${escapeHtml(target)}</div>
    <div class="shadow-spoken"><b>你的发音：</b>${escapeHtml(spoken)}</div>
    ${altHtml}
    <button class="shadow-retry">🔄 再来一次</button>
  `;
  document.body.appendChild(card);
  card.querySelector('.shadow-close').onclick = () => card.remove();
  card.querySelector('.shadow-retry').onclick = () => { card.remove(); startShadowing(target); };
  // 点空白关闭
  card.addEventListener('click', (e) => { if (e.target === card) card.remove(); });
}

// ==================== 初始化 ====================
checkAuth();
initSpeech();
scrollBottom();

if ('speechSynthesis' in window) {
  window.speechSynthesis.getVoices();
  window.speechSynthesis.onvoiceschanged = () => window.speechSynthesis.getVoices();
}

// PWA
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js');
}
