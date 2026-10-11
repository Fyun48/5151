## mutation-check（2026-10-12）

```
$ node v3/scripts/mutation-check.mjs v3/test/notify-flush-settings.test.js
[OK  ] flush 的逐會員設定改讀本機（暫停通知的會員照樣被通知）
       預期殺手「暫停旗標以 PG 為準」→ 已失敗 ✓
[OK  ] flush 的信箱改讀本機（寄到舊的／空的信箱）
       預期殺手「不得再用同步的」→ 已失敗 ✓
[OK  ] flush 不把 options 轉發給佇列（測試／探針注入無效）
       預期殺手「讀注入的 PG runner」→ 已失敗 ✓
[OK  ] flush 的站台設定改讀本機（整個迴圈用別台節點的設定決定通知）
       預期殺手「不得再用同步的」→ 已失敗 ✓

共 4 條變異：KILLED 4、SURVIVED 0、SKIP 0
EXIT=0

$ node v3/scripts/mutation-check.mjs v3/test/listing-enrich-parity.test.js
       預期殺手「注入式 exec 的形狀不影響結果」→ 已失敗 ✓

共 5 條變異：KILLED 5、SURVIVED 0、SKIP 0
EXIT=0
```

## 新測試的牙齒（逐條把改動反向，`v3/test/background-aux-diet.test.js` 必須紅）

`bash v3/evidence/background-aux-diet-20261012/teeth-check.sh`（就地改寫來源、跑測試、還原；
跑完 `git status --porcelain` 必須是空的）：

| 變異 | 結果 |
|---|---|
| seed 改回逐列 `WHERE post_id = $1` | 紅（第 1 條） |
| 通知去重改回逐會員版 | 紅（第 4／5／7 條） |
| flush 不再把當輪 settings 往下傳 | 紅（第 8 條） |
| 通知入列的裝飾不再共用當輪 settings | 紅（第 4 條） |

變異 1～3 直接把改動反轉；變異 4 拿掉 `preloadDecorationProviderAsync({ …, requestContext })`
裡的 `requestContext`。四條都必須紅，否則那條改動就沒有牙齒。
