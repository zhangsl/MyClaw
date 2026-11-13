---
name: restart-myclaw
description: 安排重启整个 MyClaw 服务。仅在用户明确要求重启 MyClaw 时使用，需要 bash 工具。
---

# 重启 MyClaw

当用户明确要求重启 MyClaw 服务时，使用 bash 执行 `/usr/local/sbin/myclaw-restart`。

不要直接执行 `systemctl restart myclaw`、`kill` 或使用 `nohup` 后台重启。该命令会请求独立的 systemd 单元安排延迟重启，避免当前 Agent 进程先终止重启命令。

重启会中断所有 Agent 正在执行的任务。命令成功后立即回复已安排重启，不要继续执行其他工具，也不要声称服务已经完成重启。命令失败时如实返回错误。
