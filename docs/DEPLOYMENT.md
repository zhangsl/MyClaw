# Linux 部署

## 1. 准备程序

安装 Node 24 LTS（本项目测试版本为 24.19.0），确认 `node --version`。安装方法按你服务器的发行版选择。

把源码包解压并放到 `/opt/myclaw`，以下命令中路径需要与实际一致：

```bash
sudo useradd --system --create-home --home-dir /var/lib/myclaw --shell /usr/sbin/nologin myclaw
sudo chown -R myclaw:myclaw /opt/myclaw
cd /opt/myclaw
sudo -u myclaw npm ci
sudo -u myclaw npm run build
sudo -u myclaw cp config.example.yaml config.yaml
sudo -u myclaw cp .env.example .env
sudo chmod 600 .env config.yaml
```

如果账户已经存在，跳过 `useradd`。应用和 SDK 需要写入数据目录及工作目录；编程仓库另设 workspace 时，也需赋予该账户对应的目录权限。

## 2. 创建飞书应用

为三个助理分别创建企业自建应用，分别开启机器人能力。第一轮可只启用 health。

每个应用：

1. 记录 App ID 和 App Secret，填入 `.env` 对应变量。
2. 开通读取用户发给机器人的单聊消息 `im:message.p2p_msg:readonly` 和以应用身份发消息 `im:message:send_as_bot`；以后台当前权限提示为准。
3. 如需读取文档，开通 `docx:document:readonly`；如需追加或覆盖文档，开通 `docx:document`。电子表格读取使用 `sheets:spreadsheet:readonly`，写入使用 `sheets:spreadsheet`。如需通过 Wiki 链接访问文档或电子表格节点，再开通 `wiki:wiki:readonly`。权限名称以当前开放平台为准。
4. 事件订阅选择长连接，订阅 `im.message.receive_v1`。若后台要求先建立连接，先启动下一步的身份识别脚本，再回后台保存订阅。
5. 发布应用版本，使用范围包括你本人。首次发布或权限变更可能需要管理员审核。
6. 在飞书找到机器人并发起私聊。
7. 把需要访问的新版 docx 文档或电子表格共享给对应应用，读取授予可阅读权限，写入授予可编辑权限。仅开通 API 权限但没有文档协作权限仍会返回权限错误。

这是有 App ID/Secret 的应用机器人，**不是群聊自定义 Webhook 机器人**。

## 3. 识别自己的 open_id

owner open_id 是应用相关的，每个机器人分别取得。提供的识别脚本只接收消息，不执行 Agent，也不向任何人发送消息。

```bash
cd /opt/myclaw
sudo -u myclaw node scripts/identify-owner.mjs health
```

脚本打印随机配对文字。把这行文字私聊发给健康机器人，脚本打印 `HEALTH_OWNER_OPEN_ID=...`，复制到 `.env`。

依次为其他机器人运行：

```bash
sudo -u myclaw node scripts/identify-owner.mjs finance
sudo -u myclaw node scripts/identify-owner.mjs coder
```

识别脚本和正式服务不要同时连接同一应用；长连接推送不是广播。

也可以通过飞书官方 API 调试工具取得该应用下你的 open_id，再手动填写。不要把其他应用的 open_id 直接复用。

## 4. 模型及前台验证

填写 `.env` 的 `ANTHROPIC_API_KEY`，或者修改 `config.yaml` 使用你实际的模型供应商及认证变量。Key 保留在服务器，不用发给聊天助手。

```bash
sudo -u myclaw npm run doctor
sudo -u myclaw npm start
```

看到每个机器人的 `feishu_connected` 日志后，按顺序检查：

1. 健康私聊 `/help`，确认回复。
2. `/weight 72.3`、`/weights`，确认记录；这是测试值，验收后通过健康助理要求删除或更正。
3. 用自然语言发一条真实记录，确认模型调用健康工具成功。
4. 用 `/once` 设置未来一分钟的提醒，等待主动消息。
5. 建立每日运动提醒，用 `/schedule list` 检查时区和下次执行时间。
6. 在 finance 发一句介绍职责，确认它没有看到健康助理的私有记忆。
7. 在 coder 要求在工作区创建一个测试文件，再检查真实文件。
8. 用一篇可编辑的测试 docx 文档验证读取、追加和读回；覆盖测试只在可丢弃文档上进行，并检查格式与最终内容。
9. 用一个可编辑的测试电子表格验证区域读取、追加和读回；指定区域覆盖只在可丢弃表格上进行。
10. 正常停止并重启程序，确认健康记录、计划和多轮对话仍然存在。

默认不自动创建任何日程，避免在你尚未选定时间和内容时就发送提醒。

## 5. systemd 常驻

查看 `command -v node`，确保 `deploy/myclaw.service` 的 `ExecStart` 指向实际 Node 路径。systemd 不会加载交互式 shell 的 nvm 设置；推荐系统级固定路径。

```bash
sudo cp deploy/myclaw.service /etc/systemd/system/myclaw.service
sudo systemctl daemon-reload
sudo systemctl enable --now myclaw
sudo systemctl status myclaw
sudo journalctl -u myclaw -f
```

该服务按你要求直接运行在 Linux 上，没有容器文件系统隔离。修改配置后：

```bash
sudo systemctl restart myclaw
```

## 6. 备份与升级

为获得 SQLite、SDK 会话和工作区一致的备份，先停止服务：

```bash
sudo systemctl stop myclaw
sudo tar -czf /var/backups/myclaw-backup.tar.gz -C /opt/myclaw data agents shared config.yaml .env
sudo chmod 600 /var/backups/myclaw-backup.tar.gz
sudo systemctl start myclaw
```

备份包含私有数据与 Key，妥善保管。外部 workspace（例如 `/srv/projects/...`）不包含在上述命令中，需要另外备份或交给 Git 管理。运行时不要只复制主 `.sqlite` 文件而漏掉 WAL。

升级时保留 `data/`、`.env`、`config.yaml`、修改过的 persona 与 shared/skills 内容；更新代码和依赖后构建、测试再启动。不建议未经验证直接升级 Pi 的大版本，SDK 的 API 会变化。

## 7. 排查

| 现象 | 检查 |
| --- | --- |
| 缺少环境变量 | `.env` 是否放在工作目录；Agent 是否应该 disabled |
| 未知模型 | provider/id 与 SDK 模型目录一致，或配置 modelsFile |
| 服务启动但没有连接日志 | 飞书凭据、应用状态、出站网络、代理配置 |
| 有连接但不响应 | 发布版本与权限、事件订阅、owner open_id、是否私聊、是否另一实例抢收事件 |
| 固定命令正常，自然语言失败 | 模型 Key、余额/额度、供应商网络、模型 ID |
| 没有按时提醒 | `/schedule list` 的启用状态、时区、下次时间；服务是否持续运行 |
| 旧提醒没有补发 | 默认 skip 超过 120 秒的时点；需要日报补发时用 latest |
| Database/目录锁已占用 | 是否同时运行正式服务、demo、维护脚本；异常退出后等待锁过期 |
| SDK 会话文件丢失 | 恢复完整备份；确实要放弃该对话时发 `/new` |
| `/status` 显示发送失败 | 停服后使用下面的 outbox 维护命令 |

为避免凭据及健康内容出现在日志里，SDK 原始错误对象不会整段打印。必要时先在控制台模式验证模型，并通过供应商后台检查请求失败原因。

检查失败回复：

```bash
sudo systemctl stop myclaw
sudo -u myclaw node scripts/admin.mjs failed config.yaml
```

核对该回复确实没在飞书出现后，可人工重试指定 outbox ID：

```bash
sudo -u myclaw node scripts/admin.mjs retry config.yaml <outbox-id>
sudo systemctl start myclaw
```

重试只投递已保存回复，不执行 Agent。跨越平台去重窗口的人工重发可能重复，先核对。
