// R6：私有媒體（member-media／self-photos／feedback-media）必須在**所有**節點 compose 裡
// 都掛到同一份共享儲存。
//
// 為什麼要有這一條守衛：web-A 與 web-B 是 HAProxy 輪詢的同一組後端，`DATA_DIR` 本身是
// **節點本機**目錄。只要有一個節點的 compose 漏掛某個私有媒體目錄，就會出現
// 「A 台上傳、B 台 404」，而且跨節點清理會刪掉 metadata 卻留下另一台的孤兒檔。
// 2026-09-24 已經為 member-media／self-photos 做過一次，2026-10-01 補 feedback-media。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");

const PRIVATE_MEDIA = ["member-media", "self-photos", "feedback-media"];

test("R6：三份 compose 都要把三個私有媒體目錄掛到共享儲存", () => {
  const files = [
    // 正式站的 compose 用 `${V3_MEDIA_ROOT:-/mnt/5151-media}` 這個可覆寫前綴，
    // 所以比對字串要容許該寫法（只認掛載目的地 `/data/<dir>` 才是重點）。
    { path: "docker-compose.yml", root: "(?:\$\{V3_MEDIA_ROOT:-)?/mnt/5151-media\}?", label: "正式站" },
    { path: "deploy/shadow-ha/web/web-a/docker-compose.yml", root: "/mnt/5151-media", label: "web-A" },
    { path: "deploy/shadow-ha/web/web-b/docker-compose.yml", root: "/volume1/5151-media", label: "web-B" },
  ];
  for (const file of files) {
    const src = read(file.path);
    for (const dir of PRIVATE_MEDIA) {
      assert.match(
        src,
        new RegExp(`${file.root}/${dir}:/data/${dir}`),
        `${file.label}（${file.path}）少了 ${dir} 的共享掛載`,
      );
    }
  }
});

test("R6：web-B 的 worker service 也要掛同一批目錄（它會跑孤兒清理）", () => {
  const src = read("deploy/shadow-ha/web/web-b/docker-compose.yml");
  // 兩個 service（5151-web-B 與 5151-worker）都要有，否則 worker 掃到的檔案路徑跟 web 不同。
  for (const dir of PRIVATE_MEDIA) {
    const hits = src.split(`/volume1/5151-media/${dir}:/data/${dir}`).length - 1;
    assert.equal(hits, 2, `${dir} 應該在 web-B 與 worker 兩個 service 各掛一次，實際 ${hits}`);
  }
});

test("R6：NFS 斷線救援腳本要涵蓋回饋附件（否則斷線期間寫入的檔案不會被救回）", () => {
  const src = read("deploy/shadow-ha/media-share/mount-guard.sh");
  assert.match(src, /for sub in member-media self-photos feedback-media; do/);
  const loops = src.split("for sub in member-media self-photos feedback-media; do").length - 1;
  assert.equal(loops, 2, "備份與還原兩個迴圈都要涵蓋");
});
