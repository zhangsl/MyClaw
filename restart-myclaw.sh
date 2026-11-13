#!/usr/bin/env bash
set -euo pipefail

readonly service="myclaw.service"
readonly trigger="/opt/myclaw/data/restart-request"
readonly delay_seconds=10

if (( EUID != 0 )); then
  /usr/bin/touch "$trigger"
  echo "已提交 ${service} 重启请求，将由独立的 systemd 单元处理。"
  exit 0
fi

/usr/bin/systemctl cat "$service" >/dev/null
/usr/bin/systemd-run \
  --on-active="${delay_seconds}s" \
  --description="Delayed restart of ${service}" \
  /usr/bin/systemctl restart "$service"

echo "已安排 ${delay_seconds} 秒后重启 ${service}，当前进程可以正常结束。"
