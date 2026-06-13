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

### 和直接用豆包 APP 聊天有什么区别?

豆包是"能顺便出图的聊天软件",say-draw 是**"不能动手的人也能完整完成创作、管理、迭代的工作台"**——大模型只是其中一个零件:

| 维度 | 豆包 APP(通用助手) | say-draw |
|---|---|---|
| 纯语音闭环 | 放大图 / 重生成 / 翻历史要手点屏幕 | 看、改、回退、收藏、管理会话 100% 语音可达 |
| 作品版本管理 | 对话线性,图刷过去就没了 | 检查点 + 任意跳回 + 从任一版本分叉(语音版 git) |
| 指令确定性 | 同一句话行为不可预期 | 回退/撤销/收藏走本地快路 ~0ms;改图只改所述、其余保持一致 |
| 创作状态可见 | AI 理解了什么是黑箱 | 画面要素板实时呈现画面结构,缺什么、改了什么一目了然 |

架构思考、路线探索史(为什么不是画板 / SVG / 像素画笔)与三大评审维度的应对详见 [docs/design.md](docs/design.md)。

## 核心能力(已实现)

- **🔐 登录与多会话作品库**:注册 / 登录后,数据按 **`user_id × session_id`** 隔离——每段对话(含画面、版本、场景图)是一个独立「会话」,自动保存到服务端;点「🗂️ 我的画」查看全部历史会话、点开任意一段接着改,说「**新会话**」开新的一张。换设备、换浏览器登录同账号即可找回,别人看不到你的画。
- **💾 图片随时下载**:每张生成图都**入库归档**(不依赖会过期的外链),图下方与放大层都有「⬇ 下载」,随时存到本地。
- **多轮对话造图**:说想要什么 → AI 逐步帮你确认主体 / 风格 / 背景 / 用途。
- **对话记忆**:① 会话内——整段对话随每轮带给模型,它记得前面聊过什么;② **跨设备**——会话快照(对话 + 场景图 + 版本)持久化到服务端 SQLite,登录同账号即恢复接着聊。
- **缺信息自动反问**:信息不足(尤其风格 / 背景 / 用途)时,AI 主动追问而非乱生成。
- **生成时机交给模型判断**:不靠关键词规则——由豆包从对话语义判断"信息够了且用户想生成"才触发文生图。
- **🌟 语义画布:画面要素板**:右侧面板实时呈现 AI 当前理解的画面结构(风格 / 背景 / 用途 + 元素卡片,颜色显示为色点);你每说一句,被改动的卡片**即时闪烁**——AI 听懂了什么、还缺什么、这句话改了哪里,出图前一目了然。每个版本同时存场景图快照,「回到第 N 张」连同画面结构一起恢复。
- **🌟 语音迭代改图(核心差异化)**:出图后直接说「把猫改成橙色」「背景换成星空」「右边加只狗」,系统**以当前图为参考重绘——只改你说的、其余保持一致**(角色 / 构图连贯)。这是和"通用文生图每次重抽"的本质区别:你在用语音做**美术指导**。
- **🌟 版本检查点 + 随时回退**:每次生成 / 改图都自动存为一个版本(底部「版本」条可见);说「**回到第 2 张**」或点缩略图,**跳回任意版本继续改**(可从任一检查点分叉);说「**收藏**」标记心仪版本、「**撤销**」回上一张。
- **🌟 复合指令拆解**:一句话带多个跨类型动作——「**回到第 2 张,然后把背景换成星空**」——豆包拆成步骤序列,对话里显示**步骤标签逐条点亮、打勾**;每一步再分发时仍先过本地快路(版本跳转 ~0ms)。同属一次改图的多处改动(「猫改白色,背景换沙滩」)则**不拆**,一次重绘一并完成,更快且画面更一致。
- **语音反馈(TTS)+ 随时打断**:AI 每轮回复都会朗读;**朗读中你直接开口就能打断它**(barge-in),你的话永远优先。麦克风听到的"AI 自己的声音"(扬声器回声)用文本相似度过滤,不会自我打断、也不会被当成新指令。

## 技术栈

- **前端**:Vite + TypeScript(纯前端对话 UI,**无第三方运行时依赖**)
- **语音**:Web Speech API —— 识别 `webkitSpeechRecognition`(zh-CN) + 合成 `SpeechSynthesis`
- **后端**:Node + Express,转发**火山方舟 Ark**(OpenAI 兼容,密钥不进浏览器,原生 `fetch` 无需 SDK);**SQLite(better-sqlite3)**持久化用户 / 会话 / 图片,登录用令牌鉴权、密码 `node:crypto` scrypt 加盐哈希
- **模型**:对话 = 豆包(`ARK_MODEL`,如 `doubao-seed-2.0-mini`);文生图 = Seedream(`ARK_IMAGE_MODEL`)
- **数据隔离**:`user_id`(账号)× `session_id`(一段对话)双键隔离;图片字节入库,经「能力 URL」`/api/images/:id?k=…` 长期可看可下载

## 运行方式(从零复现)

> **前端 + 后端都要启动**(对话和生成都依赖后端调用豆包 / Seedream)。

### 1. 环境要求

- **Node.js ≥ 18**(含 npm):https://nodejs.org ,或 macOS `brew install node`
- **Git**
- **浏览器:Chrome 或 Edge**(语音识别依赖 Web Speech API;Safari / Firefox 不保证)
  - ⚠️ **Chrome 的语音识别走 Google 云端服务**,网络无法访问 Google 时(内地直连常见)识别会报错——此时请**改用 Microsoft Edge**(识别走微软服务,直连可用),或确保代理可达。页面状态栏会给出具体错误与指引。
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

1. 首次打开**注册账号**(或登录);你的作品按账号隔离、自动保存。
2. 点底部「🎤 开始聆听」,允许麦克风权限。
3. 说出你想要的画面,例如先说得笼统:「**我想画一只猫**」。
3. AI 会**反问**风格 / 背景 / 用途;你补充:「**卡通风格,在草地上,当微信头像**」。右侧**画面要素板**随对话实时拼出画面结构,说错了、缺什么,看一眼就知道。
4. 说「**可以了 / 生成吧**」→ AI 综合对话生成描述 → 图片**直接显示在对话流里**(点击可放大)。
5. **看到图后用语音改它**:「**把猫改成橙色**」「**背景换成星空**」「**右边加只小狗**」——系统以当前图为参考重绘,**只改你说的、其余保持一致**。
6. **版本随时回退**:底部「版本」条列出每张;说「**回到第 2 张**」(或点缩略图)跳回任意版本接着改,说「**收藏**」标记、「**撤销**」回上一张。
7. **复合指令一句到位**:「**回到第 2 张,然后把背景换成星空**」——看步骤标签逐条点亮、打勾,自动先跳版本再改图。
8. **下载 / 找回**:每张图下方或放大层点「**⬇ 下载**」存到本地;点右上「🗂️ 我的画」查看历史会话、点开任意一段接着改。
9. 说「**新会话**」或点右上「🆕 新会话」开全新一张(旧的已自动保存,可在「我的画」找回)。

### 6. 验证后端(另开一个终端)

```bash
curl http://localhost:8787/api/health
# 预期:{"ok":true}

# 多轮对话(messages 为对话历史):
curl -X POST http://localhost:8787/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"我想画一只猫"}]}'
# 预期:{"ok":true,"action":"chat","reply":"…(反问风格/背景/用途)…","scene":{…当前画面结构…}}
# scene 即「语义画布」:{"style","usage","background","elements":[{name,color,desc,pos,size}]}

# 复合指令拆解(一句话多个跨类型动作 → steps 序列):
curl -X POST http://localhost:8787/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"hasImage":true,"messages":[{"role":"user","content":"回到第二张,然后把背景换成星空"}]}'
# 预期:{"ok":true,"action":"multi","reply":"…","steps":["回到第2张","把背景换成星空"]}

# 登录系统与会话隔离(user_id × session_id):
curl -X POST http://localhost:8787/api/auth/register \
  -H 'Content-Type: application/json' -d '{"username":"alice","password":"test1234"}'
# 预期:{"ok":true,"token":"…","userId":"…","username":"alice"}(登录用 /api/auth/login,同形)

# 用 token 管理自己的会话(别人的 token 看不到 → 404):
curl http://localhost:8787/api/conversations -H "Authorization: Bearer <上一步的token>"
# 预期:{"ok":true,"conversations":[…]};POST 同路径 = 新建会话;GET / PUT /api/conversations/:id 读取 / 保存快照
# 数据落盘在 backend/data/(密码 scrypt 加盐哈希,目录已 gitignore)

# 画面描述 → 最终图片:
curl -X POST http://localhost:8787/api/generate \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"卡通风格的可爱猫咪,在绿色草地上,微信头像,清新明亮"}'
# 匿名:{"ok":true,"url":"https://.../xxx"}(Seedream 外链,会过期)
# 带 Authorization: Bearer <token> + sessionId 时:出图字节入库,返回持久能力 URL:
#   {"ok":true,"url":"/api/images/<id>?k=<key>","downloadUrl":"…&dl=1","imageId":"<id>"}
#   该 URL 长期可看;downloadUrl 触发浏览器另存(随时下载),不依赖 Seedream 外链存活
```

> 未配置 `.env` 时接口会返回「后端未配置 ARK_API_KEY / ARK_MODEL」——属正常,填好密钥即可。

### 生产构建

```bash
cd frontend
npm run build      # 产物输出到 frontend/dist/
npm run preview    # 本地预览构建产物
```

## 依赖说明

- **第三方**:前端 vite、typescript(均为构建期依赖,**运行时无第三方库**);后端 express、dotenv、**better-sqlite3**(同步 SQLite 驱动,用于用户 / 会话 / 图片持久化;密码哈希用 Node 内置 `node:crypto`)。详见各模块 `package.json`。豆包对话与 Seedream 文生图经**火山方舟 OpenAI 兼容接口**调用,后端用原生 `fetch`,无需额外 SDK。
- **原创部分**:语义画布(场景图协议、画面要素板、版本场景快照)、登录与隔离体系(`user_id × session_id` 数据隔离、令牌鉴权、图片字节入库与「能力 URL」下载)、对话造图的会话控制器(记忆 / 持久化 / 看图态切换)、后端对话系统提示词与 `{action, reply, prompt, scene}` 归一化、由模型判断生成时机与反问策略、前端语音对话 UI、ASR↔TTS 语音打断(barge-in)与回声过滤联动、Seedream 接入与展示。

## 目录结构

```
/frontend   前端(语音对话 UI:ASR + TTS + 会话控制 + 结果展示)
/backend    后端(火山方舟代理:/api/chat + /api/generate;登录鉴权 + 会话/图片 SQLite 持久化:server.js + store.js)
/docs       设计文档
```

## Demo 视频

> 随开发补全(B站 / 云盘链接,可播放)。
