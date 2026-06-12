# say-draw —— AI 语音造图工具

纯语音控制:用户**不使用鼠标 / 键盘**,只用语音和 AI **多轮对话**把"想要的画面"聊清楚 —— AI 会就**风格 / 背景 / 用途**主动反问、并记住聊过的内容;满意后说一句「生成吧」,直接产出**最终图片**。

> 七牛云比赛 · 命题二:AI 语音绘图工具

## 这版的产品思路

语音 + 大模型最擅长的是**理解、澄清、拆解复杂意图**,而不是在画布上拼几何图形(那样画复杂内容只能得到很潦草的结果)。所以本版把交互收敛为:

```
语音(ASR) → 多轮对话聊清画面(带记忆 + 缺信息反问) → 生成图片
                                                          ↓
        满意为止 ◀── 语音迭代改图(改色/换背景/增减元素,以当前图为参考重绘、保持一致) ◀──┘
                       ▲ 语音朗读(TTS)回应每一轮 ▼
```

"画"发生在对话里,真正的成品是生成的图;出图后还能用语音反复改它(像"美术指导")。全程语音进、语音出,不碰键鼠。

## 核心能力(已实现)

- **多轮对话造图**:说想要什么 → AI 逐步帮你确认主体 / 风格 / 背景 / 用途。
- **对话记忆**:① 会话内——整段对话随每轮带给模型,它记得前面聊过什么;② **跨刷新**——对话持久化到浏览器 `localStorage`,刷新 / 重开页面自动恢复接着聊;说「新对话」或点「🆕 新对话」清空重来。
- **缺信息自动反问**:信息不足(尤其风格 / 背景 / 用途)时,AI 主动追问而非乱生成。
- **生成时机交给模型判断**:不靠关键词规则——由豆包从对话语义判断"信息够了且用户想生成"才触发文生图。
- **🌟 语音迭代改图(核心差异化)**:出图后直接说「把猫改成橙色」「背景换成星空」「右边加只狗」,系统**以当前图为参考重绘——只改你说的、其余保持一致**(角色 / 构图连贯)。这是和"通用文生图每次重抽"的本质区别:你在用语音做**美术指导**。
- **🌟 版本检查点 + 随时回退**:每次生成 / 改图都自动存为一个版本(底部「版本」条可见);说「**回到第 2 张**」或点缩略图,**跳回任意版本继续改**(可从任一检查点分叉);说「**收藏**」标记心仪版本、「**撤销**」回上一张。
- **语音反馈(TTS)**:AI 每轮回复都会朗读;朗读期间自动静麦,避免把自己的声音听成新输入(防回环)。

## 技术栈

- **前端**:Vite + TypeScript(纯前端对话 UI,**无第三方运行时依赖**)
- **语音**:Web Speech API —— 识别 `webkitSpeechRecognition`(zh-CN) + 合成 `SpeechSynthesis`
- **后端**:Node + Express 薄代理,转发**火山方舟 Ark**(OpenAI 兼容),密钥不进浏览器;原生 `fetch`,无需 SDK
- **模型**:对话 = 豆包(`ARK_MODEL`,如 `doubao-seed-2.0-mini`);文生图 = Seedream(`ARK_IMAGE_MODEL`)

## 运行方式(从零复现)

> **前端 + 后端都要启动**(对话和生成都依赖后端调用豆包 / Seedream)。

### 1. 环境要求

- **Node.js ≥ 18**(含 npm):https://nodejs.org ,或 macOS `brew install node`
- **Git**
- **浏览器:Chrome 或 Edge**(语音识别依赖 Web Speech API;Safari / Firefox 不保证)
- 一个可用的**麦克风**

### 2. 获取代码

```bash
git clone https://github.com/xzha0637-design/say-draw.git
cd say-draw
```

### 3. 后端:豆包对话 + Seedream 文生图(必需)

**3.1 准备火山方舟密钥与模型**:火山引擎控制台 → 方舟(Ark) → 「开通管理」分别**开通一个豆包对话模型**(如 `doubao-seed-2.0-mini`)和**一个 Seedream 文生图模型** → 「API Key 管理」创建密钥。

**3.2 配置环境变量**:

```bash
cd backend
cp .env.example .env       # 编辑 .env,填入:
                           #   ARK_API_KEY    = 你的密钥
                           #   ARK_MODEL      = 对话模型 ID(如 doubao-seed-2.0-mini)
                           #   ARK_IMAGE_MODEL= Seedream 文生图模型 ID
                           #   ARK_THINKING   = disabled(推理模型关思考、提速;非推理模型留空)
```

**3.3 安装并启动**:

```bash
npm install
npm run dev                # 默认 http://localhost:8787
```

### 4. 前端

```bash
cd frontend
npm install
npm run dev                # http://localhost:5173,自动打开(请用 Chrome / Edge)
```

### 5. 使用

1. 点底部「🎤 开始聆听」,允许麦克风权限。
2. 说出你想要的画面,例如先说得笼统:「**我想画一只猫**」。
3. AI 会**反问**风格 / 背景 / 用途;你补充:「**卡通风格,在草地上,当微信头像**」。
4. 说「**可以了 / 生成吧**」→ AI 综合对话生成描述 → 图片**直接显示在对话流里**(点击可放大)。
5. **看到图后用语音改它**:「**把猫改成橙色**」「**背景换成星空**」「**右边加只小狗**」——系统以当前图为参考重绘,**只改你说的、其余保持一致**。
6. **版本随时回退**:底部「版本」条列出每张;说「**回到第 2 张**」(或点缩略图)跳回任意版本接着改,说「**收藏**」标记、「**撤销**」回上一张。
7. 想要全新一张就说「**重新画一张……**」;说「**新对话**」或点右上「🆕 新对话」清空记忆从头开始。

### 6. 验证后端(另开一个终端)

```bash
curl http://localhost:8787/api/health
# 预期:{"ok":true}

# 多轮对话(messages 为对话历史):
curl -X POST http://localhost:8787/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"我想画一只猫"}]}'
# 预期:{"ok":true,"action":"chat","reply":"…(反问风格/背景/用途)…"}

# 画面描述 → 最终图片:
curl -X POST http://localhost:8787/api/generate \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"卡通风格的可爱猫咪,在绿色草地上,微信头像,清新明亮"}'
# 预期:{"ok":true,"url":"https://.../xxx"}(浏览器打开该 url 看图)
```

> 未配置 `.env` 时接口会返回「后端未配置 ARK_API_KEY / ARK_MODEL」——属正常,填好密钥即可。

### 生产构建

```bash
cd frontend
npm run build      # 产物输出到 frontend/dist/
npm run preview    # 本地预览构建产物
```

## 依赖说明

- **第三方**:前端 vite、typescript(均为构建期依赖,**运行时无第三方库**);后端 express、dotenv(详见各模块 `package.json`)。豆包对话与 Seedream 文生图经**火山方舟 OpenAI 兼容接口**调用,后端用原生 `fetch`,无需额外 SDK。
- **原创部分**:对话造图的会话控制器(记忆 / 持久化 / 看图态切换)、后端对话系统提示词与 `{action, reply, prompt}` 归一化、由模型判断生成时机与反问策略、前端语音对话 UI、ASR↔TTS 防回环联动、Seedream 接入与展示。

## 目录结构

```
/frontend   前端(语音对话 UI:ASR + TTS + 会话控制 + 结果展示)
/backend    后端薄代理(转发火山方舟:豆包对话 /api/chat + Seedream /api/generate)
/docs       设计文档
```

## Demo 视频

> 随开发补全(B站 / 云盘链接,可播放)。
