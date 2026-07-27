# 部署到云端（回家继续）

目标：手机随时能用 + 能发链接给朋友。

## 当前进度

- [x] 代码已推送到 GitHub 私有仓库 `liuxiaola071/nihongo-chat`
- [x] 语音改为 Edge TTS（免费无限量，服务端生成 mp3，所有手机都能听）
- [x] `requirements.txt` 已加 `edge-tts`
- [x] 前端加了浏览器朗读兜底
- [ ] 部署到 Render
- [ ] 加访问密码保护 API 额度

## 在家要做的事

### 1. 拉代码

```bash
git clone https://github.com/liuxiaola071/nihongo-chat.git
cd nihongo-chat
pip install -r requirements.txt
```

新建 `.env`（不要提交，已在 .gitignore 里）：

```
DEEPSEEK_API_KEY=你的key
```

本地跑：`cd backend && python server.py` → 打开 http://localhost:8765

### 2. 部署到 Render（免费）

1. https://dashboard.render.com 用 GitHub 账号登录
2. New → Web Service → 选 `nihongo-chat`（私有仓库要点授权）
3. 配置：
   - Root Directory: `backend`
   - Build Command: `pip install -r ../requirements.txt`
   - Start Command: `python server.py`
   - Instance Type: Free
4. Environment → Add Environment Variable：
   - `DEEPSEEK_API_KEY` = 你的 key
   - （可选）`EDGE_TTS_VOICE` = `ja-JP-NanamiNeural` 或 `ja-JP-KeitaNeural`
   - （可选）`EDGE_TTS_RATE` = `-10%`（负数变慢）
5. 部署完成会给一个网址，比如 `https://nihongo-chat-xxxx.onrender.com`

**注意**：
- key 只填在 Render 后台，永远不要写进代码
- 免费套餐 15 分钟没人访问会休眠，下次打开要等 30~60 秒
- `PORT` 不用配，Render 会自动注入，代码已经读环境变量了

### 3. 手机上装成 App

手机浏览器打开网址 →
- iPhone Safari：分享 → 添加到主屏幕
- 安卓 Chrome：菜单 → 添加到主屏幕

（manifest.json 和 sw.js 已经写好了，会像原生 App 一样全屏运行）

### 4. 待决定：访问保护

链接发出去后，朋友每聊一句都花你的 DeepSeek 额度。可选方案：
- 简单：进页面先输一个共享口令
- 或者：只发给信任的几个人，先观察用量

DeepSeek 用量看这里：https://platform.deepseek.com/usage

## 语音优先级（代码逻辑）

1. **Edge TTS** — 微软免费语音，无限量，Linux 也能跑 → 主力
2. **ElevenLabs** — 配了 key 才用，免费额度 1 万字/月 → 备用
3. **Windows 内置 TTS** — 只在本机 Windows 有效
4. **浏览器朗读** — 上面全失败时前端兜底（安卓国产 ROM、微信浏览器可能没日语音色）

## 后续可做

- 聊天记录存 localStorage，刷新不丢
- 加一个"重新开始"按钮（后端 `/api/reset` 已经有了）
- 回复延迟 5~8 秒，可以把 AI 回复和语音生成并行来加速
