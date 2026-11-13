# MyClaw

面向个人的轻量多 Agent 助理：一个 Linux 常驻程序，多个飞书机器人，Pi Agent SDK，一个 SQLite 数据库。没有容器、Redis、Web 管理后台或多 Agent 协商框架。

## 已实现

- 健康、财务、编程、私人助理四个模板；私人助理可陪练英语和处理日常事务。可增减 Agent，每个绑定独立飞书应用。
- 个人私聊与按应用配置的 owner open_id 白名单。
- 每个 Agent 的人格、工作目录、SDK 会话和长期记忆分开；共享资料显式配置、每次运行重新加载。
- Pi SDK 的真实模型调用、工具执行、历史会话恢复与自动上下文压缩。
- 私聊连续会话；后台定时任务使用独立会话，可查询最近任务结果。
- 自然语言创建/修改/暂停/恢复/删除计划；也有无需模型的命令。
- cron（五段、最小一分钟）和一次性时间，明确时区，错过执行策略、同一计划不积压并发实例。
- 体重与每日累计运动分钟的结构化记录、查询、修正和删除。
- 通过自然语言读写新版飞书 docx 文档和电子表格；文档支持 Markdown 追加/覆盖，表格支持区域读取、追加行和指定区域覆盖。
- 接收并持久化图片、语音和普通文件；图片可传给视觉模型，语音通过本地 FFmpeg + faster-whisper 转写，文件交由 Agent 工具处理。Agent 可用 `send_media` 回传图片、OPUS/Ogg 语音条和普通文件。
- 消息去重、每 Agent 串行、全局并发上限、取消、超时、重启恢复、文字与多媒体回复单独重试。
- 现成 Pi Skill 目录接入；业务功能可继续扩展。
- 模拟运行模式、本地真实模型模式、自动化测试、systemd 示例。

流式卡片、合并转发和卡片内附件、文本转语音、Agent 相互委派和交易执行尚未实现。post 富文本支持标题、正文、链接和图片；如果飞书未在事件中提供语音资源，则无法处理其中的语音。财务助理未内置任何行情供应商；它会明确说明没有实时数据，不能开箱即用盯盘。安装行情 Skill/工具后再建立相应计划。

## 环境

- Linux，Node.js **24.19.0 或更高版本**（建议 Node 24 LTS），npm。
- 网络可访问 npm、飞书开放平台和你选用的模型服务。
- 生产运行不需要开放入站端口；飞书使用向外建立的 WebSocket 长连接。
- 建议用普通专用 OS 账户。编程助理的 shell 拥有这个账户的权限。
- 语音转写需要 FFmpeg、Python 3 和 venv。默认 faster-whisper `base` INT8 模型，首次使用需下载约 142 MB 模型，之后离线运行。

Ubuntu/Debian 安装本地 ASR：

```bash
sudo apt-get install ffmpeg python3-venv
python3 -m venv data/asr/venv
data/asr/venv/bin/pip install -r requirements-asr.txt
```

默认读取 `data/asr/venv/bin/python`，模型缓存到 `data/asr/models/`。可通过 `FASTER_WHISPER_PYTHON`、`FASTER_WHISPER_MODEL` 和 `FASTER_WHISPER_LANGUAGE` 环境变量调整；低内存主机保持默认 `base`，不要直接改用更大型号。Hugging Face 直连不可用时，可在首次下载前设置 `HF_ENDPOINT=https://hf-mirror.com`。

## 先在本地试运行

```bash
npm ci
npm run check
npm run demo
```

演示模式不需要飞书凭据或模型 Key，不联网调用模型，数据单独存到 `data-demo/`。输入：

```text
health /weight 72.3
health /weights
health /exercise 30
health /remind 20:30 该运动了，记得记录今天的运动。
health /schedule list
finance 介绍你的职责
coder /status
exit
```

演示 Agent 只返回明确标记的固定文本，不具备自然语言理解；上述命令会真正写数据库和创建计划。运行时到期的提醒会打印到控制台。验证一次性提醒时，用 `/once` 填写未来一分钟的带时区 ISO 时间。

`npm run smoke` 会在临时目录启动真实应用进程，验证记录、一次性提醒、重启后读回数据和正常退出，不使用你的配置或凭据。

## 配置与启动

```bash
cp config.example.yaml config.yaml
cp .env.example .env
```

编辑 `.env`，填写模型 Key、各飞书应用的 App ID、App Secret、你的 owner open_id。编辑 `config.yaml` 选择模型、人格和目录。默认模型是 Pi 内置目录中的 `anthropic/claude-sonnet-4-5`；你可以使用其他已支持模型，或通过 `modelsFile` 配置兼容接口。

如果还不知道自己的 owner open_id，先填写对应机器人的 App ID 和 App Secret，并暂停正式服务，然后在项目根目录运行：

```bash
node scripts/identify-owner.mjs health
# 其他机器人：
node scripts/identify-owner.mjs finance
node scripts/identify-owner.mjs coder
node scripts/identify-owner.mjs joy
```

在 5 分钟内，把脚本生成的 `pair ...` 文字私聊发给对应机器人。脚本会输出 `HEALTH_OWNER_OPEN_ID=...`（或对应 Agent 的变量），将这一行填入 `.env`。已经配置过时，直接查看 `.env` 中对应的变量即可，无需重复运行。

先只启用健康助理也可以：为其他 Agent 增加 `enabled: false`。关闭的 Agent 不需要凭据；它的待执行任务和数据保留，重新启用后继续处理。

```bash
npm run build
npm run doctor
npm start
```

`doctor` 校验配置、必需凭据是否存在、SDK 能否识别模型；**不验证远端 Key 的有效性或飞书权限**。进程成功启动并不等于每个机器人已连上；查看日志中的 `feishu_connected`。

不接飞书、只测试自己的真实模型时：

```bash
npm run chat -- --config config.yaml
```

该模式无需飞书凭据，仍使用 `data-demo/` 保存会话；工具会实际执行，编程助理仍能修改配置的 workspace。需要完全独立的代码实验时，为它配置临时 workspace。

飞书设置详见 [部署说明](docs/DEPLOYMENT.md)，扩展方法见 [扩展说明](docs/EXTENSIONS.md)。

## 日常使用

向健康机器人发送自然语言：

```text
今天早上体重72.3公斤，帮我记录。
昨天运动了30分钟。
每天早上8点提醒我称体重。
每天晚上20:30检查今天的运动记录，没有运动就提醒我。
每天早上7点半，结合我的目标给我简短的饮食建议。
列出我的定时任务，把运动提醒改到21点。
记住，我比较喜欢散步，不喜欢跑步。
```

配置文档或电子表格权限后，也可以向对应助理发送：

```text
读取这篇文档并总结：https://example.feishu.cn/docx/你的document_id
把下面的会议纪要追加到这篇文档：……
用我提供的新内容覆盖这篇文档：……
读取这个电子表格：https://example.feishu.cn/sheets/你的spreadsheet_token
把今天的体重记录追加到电子表格：……
```

文档功能支持新版 docx 及指向 docx 的 Wiki 链接，写入保留常见 Markdown 格式，不支持图片和旧版 doc。电子表格支持 sheets 及指向电子表格的 Wiki 链接，可读取区域、追加行或覆盖明确指定的区域；多维表格不在支持范围内。覆盖属于破坏性修改，应明确说明目标；失败后请先人工检查再重试。

可以直接发送独立图片、60 秒以内语音或普通文件，然后说“总结这个文件”“把这张图里的表格整理出来”。接收图片最大 10 MB，语音和文件最大 30 MB。语音在本机完成解码和转写，不依赖飞书 ASR 权限；转写失败会明确提示，不会把语音当成已理解。转写只判断语音内容，不等同于英语发音评分。图片理解要求当前模型支持 `image` 输入；纯文本模型只收到本地文件路径，不会声称已看懂图片。

可以让 Agent 回传它在工作区生成或处理的文件，例如“生成一份 PDF 并发给我”。`send_media` 仅允许发送当前工作区和接收附件目录内的文件。语音条只接受 `.opus`/`.ogg` 且需要毫秒时长；MP3、WAV 等可作为普通文件发送。项目不内置文本转语音；用于回传的语音条需自行准备为 OPUS/Ogg。

自然语言解析依赖所选模型。固定命令不调用模型：

| 命令 | 用途 |
| --- | --- |
| `/help` | 所有命令及格式 |
| `/status` | 当前任务、最近状态、发送失败数 |
| `/new` | 开新对话，保留记忆、计划和业务数据 |
| `/stop` | 取消当前任务和当前聊天的等待队列，不暂停未来计划 |
| `/weight 72.3 [YYYY-MM-DD]` | 按 kg 保存体重，默认今天 |
| `/weights` | 最近 30 条体重 |
| `/exercise 30 [YYYY-MM-DD]` | 保存当天累计运动分钟 |
| `/remind 20:30 内容` | 每天定时发送固定文字 |
| `/once ISO时间 内容` | 一次性提醒，时间必须包含 Z 或 +08:00 等偏移 |
| `/schedule list` | 列出当前助理在当前聊天中的计划 |
| `/schedule pause/resume/delete ID` | 暂停/恢复/删除计划（选择其中一个操作） |

复杂计划可以直接传 JSON：

```text
/schedule add {"name":"健康日报","cron":"0 21 * * *","timezone":"Asia/Shanghai","action":"agent","prompt":"读取今天体重和运动记录，给出简短总结；没有记录时请说明，不编造。","misfire":"latest"}
```

修改：`/schedule update <完整ID> <完整计划JSON>`。`update` 要提供完整新配置，不改变计划原有暂停状态。暂停/删除不取消已经入队的任务；需要时另发 `/stop`。

同一天同一种健康记录只有一个值，新的明确记录会替换旧值；运动分钟是**当天累计**，不是每次运动的增量。自然语言工具支持查询、纠正和删除。暂不保留测量版本审计或多次日内测量。

## 数据与运行语义

生产状态存储在 `data/`，包括：

- `myclaw.sqlite`：消息去重标记、会话映射、任务、计划、发送队列、健康记录、工具回执。
- `agents/<id>/memory.md`：该助理的长期记忆。
- `agents/<id>/sessions/`：Pi 持久会话。
- `agents/<id>/workspace/`：默认工作目录。
- `agents/<id>/attachments/incoming/`：下载的图片、语音和文件；不会自动清理，备份和清理时需一并考虑。
- `agents/<id>/pi/`：每 Agent 的 SDK 配置/认证状态位置。

人格位于 `agents/<id>/persona.md`，共享资料位于 `shared/`，所有 Agent 自动加载 `shared/skills/` 下的共享 Skill；人格、记忆、共享资料和 Skill 内容在每次执行重新读取，模型和应用配置修改后需重启。

默认同一 Agent 同时一个任务，整个程序最多两个。普通聊天优先于待执行的后台任务；固定文字提醒直接进入发送队列，不占 Agent 运行名额。

自然语言任务入库后会在原消息上添加 `Get` 表情，不再发送单独的“已接收”文字；对应正式回复全部发送成功后撤回该表情。命令仍直接发送文字回复。

### 重启、重试与停止

- 已收到并入库但未开始的任务重启后继续；正在执行的任务标记 `interrupted`，告知用户，不自动重跑。
- 完成后的回复先入 outbox；发送失败只重试回复，不重跑 Agent。
- 飞书发送使用稳定 UUID。最多自动重试 8 次；若距首次发送尝试已超过 50 分钟，转为人工核对，避免跨越飞书一小时去重窗口盲目重发。它仍不是跨系统的严格 exactly-once。
- `/stop` 与超时依赖 SDK/工具响应取消。已产生的外部效果不回滚；不能及时取消的工具可能继续占用该 Agent。服务关闭 20 秒后强制退出，systemd 最终终止整个进程组。
- 工具调用数量限制是 SDK 事件上的运行保护，不是硬预算计费上限。
- 定时 `skip`：超过 `graceSeconds`（默认 120 秒）的错过触发跳过。`latest`：恢复后至多补最近一次，不回放所有历史时点。
- 同一计划已有 queued/running 任务时，新的时点跳过，避免积压。其他计划依然可以排队。
- cron 只表达时间，不代表交易日历。市场节假日/盘中判断应由行情 Skill/工具完成。
- 单实例：程序用目录锁拒绝共享同一数据目录的第二个实例。异常退出后旧锁可能需要约 30 秒失效，不要运行多个副本。

## 测试与实际验证边界

运行 `npm run check` 构建并测试；`npm run smoke` 做真实进程演示验证。

测试包含消息去重、私聊身份过滤、每 Agent 串行和跨 Agent 并发、取消、时区/夏令时、定时任务管理与去重、恢复策略、回复重试、健康数据和记忆分离。多媒体测试覆盖事件解析、资源下载、语音转写、附件持久化、发送路径限制，以及图片/语音/文件上传和消息创建，均使用模拟飞书客户端与临时本地文件。文档测试覆盖链接校验、Wiki 解析、读取、Markdown 转换、追加、覆盖、内容分批和写入回执；电子表格测试覆盖链接与 Wiki 解析、区域读取、追加、指定区域覆盖和写入回执。Pi 集成测试实际创建 SDK Session，通过本地 OpenAI 兼容 HTTP/SSE 模拟端点执行健康工具，并验证会话恢复与共享资料更新。

自动化测试默认不使用真实飞书应用或付费模型 Key。本次已用真实飞书应用和实际模型配置完成 coder 与 finance 私聊、`Get` 表情及正式回复联调；这不代表对所有模型任务质量的评价。部署后请先按部署文档的验收步骤验证。所有依赖版本已固定在 `package-lock.json`。

## 边界

这是信任宿主机与操作者的个人应用。工作目录、工具清单和人格提示不构成 OS 隔离；拥有 shell 的助理能以运行账户权限访问文件和网络。外部 Skill 也应视为可执行的受信任扩展。服务没有默认开放的 HTTP 管理接口。

业务数据、会话内容和工具结果是本地明文文件；发送给模型的上下文会进入配置的模型服务。通用日志只记录任务 ID、状态和错误类型，不打印完整聊天、API Key 或 SDK 请求对象。数据没有自动清理，需按自己的保留要求备份和整理。

## 上游参考

- [Pi SDK](https://pi.dev/docs/latest/sdk)
- [Pi 模型配置](https://pi.dev/docs/latest/models-configuration)
- [飞书 Node SDK](https://github.com/larksuite/node-sdk)
- [飞书接收消息事件](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive)
- [飞书发送消息](https://open.feishu.cn/document/server-docs/im-v1/message/create)
