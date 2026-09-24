#!/bin/bash
# 5151 媒體共享：確保 /mnt/5151-media 的 NFS 掛載存在。
#
# 為什麼需要它：Docker 的 bind mount 在「掛載變動」後仍指向舊目錄 —— 若 NFS 斷線後被重掛，
# 容器會繼續寫入本機空目錄（媒體靜默分歧，兩台看到的檔案不同）。這支守護程式：
#   1. 偵測未掛載 → 先把「本機寫入的檔案」救到 /var/lib/5151-media-rescue/<時間>/
#   2. 重新掛載
#   3. 把救出的檔案送回共享目錄
#   4. 重建容器（讓 bind mount 重新指向真正的共享目錄）
# 由 5151-media-mount-guard.timer 每 2 分鐘執行一次（掛載正常時直接結束，不做任何事）。
set -u

MOUNT=/mnt/5151-media
SRC="192.168.0.220:/volume1/5151-media"
RESCUE=/var/lib/5151-media-rescue
LOG=/var/log/5151-media-mount-guard.log
CONTAINERS="591-tracker-v3 5151-web-A"

log() { echo "$(date -Is) $*" >> "$LOG"; }

if findmnt -no SOURCE "$MOUNT" >/dev/null 2>&1; then
  exit 0
fi

log "WARN: $MOUNT 未掛載，開始處置"
STAMP=$(date +%Y%m%d-%H%M%S)
mkdir -p "$RESCUE/$STAMP"

# 1) 掛載前先救出「本機寫入」的檔案（掛載後會被遮蔽）
for sub in member-media self-photos; do
  if [ -d "$MOUNT/$sub" ]; then
    mkdir -p "$RESCUE/$STAMP/$sub"
    if command -v rsync >/dev/null 2>&1; then
      rsync -a "$MOUNT/$sub/" "$RESCUE/$STAMP/$sub/" >>"$LOG" 2>&1 || true
    else
      cp -a "$MOUNT/$sub/." "$RESCUE/$STAMP/$sub/" >>"$LOG" 2>&1 || true
    fi
  fi
done
RESCUED=$(find "$RESCUE/$STAMP" -type f 2>/dev/null | wc -l)
log "已備份本機檔案 $RESCUED 個到 $RESCUE/$STAMP"

# 2) 重新掛載
if ! mount "$MOUNT" >>"$LOG" 2>&1; then
  log "ERROR: 重新掛載 $SRC 失敗（將於下一輪重試）"
  exit 1
fi
log "重新掛載成功"

# 3) 把救出的檔案送回共享
for sub in member-media self-photos; do
  if [ -d "$RESCUE/$STAMP/$sub" ]; then
    cp -an "$RESCUE/$STAMP/$sub/." "$MOUNT/$sub/" >>"$LOG" 2>&1 || true
  fi
done

# 4) 容器必須重建，否則 bind mount 仍指向舊目錄
for c in $CONTAINERS; do
  if docker restart "$c" >>"$LOG" 2>&1; then
    log "已重啟容器 $c"
  else
    log "ERROR: 重啟容器 $c 失敗"
  fi
done
log "處置完成"
