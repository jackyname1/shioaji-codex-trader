# 回測引擎修復：第二階段工程紀錄

本紀錄延續 PR #43，尚未宣告全部驗收或策略具備正期望值。不得啟用正式下單。

## 已實作

- `authorizedRisk` 將舊設定的零單筆風險上限恢復為 1%，保留更嚴格正值；共用成本檢查不能因 `min_entry_reward_risk=0` 跳過負淨收益與必要保護。
- `remainingBuyCost` 共用尚未成交本金及增量手續費上界。部分成交已付最低手續費，不再保留另一筆最低費；成交價格改善時保留值仍是保守上界。
- SDK 與直接啟用共用明確時區格式驗證。未標時區的快照不能依 Windows／Linux 本機時區解讀；已知無效回覆保留最後有效策略。
- 實際程式分支記錄八階段 Entry Funnel。唯一鍵為策略／股票，五分鐘掃描、兩種 lot、跨日未成交重掛不重算；曾通過、無此要求、曾阻擋、未觀測分開。拒絕原因可重疊，容量遺失會使回測 PARTIAL。
- FIFO 完整交易統計改從成交價、股數、費用重算。新增執行報價快照與交易歸因，拆出費稅、未加情境的報價差，以及模型價格影響；後者含設定滑價、情境加價、tick rounding，並非實測滑價。未保存的舊報價維持 null。選股與市場因果不能只由成交識別，不捏造市場 alpha 或 K 線內 MFE/MAE。
- 觀測變更增加 SQLite 完整事件帳，不再把 UI 的 120 筆顯示環形緩衝當成完整歷史。
- 結果頁加入回撤、累積費稅、曝險圖、交易歸因、出場方式、漏斗與拒絕碼。12 種匯出包括完整 JSON、成交、訂單、完整交易、每日淨值、失敗、漏斗、拒絕原因、策略、AI 紀錄、歸因 CSV 與診斷 Markdown。Windows GUI smoke 必須實際檢查入口與全部 12 種 IPC 匯出。
- 新報表保存完整有效設定及資料內容 SHA256，與行情保存 UUID 分開。舊報表缺漏的設定不能假裝完整。
- `FrozenDecisions` / `scripts/replay-export.mjs` 重播原始模型回覆。僅核對原始快照／request ID 後明確重綁新 ID，期限、價位、股數與條件均不修改；沒有對應時間的決策、原始 ID 錯誤、缺輸出均拒絕，不改用未來回覆或新模型。原始報表原樣另存，輸出綁定及內容雜湊。
- 移除連線恢復／模式選擇的自動實盤授權。本版沒有獨立樣本外、足量樣本、成交穩健性及 Shadow 證據，因此 trade scope 明確阻擋 `LIVE_VALIDATION_PENDING`，沒有設定或環境變數可勾選通過。撤單 scope 經帳戶／CA／交割等原檢查與明確動作後仍可用；停止與重啟仍撤銷記憶體授權。這是本版的停用保障，尚非完成可自動簽發資格的驗證平台。

## 驗證進度

- Linux 完整 TAP 檢查（加入 frozen replay 前）：436 個測試，435 通過、0 失敗；1 個既有原生執行環境測試依既有規則在受管理主機跳過，須由乾淨 CI 跑完。
- 新增重播、圖表序列、完整觀測帳及成本研究檢查：8/8 通過。最終完整測試與 Windows 來源／封裝 GUI 以本次最新提交的 CI 為準。
- 既有三組公開日線帳務回歸保持相同經濟結果，全部獨立核對通過；近期中性 0bps 扣期末估計出場成本仍虧 92.80，保守日線零成交。
- 固定七組 ablation × 三情境 × 兩個已研究期間共 42 組已執行，全部帳務核對通過；未挑選最佳結果或啟用研究設定。完整摘要另附在 validation/repair-20261023。

## 必須保留的阻礙

工作環境目前只有 v0.1.3 的舊附件，缺少本次 v0.1.5 的兩份原始 JSON 與同次完整行情。不能替代獨立重算原始 14 筆交易、判定 9/9 真正完整呼叫根因、重現原始 64 日 PARTIAL 的全部原因，也不能用程式策略代理冒充原始 AI 策略重跑。

2026/07/22–10/22 已用於診斷；既有十檔公開日線面板也已研究，不稱為新 OOS。正在補取官方 2023–2024 橫斷面；歷史證券主檔、零股簿、排隊、公司行動調整與 OTC 仍有限制。沒有使用者正式交易授權，沒有真實下單。既有使用者電腦上的舊程式不在本工作階段控制範圍，不能宣稱已遠端關閉。

## 後續故障重現與修正

- CI 39831405709：Linux／Windows 單元檢查通過，但 `npm run demo` 失敗。固定合成 200 股於當輪較高價格超過既有單筆本金上限；改依原限額決定合成參考股數，增加 `cli-demo.test.ts`，實際部分成交驗證通過。未降低費用、報酬風險要求或交易限制。
- CI 39832395725：Linux 全流程通過，Windows 439/439 測試通過；來源 GUI 在即時模擬現金一致性檢查失敗。根因為畫面及系統匣仍各自使用舊保留公式，部分成交重扣最低費。新增無 Node 依賴的精確 BigInt 十進位 `buy-reservation.ts`，引擎及兩個畫面共用；不以刪除 GUI 現金斷言處理。新增 tick／費用 rounding／多筆掛單核對。
- 2023/08/03 年度表沒有涵蓋卡努颱風停市。取得交易所 2023/08/02 新聞稿，確認市場休市及交割順延：<https://investoredu.twse.com.tw/FileSystem/FileUpload/be0109d1-76a0-4412-a00d-58a88c6e1714.pdf>，SHA256 `13e991f1b4b97c7e9e1e6b39b5a20b0fa5134f82b3de8fd7393baa54f0c9f126`。以該日午夜作保守可見邊界，不讓 8/2 盤中偷知未公開的例外；新增行事曆刷新與 T+2 投影回歸。不是只憑沒有 K 線就改休市。
- 公司行動／價格不連續旗標下的隔夜庫存未提供股利、權益或股數調整事件。即使後續價格恢復新鮮，損益仍可能錯誤。新增逐日開盤前庫存診斷，標記 `UNRESOLVED_CORPORATE_ACTION`／PARTIAL，保留所有原始成交；不創造股利、分割比例或更動價格。此診斷只影響完整性判定，不作交易決策資訊。無旗標的未知公司行動仍屬資料供應限制。
- 失敗 CSV 及畫面列出估值／公司行動／缺交易日／診斷截斷／中止的時點、階段、錯誤碼。實際 Windows GUI 另核對八階段數字、交易歸因筆數及三張圖與同份報表一致。

### 研究旗標的實際作用

| 設定 | 關閉的作用 | 不會關閉的必要檢查 |
|---|---|---|
| portfolio_risk_enabled=false | 不以研究用高點回撤、股票池市場代理及連敗縮減新增配置 | 現金、單筆、單檔、總曝險、單日、1% 風險與成本 |
| entry_quality_enabled=false | 不用研究評分重排候選 | 資料、候選資格、條件、合法限價、淨收益與風險核對 |
| dynamic_allocation=false | 不額外依目標曝險缺口重新縮減配置 | 原定本金及股數上限；不強制把 50% 軟目標填滿 |
| research_cost_aware=false | 不額外要求淨目標收益至少為預估費稅兩倍 | 雙邊成本後正收益、有效停損／目標、設定的淨 RR 與 1% 風險 |

### 主要回歸對應

| 項目 | 測試 |
|---|---|
| 9/9、7/22、明示時區、錯誤碼與原策略保存 | strategy-admission.test.ts、plan-lifecycle.test.ts |
| 費用、現金、部分成交保留、風控零設定 | cost-reservation.test.ts、buy-reservation.test.ts、capital-policy.test.ts |
| 原始 FIFO 與執行歸因 | trade-attribution.test.ts、backtest-audit.test.ts |
| 唯一八階段與完整觀測歷史 | entry-funnel.test.ts、watch-journal.test.ts |
| 不使用未來決策、原始回覆不可修補 | frozen-decisions.test.ts、replay-pipeline.test.ts |
| 公司行動、估值及不完整錯誤碼 | corporate-action.test.ts、strategy-admission.test.ts、backtest-export.test.ts |
| 休市可見性及 T+2 | calendar-evidence.test.ts、v023-optimization.test.ts |
| 正式交易停用、撤單、重啟不授權 | live-session.test.ts、startup-recovery.test.ts |
| 畫面與 12 匯出 | backtest-export.test.ts、backtest-series.test.ts、Windows source/packaged smokeTest |
