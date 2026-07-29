// ==================== 日本語チャット v1.6 — App ====================
// さくらと話そう。AI 日语会话练习 PWA

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
      showNotice('⚠️ サーバーに接続できません', 3000);
    }
    throw err;
  }
}

// ==================== 全局状态 ====================
let currentScenario = 'free';
let currentMode = 'chat';      // chat|correct|translate|word
let currentLevel = 'N4';       // N5|N4|N3|N2|N1
let currentRate = localStorage.getItem('nihongo_rate') || '';  // 语速
let currentTone = 'polite';    // polite|casual|kansai
let listeningMode = false;    // 听力模式：只显示文字不自动读
let handsFreeMode = false;    // 免提对话：自动 听→说→听 循环
let scenarioList = [];
let isSending = false;

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
  loadReview();   // 预加载 SRS 复习数
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
      errEl.textContent = 'パスワードが違います';
      input.value = '';
      input.focus();
    }
  } catch (e) {
    errEl.textContent = '通信エラー';
  }
}

document.getElementById('auth-btn').addEventListener('click', tryUnlock);
document.getElementById('auth-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') tryUnlock();
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
    document.getElementById('server-msg').textContent = '✅ 保存しました';
  } else {
    localStorage.removeItem('nihongo_server');
    document.getElementById('server-msg').textContent = '🗑 クリアしました';
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
      <div class="fix-title">📝 修正ポイント</div>
      ${fixLines}
    </div>`;
  }

  // 场景达成
  if (sceneDone) {
    html += '<span class="scene-done-badge">🎉 ミッション達成！</span>';
  }

  // 重听按钮
  if (role === 'ai' && withAudio) {
    const id = `audio-${audioSeq++}`;
    if (audioB64) {
      _cacheSet(audioCache, id, audioB64, MAX_AUDIO_CACHE);
    } else {
      _cacheSet(textCache, id, text, MAX_TEXT_CACHE);
    }
    html += `<br><span class="play-btn" data-audio-id="${id}">🔊 もう一度聞く</span>`;
    html += `<span class="furi-btn" data-furi-text="${escapeHtml(text)}">あ ふりがな</span>`;
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

  const label = role === 'me' ? now() : 'さくら';
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

function playAudio(base64) {
  return new Promise((resolve) => {
    if (!base64) { resolve(); return; }
    try {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();

      audioCtx.decodeAudioData(bytes.buffer, (buffer) => {
        const source = audioCtx.createBufferSource();
        source.buffer = buffer;
        source.connect(audioCtx.destination);
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
      showNotice('この端末は音声読み上げに対応していません');
      resolve(false); return;
    }
    const voices = window.speechSynthesis.getVoices();
    const ja = voices.find(v => v.lang && v.lang.toLowerCase().startsWith('ja'));
    if (!ja) {
      showNotice('日本語の音声がこの端末にありません');
      resolve(false); return;
    }
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'ja-JP';
    u.rate = 0.9;
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
      showNotice('音声が見つかりません');
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
});

// ==================== 振假名（ふりがな）====================
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

  btn.textContent = 'あ ...';
  try {
    const rubyHtml = await fetchFurigana(text);
    if (!msg.dataset.plainHtml) msg.dataset.plainHtml = body.innerHTML;
    body.innerHTML = rubyHtml.replace(/\n/g, '<br>');
    msg.dataset.furiOn = '1';
    btn.classList.add('active');
  } catch (err) {
    console.error(err);
    showNotice('ふりがなの取得に失敗しました');
  } finally {
    btn.textContent = 'あ ふりがな';
  }
}

// ==================== 句子点读 ====================
const sentenceAudioCache = new Map();
const MAX_SENTENCE_AUDIO_CACHE = 30;  // 音频数据更大，限制更严格

async function speakSentence(text) {
  // 先用缓存
  if (sentenceAudioCache.has(text)) {
    playAudio(sentenceAudioCache.get(text));
    return;
  }
  statusEl.textContent = '🔊 読み上げ中…';
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
      playAudio(data.audio_b64);
    } else {
      speakByBrowser(text);
    }
  } catch (err) {
    console.error('Sentence TTS error:', err);
    speakByBrowser(text);
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
    showNotice('翻訳に失敗しました', 2000);
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
    showNotice('このブラウザは音声入力をサポートしていません');
    return;
  }

  recognition = new SpeechRecognition();
  recognition.lang = 'ja-JP';
  recognition.interimResults = true;
  recognition.continuous = false;
  recognition.maxAlternatives = 1;

  recognition.onresult = (event) => {
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
      showNotice('マイクの許可が必要です');
      stopHandsFree();  // 权限被拒 → 退出免提
    } else if (event.error === 'no-speech') {
      if (handsFreeMode) {
        // 免提模式下没检测到语音 → 短暂等待后重新听
        statusEl.textContent = '🎧 …';
        setTimeout(() => { if (handsFreeMode) startListening(); }, 1500);
      } else {
        showNotice('音声が検出されませんでした');
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

  // 跟读发音打分用の音声認識も一緒に初期化
  initScoreSpeech();
}

function startListening() {
  if (!recognition) return;
  try {
    isListening = true;
    micBtn.classList.add('listening');
    statusEl.textContent = '🎤 聞いています…';
    recognition.start();
  } catch (e) {
    stopListening();
  }
}

function stopListening() {
  isListening = false;
  micBtn.classList.remove('listening');
  statusEl.textContent = '';
}

micBtn.addEventListener('click', () => {
  if (!recognition) {
    showNotice('音声入力非対応です。キーボードで入力してください');
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
    showNotice('音声入力非対応です');
    return;
  }
  handsFreeMode = true;
  handsFreeBtn.classList.add('active');
  handsFreeBtn.textContent = '🎧';
  showNotice('🎧 免提モード ON — 話しかけてね', 2500);
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
    showNotice('🎧 免提モード OFF', 1500);
  } else {
    startHandsFree();
  }
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
    chat: '日本語で話しかけてね…',
    correct: '日本語を入力すると添削します…',
    translate: '翻訳したい文章を入力…',
    word: '調べたい単語を入力…',
  };
  inputEl.placeholder = placeholders[modeId] || '日本語で話しかけてね…';
}

document.getElementById('mode-bar').addEventListener('click', (e) => {
  const chip = e.target.closest('.mode-chip');
  if (chip) switchMode(chip.dataset.mode);
});

// 难度选择
document.getElementById('level-select').addEventListener('change', (e) => {
  currentLevel = e.target.value;
});

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
    social: '🤝 社交', shop: '🛒 買い物', travel: '🧳 旅行',
    work: '💼 仕事', study: '🎓 勉強', emergency: '🚨 緊急', other: '💬 その他',
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
  if (isSending) { showNotice('ちょっと待ってね…'); return; }
  closeSheet('scene-sheet');
  try {
    const resp = await safeFetch(SERVER_URL + `/api/scenario/${encodeURIComponent(sid)}`, { method: 'POST' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const sc = await resp.json();

    currentScenario = sc.id;
    sceneLabel.textContent = sc.name;
    document.getElementById('scene-btn').firstChild.textContent = sc.emoji + ' ';

    chatEl.innerHTML = '';
    audioCache.clear();
    textCache.clear();
    addMsg('ai', sc.opening, { withAudio: true });
    showNotice(`${sc.emoji} ${sc.name}モード`, 2000);
  } catch (err) {
    showNotice('エラー: ' + err.message, 3000);
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
    : '<div class="vocab-empty">まだ単語がありません。<br>さくらと話すと自動でたまります🌸</div>';
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
  if (!words.length) { showNotice('この日の単語はありません', 2000); return; }

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
  showNotice('📥 ダウンロードしました', 2000);
});

document.getElementById('vocab-clear').addEventListener('click', () => {
  const day = vocabDay || getToday();
  if (!confirm(`${day} の単語を全部消しますか？`)) return;
  const all = _readVocab();
  delete all[day];
  _writeVocab(all);
  loadVocab(day);
  if (!vocabDay || vocabDay === getToday()) { vocabCount = 0; renderBadge(); }
  showNotice('クリアしました', 1500);
});

// ==================== SRS 间隔复习 ====================
let reviewWords = [];
let reviewIndex = 0;
let reviewFlipped = false;

const reviewCard    = document.getElementById('review-card');
const reviewWordEl  = document.getElementById('review-word');
const reviewKanaEl  = document.getElementById('review-kana');
const reviewBack    = document.getElementById('review-back');
const reviewMeaning = document.getElementById('review-meaning');
const reviewHint    = document.getElementById('review-hint');
const reviewGrades  = document.getElementById('review-grades');
const reviewDone    = document.getElementById('review-done');
const reviewStats   = document.getElementById('review-stats');
const reviewBadge   = document.getElementById('review-badge');

async function loadReview() {
  try {
    const resp = await safeFetch(SERVER_URL + '/api/srs/due');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    reviewWords = data.words || [];
    renderReviewStats(data.stats);
    reviewBadge.textContent = reviewWords.length;
    reviewBadge.classList.toggle('show', reviewWords.length > 0);
    reviewIndex = 0;
    if (reviewWords.length > 0) {
      showReviewCard();
    } else {
      reviewCard.style.display = 'none';
      reviewHint.classList.add('hidden');
      reviewGrades.classList.add('hidden');
      reviewDone.classList.remove('hidden');
    }
  } catch (err) {
    console.error('SRS load error:', err);
    reviewBadge.textContent = '?';
  }
}

function renderReviewStats(stats) {
  if (!stats) { reviewStats.innerHTML = ''; return; }
  reviewStats.innerHTML = `
    <span title="这次复习">📋 复习: ${stats.due}</span>
    <span title="学习总词数">📚 学习: ${stats.learning}</span>
    <span title="已掌握">✅ 掌握: ${stats.mastered}</span>`;
}

function showReviewCard() {
  if (reviewIndex >= reviewWords.length) {
    // 全部复习完了
    reviewCard.style.display = 'none';
    reviewHint.classList.add('hidden');
    reviewGrades.classList.add('hidden');
    reviewDone.classList.remove('hidden');
    reviewBadge.textContent = '0';
    reviewBadge.classList.remove('show');
    return;
  }
  const w = reviewWords[reviewIndex];
  reviewWordEl.textContent = w.word;
  reviewKanaEl.textContent = w.kana || '';
  reviewMeaning.textContent = w.meaning || '(意味なし)';
  reviewFlipped = false;
  reviewBack.classList.add('hidden');
  reviewHint.classList.remove('hidden');
  reviewGrades.classList.add('hidden');
  reviewDone.classList.add('hidden');
  reviewCard.style.display = 'block';
  reviewCard.classList.remove('flipped');
}

function flipCard() {
  if (reviewFlipped) return;
  reviewFlipped = true;
  reviewBack.classList.remove('hidden');
  reviewHint.classList.add('hidden');
  reviewGrades.classList.remove('hidden');
  reviewCard.classList.add('flipped');
}

async function gradeWord(quality) {
  if (!reviewFlipped) return; // 先翻卡再评分
  const w = reviewWords[reviewIndex];
  reviewGrades.style.opacity = '0.4';
  try {
    const resp = await safeFetch(SERVER_URL + '/api/srs/grade', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ word: w.word, quality }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    renderReviewStats(data.stats);
  } catch (err) {
    console.error('SRS grade error:', err);
    showNotice('エラーが発生しました', 2000);
  }
  reviewGrades.style.opacity = '1';
  reviewIndex++;
  setTimeout(() => showReviewCard(), 250);
}

// 翻卡
reviewCard.addEventListener('click', () => {
  if (!reviewFlipped) flipCard();
});

// 评分按钮
reviewGrades.addEventListener('click', (e) => {
  const btn = e.target.closest('.grade-btn');
  if (btn) gradeWord(parseInt(btn.dataset.q));
});

// 打开复习面板
document.getElementById('review-btn').addEventListener('click', () => {
  loadReview();
  openSheet('review-sheet');
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

  statusEl.textContent = 'さくらが考え中…';
  addMsg('me', text);
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

    if (data.new_words && data.new_words.length) {
      saveVocab(data.new_words);
      vocabCount += data.new_words.length;
      renderBadge();
    }

    if (!listeningMode) {
      statusEl.textContent = '🔊 読み上げ中…';
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
    showNotice('エラー: ' + err.message, 3000);
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
    showNotice('ちょっと待ってね…');
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
    showNotice('問題の読み込みに失敗しました', 2000);
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
    quizDirection === 'jp2cn' ? '日本語 → 中国語に翻訳してください：' : '中国語 → 日本語に翻訳してください：';
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
    feedbackEl.innerHTML = '✅ 正解！🎉';
  } else {
    inputEl.classList.add('wrong');
    feedbackEl.className = 'quiz-feedback ng';
    feedbackEl.innerHTML = `❌ 違います<br>正解：<b>${escapeHtml(correctAnswer)}</b>`;
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
  resultText.textContent = 'このレベルの問題はまだありません。';
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

  resultText.innerHTML = `${QUIZ_TOTAL}問中 <b style="color:var(--accent);font-size:22px">${quizScore}</b> 問正解！<br>
    <span style="color:var(--text-dim);font-size:14px">正解率 ${pct}%</span>`;
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
  const labels = { polite: '😊 敬語', casual: '😎 タメ口', kansai: '🐙 関西弁' };
  showNotice('話し方: ' + (labels[currentTone] || currentTone), 1500);
});

// ==================== 听力模式 ====================
document.getElementById('listening-toggle')?.addEventListener('click', () => {
  listeningMode = !listeningMode;
  const btn = document.getElementById('listening-toggle');
  btn.textContent = listeningMode ? '🔈' : '🔇';
  btn.classList.toggle('active', listeningMode);
  showNotice(listeningMode ? '🔇 听力模式 ON（不自动朗读）' : '🔈 听力模式 OFF', 1500);
});

// ==================== 导出 Markdown ====================
document.getElementById('export-btn')?.addEventListener('click', async () => {
  try {
    const resp = await safeFetch(SERVER_URL + '/api/export/markdown');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'nihongo_chat.md';
    a.click();
    URL.revokeObjectURL(url);
    showNotice('📥 エクスポートしました', 2000);
  } catch (err) {
    showNotice('エクスポート失敗: ' + err.message, 2500);
  }
});

// ==================== 学习统计 ====================
async function loadStats() {
  try {
    const resp = await safeFetch(SERVER_URL + '/api/stats');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
  } catch (err) { console.error('stats error:', err); return null; }
}

async function showStats() {
  const container = document.getElementById('stats-content');
  if (!container) return;
  container.innerHTML = '<p style="color:var(--text-dim);text-align:center;padding:24px">読み込み中…</p>';
  
  const stats = await loadStats();
  if (!stats) {
    container.innerHTML = '<p style="color:var(--text-dim);text-align:center;padding:24px">読み込み失敗</p>';
    return;
  }

  const weakness = stats.weakness || {};
  const cats = (weakness.categories || []).map(c => 
    `<span class="stat-tag">${c.name}: ${c.count}回</span>`
  ).join('');

  container.innerHTML = `
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-num">${stats.streak || 0}</div>
        <div class="stat-label">連続日数 🔥</div>
      </div>
      <div class="stat-card">
        <div class="stat-num">${stats.total_days || 0}</div>
        <div class="stat-label">総日数 📅</div>
      </div>
      <div class="stat-card">
        <div class="stat-num">${stats.total_scenes_done || 0}</div>
        <div class="stat-label">クリアシーン ✅</div>
      </div>
      <div class="stat-card">
        <div class="stat-num">${weakness.total_errors || 0}</div>
        <div class="stat-label">ミス数 📕</div>
      </div>
    </div>
    ${cats ? `<div style="margin-top:12px"><span style="font-size:13px;color:var(--text-dim)">弱点分析：</span>${cats}</div>` : ''}
    <div style="margin-top:12px;font-size:12px;color:var(--text-dim);text-align:center">
      今日${stats.today_active ? '✅ 学習済み' : 'まだ学習していません'}
    </div>
  `;
}

document.getElementById('stats-btn')?.addEventListener('click', () => {
  showStats();
  openSheet('stats-sheet');
});

// ==================== 错误本 ====================
async function loadErrors() {
  const container = document.getElementById('errors-list');
  const statsArea = document.getElementById('errors-stats');
  if (!container) return;
  container.innerHTML = '<p style="color:var(--text-dim);text-align:center;padding:24px">読み込み中…</p>';

  try {
    const resp = await safeFetch(SERVER_URL + '/api/errors');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    
    statsArea.textContent = `合計 ${data.total} 件のミス`;
    
    if (!data.items.length) {
      container.innerHTML = '<p style="color:var(--text-dim);text-align:center;padding:24px">まだミスがありません！🎉</p>';
    } else {
      container.innerHTML = data.items.map(item => `
        <div class="error-row">
          <span class="err-before">❌ ${escapeHtml(item.wrong || '')}</span>
          <span class="err-arrow">→</span>
          <span class="err-after">✅ ${escapeHtml(item.correct || '')}</span>
          ${item.note ? `<span class="err-note">${escapeHtml(item.note)}</span>` : ''}
        </div>
      `).join('');
    }
  } catch (err) {
    container.innerHTML = '<p style="color:var(--text-dim);text-align:center;padding:24px">読み込み失敗</p>';
    console.error('errors load error:', err);
  }
}

document.getElementById('errors-clear')?.addEventListener('click', async () => {
  if (!confirm('ミス帳を全部消しますか？')) return;
  try {
    await safeFetch(SERVER_URL + '/api/errors', { method: 'DELETE' });
    loadErrors();
    showNotice('クリアしました', 1500);
  } catch (err) {
    showNotice('クリア失敗', 2000);
  }
});

// 错误本按钮在 header 中，需要我们动态创建
(function addErrorBtn() {
  const header = document.querySelector('header');
  if (!header) return;
  const btn = document.createElement('button');
  btn.className = 'hdr-btn';
  btn.id = 'errors-btn';
  btn.textContent = '📕 ミス帳';
  // 插入在 review-btn 后面
  const reviewBtn = document.getElementById('review-btn');
  if (reviewBtn) reviewBtn.after(btn);
  else header.appendChild(btn);
  
  btn.addEventListener('click', () => {
    loadErrors();
    openSheet('errors-sheet');
  });
})();

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
      document.getElementById('counter-result-text').textContent = '問題がありません';
      return;
    }
    showCounterQuestion();
  } catch (err) {
    showNotice('問題の読み込み失敗: ' + err.message, 2500);
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
    feedback.innerHTML = `✅ 正解！「${escapeHtml(q.reading)}」`;
  } else {
    feedback.className = 'quiz-feedback ng';
    feedback.innerHTML = `❌ 正解は「<b>${escapeHtml(q.reading)}</b>」(${escapeHtml(q.a)})`;
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
  btn.textContent = '🔢 助数詞';
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

// ==================== 跟读发音打分 ====================
let scoreRecognition = null;

function initScoreSpeech() {
  if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) return;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  scoreRecognition = new SR();
  scoreRecognition.lang = 'ja-JP';
  scoreRecognition.continuous = false;
  scoreRecognition.interimResults = false;
  scoreRecognition.maxAlternatives = 3;
}

// 跟读发音打分（独立功能，不覆盖 speakSentence）
async function startPronunciationPractice(sentence) {
  speakByBrowser(sentence);
  // 弹出一个评分提示
  showNotice('🗣️ 真似して読んでみて！（3秒後録音開始…）', 3000);
  
  setTimeout(() => {
    if (!scoreRecognition) {
      showNotice('この端末は発音チェック非対応です', 2000);
      return;
    }
    
    scoreRecognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript;
      const result = comparePronunciation(sentence, transcript);
      showNotice(`🎤 ${result.emoji} 一致度: ${result.score}%「${transcript}」`, 4000);
    };
    
    scoreRecognition.onerror = () => showNotice('🎤 聞き取れませんでした', 2000);
    scoreRecognition.onend = () => {};
    
    try {
      scoreRecognition.start();
    } catch (_) {}
  }, 3000);
}

function comparePronunciation(original, spoken) {
  // 简单相似度：编辑距离
  const o = original.replace(/[\s\u3000。、！？!?,，.\-…]+/g, '');
  const s = spoken.replace(/[\s\u3000。、！？!?,，.\-…]+/g, '');
  
  const m = o.length;
  const n = s.length;
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
  
  const similarity = Math.max(0, Math.round((1 - dp[m][n] / Math.max(m, 1)) * 100));
  const emoji = similarity >= 90 ? '😎' : similarity >= 70 ? '😊' : similarity >= 50 ? '🤔' : '😅';
  return { score: similarity, emoji };
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
