#!/bin/sh
set -eu
# 日常更新：把 src/public 拷到這台機器後，Node --watch 會自己重載。
# 只有改到 compose 掛載或啟動指令時才需要跑這支。
cd /mnt/Storage1/apps/5151
docker compose up -d --no-build --no-deps 591-tracker
