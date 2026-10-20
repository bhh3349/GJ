#!/bin/sh
# SUB 网关每日备份（宿主机 crontab 调用）。
#
# 用法（crontab -e）：
#   30 3 * * * /opt/sub/backup.sh >> /var/log/sub-backup.log 2>&1
#
# 三个坑（都实测过）：
# 1. 卷名 `sub_sub-gateway-data` 带 compose 项目名前缀 —— `sub-gateway-data` 是
#    另一个（空）卷。核对方法：docker inspect <容器> --format '{{range .Mounts}}{{.Name}}{{"\n"}}{{end}}'
# 2. --network none：备份不需要网络，少一个面。
# 3. 挂 deploy/snapshot.cjs 进去跑而不是 node -e：引号嵌套在 sh + docker + node
#    三层之间必炸（实测 SyntaxError），脚本文件化后三层只剩一层。
set -e
OUT=/opt/backups
STAMP=$(date +%F)
mkdir -p "$OUT"
docker run --rm --network none \
  -v sub_sub-gateway-data:/data \
  -v /opt/sub/snapshot.cjs:/snapshot.cjs:ro \
  -v "$OUT":/out \
  sub-gateway:local node /snapshot.cjs "/out/gateway-$STAMP.db"
# 保留最近 14 天
find "$OUT" -name 'gateway-*.db' -mtime +14 -delete
echo "backup done: $OUT/gateway-$STAMP.db"
