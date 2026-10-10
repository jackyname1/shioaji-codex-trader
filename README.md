# Shioaji Codex Trader（全 TypeScript）

Windows 系統匣程式，開啟後是簡潔的文字介面：總覽、策略與觀測、模擬測試、設定。參考 Shioaji Pro 的觀測、條件單與委託回報流程，以低頻 Codex 策略與短間隔交易引擎執行。

應用程式、交易引擎、Codex 整合、Electron 介面、測試及打包腳本全部使用 TypeScript。透過 **Shioaji 官方 HTTP API + SSE** 連接券商，沒有自製 Python 橋接程式。官方原生 `shioaji` 服務與 Codex 原生執行檔是外部依賴。

預設為 `demo`，自動執行與真實下單均關閉。DEMO 只使用虛構代碼、行情、資金及成交。程式不提供獲利保證；完成程式測試不代表已驗證你的券商帳戶或實際成交。

## 功能

| 部分 | 行為 |
|---|---|
| 桌面 | Electron 文字視窗、系統匣、關閉／最小化隱藏、點圖示重開、系統匣暫停與停止 |
| 模式 | DEMO 虛構行情、READONLY 帳戶唯讀、PAPER 真實行情＋模擬資金、LIVE 實盤；資料庫各自獨立 |
| 動態股票池 | Shioaji 成交金額、成交量、漲跌幅排行榜合併，過濾非普通股票、暫停／處置股及注意股 |
| 選股 | Codex 每輪列出 5–20 檔候選（不超過本機觀測上限）；可全部 HOLD，沒有固定買進名單 |
| 自動觀測 | 每 5 分鐘篩選；預設最多 12 檔。不符條件停止新買進，連續 3 次不符才移除；持倉／掛單另保留監控 |
| 分析資料 | 已完成日 K、MA5/20/60、簡單 RSI14（不是 Wilder 平滑）、ATR14、量比、20 日支撐壓力、月營收、重大訊息 |
| Codex | 官方 TypeScript SDK，獨立分析設定目錄、唯讀 sandbox、禁用網路工具，schema 與快照／效期核對 |
| 定時分析 | 預設台北時間 09:15、11:45 更新策略，14:00 檢討；可選自訂固定時刻或較長間隔。每個排程持久化，重啟不重複執行 |
| 條件偵測 | 預設每 3 秒檢查行情、進場與停損；Codex 分析在背景，持倉監控不中斷 |
| 規則進場 | Codex 可設定趨勢／突破／回測均線及選股門檻，程式替新觀測股計算股數與保護價，再檢查硬性風控；每檔每輪一次 |
| 智慧條件 | 限價、立即／價格以下／價格以上進場、停損、停利、移動停損；既有停損不得由 AI 放寬 |
| 零股 | `IntradayOdd`，1–999 股，現股 `Cash`、限價 `LMT`、當日有效 `ROD`；不用盤後零股 |
| 不當沖 | 核對庫存明細取得日及股數單位；今日新增股數不會用於 SELL，舊庫存可賣 |
| 歷史回測 | 指定起訖日期、資金及整股設定；虛構示範、歷史 CSV 或 Shioaji 歷史分鐘 K 線，獨立帳戶完整重播 |
| 回測損益 | 手續費、交易稅、FIFO 已實現／未實現損益、T+2 賣款限制、最大回撤、逐日資產與 JSON／CSV 匯出 |
| 自動比較 | 同一資料與初始資金，依序比較多組策略間隔；Codex 呼叫額度由整批共用，每組帳戶與經驗獨立 |
| 經驗回饋 | 保存成交、拒絕與盤後檢討供下輪 Codex 參考；按模式及虛擬日期隔離，不自動訓練模型或放寬風控 |
| 委託 | 送單前持久化、部分成交、重啟核對、外部掛單預留資金、未知委託凍結，不盲目重送 |
| 保護出場 | 零股每筆最多 999 股；啟用整股時先按 1000 股倍數賣出舊庫存，再處理零股餘數；撤單確認後才重掛 |
| 保存 | SQLite WAL、完整同步寫入、單一寫入佇列、程序鎖、計畫／保護／事件紀錄持久化 |
| 操作 | 暫停買進、緊急停止新委託、逐筆／本程式全部撤單、手動核對、立即分析與盤後檢討 |
| 行事曆 | 官方 TWSE 開休市；附 2026 核對資料，連線模式自動取得缺少年度；未知交易日禁止委託 |

僅開放上市櫃普通現股，禁止融資、融券、借券、當沖及槓桿／反向 ETF。整股預設關閉，啟用後仍須為 1000 股倍數。其他券商 API 功能（期貨、選擇權、借券、保留額度等）沒有開放給交易策略。

## Windows 啟動

1. 到 [v0.4.0 Release](https://github.com/jackyname1/shioaji-codex-trader/releases/tag/v0.4.0)。私有儲存庫需登入有權限的 GitHub 帳號。
2. 下載 **Shioaji-Codex-Trader-0.4.0-Windows-x64.exe**，直接開啟。
3. 在「模擬測試」設定日期、資金、策略時間、偵測秒數與觀測間隔，保留虛構行情／流程示範，按「開始全自動測試」。
4. 按「自動比較時間間隔」可依序測試 60、120、180 分鐘，可修改各組數值。結果可保存、切換及匯出。
5. 即時 DEMO 按「啟動全自動」。非交易時間不會送模擬委託；歷史測試可隨時使用。真實行情、Codex 與實盤需完成以下本機設定。

Portable EXE 包含 Electron、Node.js 及應用程式。下載檔沒有程式碼簽章，Windows 可能要求確認來源。資料保存於 Electron 的本機使用者資料目錄 `Shioaji Codex Trader/state/`；portable 解壓位置不是資料保存位置。

開發者可用 Node.js **24 以上**：

```powershell
git clone https://github.com/jackyname1/shioaji-codex-trader.git
cd shioaji-codex-trader
npm ci
npm test
npm run demo
npm start
```

`npm run demo` 使用固定的虛構交易時間驗證下單、成交及今日不可賣流程，完全不連券商或 Codex。測試也不使用真實帳戶。

## Shioaji 官方本機服務

需在實際使用電腦安裝官方原生 `shioaji` CLI／HTTP 服務。不需要安裝或執行本專案的 Python 程式。

依 [官方其他語言安裝說明](https://sinotrade.github.io/env_setup/other/) 安裝 Windows 版本。官方安裝命令如下，請先在本機核對網址及腳本內容：

```powershell
irm https://github.com/Sinotrade/Shioaji/releases/latest/download/install.ps1 | iex
```

在另一個本機服務目錄建立 `.env`，參考本專案 `.env.example`。於本機填入 `SJ_API_KEY`、`SJ_SEC_KEY`、CA 路徑及 CA 密碼。先使用 `SJ_PRODUCTION=false`；正式服務依官方說明使用 `SJ_PRODUCTION=true` 並啟用有效 CA。

```powershell
shioaji server start
shioaji server status --streams
```

預設服務為 `http://127.0.0.1:8080`。程式只接受本機 loopback 網址，不會把金鑰放入網址、提示詞、SQLite 設定或 GitHub。原生服務依你的本機設定管理券商登入；本應用程式不登入或登出整個共享服務。

預設啟用「管理行情訂閱」，觀測股移除後會釋放本程式曾要求的 Tick／BidAsk；持倉、未成交委託與智慧保護仍保留。官方端點沒有每個客戶端獨立訂閱所有權，因此自動輪替請使用專用本機服務。若與 Shioaji Pro 共用同一服務，先取消此設定：舊訂閱會保留，本程式累積上限 160 個，達上限時停止新增並顯示原因；官方總訂閱上限還包含其他客戶端。斷線重連會重新要求有效訂閱；程式不取消帳戶委託回報。

短間隔監控使用 SSE；一般委託核對讀取原生服務的回報快取，至少每 60 秒重新核對券商。送單前、狀態不明、撤單確認或斷線後強制核對，不會以 3 秒間隔輪詢歷史行情或券商委託狀態。

連接前會核對 `/info`、`/health`、帳戶簽署狀態及 `/openapi.json` 必要端點。API 欄位、CA 狀態或日期無法核對時停止新增委託；不會猜測未知欄位。

在「連線與模式」先切換 READONLY，核對銀行現金、交割款、庫存與可賣股數；再使用 PAPER 驗證行情與策略。設定 `stock_account_index` 選取官方服務回傳的證券帳戶順序。桌面儲存 `base_url`／帳戶序號變更會停止舊連線，切換到該連線的獨立資料庫並關閉自動執行；有未完成委託時禁止變更。帳戶指紋仍須相符，禁止混用。程式記住上次模式；上次為 LIVE 而啟動時沒有 `LIVE_TRADING=true` 則改為唯讀。

PAPER 與 DEMO 成交模型依五檔首檔量模擬部分成交，按委託累計金額計費。PAPER 沒有完整模擬 T+2 入扣款、排隊順位、券商拒單或成交價格；不能作為實際交易能力驗收。PAPER 只用真實行情，不向券商送單。

## Codex 本機登入與設定

EXE 已包含官方 Codex 執行檔。在「設定 → Codex」按「官方 Codex 登入」，於瀏覽器完成，再勾「啟用 Codex 定時策略」並儲存。登入只在你的電腦執行；開發及 CI 不會登入你的帳戶。

也可依 [Codex 官方文件](https://developers.openai.com/codex/cli/) 安裝並登入 Codex CLI。Windows 建議使用官方支援的本機環境。若唯讀 sandbox 不受支援，分析會失敗，程式不會退回 unrestricted 模式。

```powershell
npm install -g @openai/codex
codex login
```

程式使用官方 `@openai/codex-sdk`，預設使用 SDK 內附執行檔，可在設定指定 `codex_path`。設定 `codex_enabled: true`；`codex_model` 留空使用你的 Codex 預設模型，`codex_reasoning` 可用 `default/low/medium/high/xhigh`。分析可能消耗你的方案額度或 API 費用。

分析使用本應用程式獨立的 `codex-login` 設定目錄，不沿用個人 MCP、技能或外掛設定。若沒有此程式的登入，會首次複製既有 Codex auth.json。後續使用同一獨立目錄保存官方登入刷新結果，避免每輪覆寫成舊憑證。登入檔維持本機權限，不能上傳或分享；組織強制使用其他憑證儲存方式時，需遵照組織政策，本版不繞過政策。傳給模型的快照沒有帳號、身分證字號、委託識別碼、券商金鑰、CA 路徑或密碼；子程序不繼承任何 `SJ_*` 環境值。

限制 shell／檔案修改／MCP／網路搜尋工具並檢查 SDK 事件。模型只回傳 JSON 決策，交易引擎獨立驗證後才執行。唯讀 sandbox 與環境過濾不等於抵抗同一 OS 使用者的所有惡意程式；需要更強隔離時，應將分析執行在不同 OS 使用者或受控執行環境中。

分析逾時或結果不符會停止新買進並核對撤銷本程式買進掛單；既有持倉保護獨立持續，暫停狀態重啟後仍保留。盤後只接受 HOLD 及無進場規則的檢討，不覆蓋使用中的策略。

## 三種節奏與自動觀測

在設定頁直接填寫，不需改程式或準備固定股票清單。

| 項目 | 預設 | 可設定 |
|---|---|---|
| Codex 策略 | 09:15、11:45 | 1–6 個固定時刻，或 10–360 分鐘間隔；盤後 14:00 另檢討 |
| 行情／條件偵測 | 3 秒 | 1–30 秒；行情由 SSE 接收，這不是逐次下載歷史 K 線 |
| 觀測增刪 | 5 分鐘 | 1–60 分鐘；最多 5–20 檔，預設 12 |
| 移除條件 | 連續 3 次不符 | 1–12 次；第一輪不符就停止新買進及核對撤銷進場餘量 |
| 流動性 | 最近已完成日成交額至少 NT$20,000,000 | 可由本機修改；AI 不能降低本機門檻 |

Codex 可產生 `screening` 選股門檻，以及 TREND（多頭趨勢）、BREAKOUT20（突破此前 20 日壓力）、PULLBACK20（回測 MA20）進場規則。規則有效期內，新加入且符合資格的觀測股可由程式自動計算限價、股數與停損停利；不必等下一輪逐股分析。`screening.entry=null` 時僅觀測，交易依明確個股決策；個股 HOLD 優先阻止規則買進。

股數同時受現金保留、掛單、交割、單筆、單檔、曝險及每日預算限制，再送獨立風控複核。零股預設 1–999 股；整股啟用後獨立使用 Common 五檔，預算不足整股時可使用零股。每檔每輪策略最多一次進場，不因觀測增刪重複下單。

Codex 新策略會調整觀測優先股。持倉及未完成委託即使不符選股門檻仍保留核對／保護監控；移除觀測不會賣掉持倉或撤除智慧保護。只在已確認的交易日排程，錯過時刻有 20 分鐘補執行窗口；過久不補跑歷史時刻，可手動立即更新。

## 指定日期區間歷史模擬

桌面提供日期、資金、零股／整股、固定策略時刻或間隔、偵測秒數、觀測更新及 Codex 呼叫上限。單次最多 367 天；真實歷史結束日須早於今天。可停止，保留已執行時間的部分結果，不把取消時間偽裝成收盤。

| 資料來源／策略 | 行為 |
|---|---|
| 虛構行情＋流程示範 | 免登入，不呼叫 Codex；只驗證程式，不代表任何股票或策略績效 |
| 虛構行情＋Codex | 真正呼叫官方 SDK，但行情仍為虛構；適合驗證本機認證與輸出格式 |
| CSV＋Codex | 匯入資料池中的股票自動分析交易，依虛擬時間提供資料 |
| Shioaji＋Codex | 唯讀查詢歷史排行及 K 線，不讀取交易帳戶或向券商下單；查詢會消耗官方歷史資料流量 |

Shioaji 模式以區間前一個交易日的成交金額排行普通股前 20 檔建立歷史資料池，之後依每個虛擬時間已完成日 K 動態排序。這不是全市場回測。分段唯讀下載並快取；不使用今日排行選過去股票。未取得已確認交易日曆或歷史排行時停止，不回退使用今日資料。

CSV 欄位（普通現股，成交量單位為股；`at` 是已完成 K 線的結束時間）：

```csv
symbol,at,open,high,low,close,volume_shares
2330,2026-01-05T09:10:00+08:00,1000,1005,995,1000,500000
```

這一行只展示格式，不是實際行情。需匯入至少區間前 20 個交易日，建議 60–150 日暖機資料。可附 `bid,ask,bid_shares,ask_shares`；只有確定對應市場的歷史五檔才能用這些欄位。以 `date` 取代 `at` 可匯入日 K；日 K 僅以假設 09:10／09:11 開盤價與 13:30 收盤價重播，不還原當日高低點路徑。

全自動 Codex 模式依虛擬交易時間分析、盤後檢討；快照只包含當時已知資料與該次回測截至當時的經驗。呼叫上限含檢討，自動比較時整批共用；達上限停止新進場並保留保護。缺交易日資料、略過策略或分析失敗會標成 PARTIAL；完全沒有有效盤中策略標成 FAILED，不能冒充完整成功測試。

策略、觀測與短間隔偵測分別排程。重播保留真實價格事件及對齊秒數的偵測，略過沒有狀態變化的空白計時，不插值新行情。分鐘資料不足不能藉調成每秒偵測取得更細的價格路徑。日 K 不支援固定盤中策略時刻；間隔模式也只能作開盤近似測試。

「自動比較時間間隔」依序重設相同初始資金與資料，預設比較 60、120、180 分鐘。每組獨立帳戶與經驗；可保存最近 30 份結果的索引、切換查看或匯出完整報表，原始報表不因索引上限被刪除。選較佳區間結果仍須另作不同日期的驗證，不能當成未來獲利保證。

回測沿用即時風控與智慧單，委託最早在下一個價格事件成交，禁止今日買進量當日賣出。首檔深度若缺漏，以 K 線成交股數的 1% 估算；價差以收盤價前後一個 tick 估算。普通市場分鐘 K 線不是零股歷史撮合資料；K 線之內的觸發先後、排隊、真實滑價、歷史特殊交易狀態及企業行動未還原。Codex 可能從預訓練知道歷史事件，因此重播不等於嚴格樣本外驗證。

買款及買進費用立即預留；賣出淨額在已知交易日曆 T+2 才可用，期末待收交割款仍計入淨值。損益含費稅，已實現成本採 FIFO 並分攤買進費用；未實現按最後可取得價格估值，不強制平倉。報表包含資料來源、費率、模型設定、限制、逐日淨值、逐筆成交、委託及檢討。JSON 完整報表與成交 CSV 可由桌面匯出，結果也保存於本機 `state/backtests/`。

```powershell
npm run backtest:demo
node dist/src/cli.js --backtest --start=2026-10-01 --end=2026-10-08 --times=09:15,11:45 --monitor=3 --watch=5
node dist/src/cli.js --backtest --start=2026-10-01 --end=2026-10-08 --compare=60,120,180 --monitor=3
node dist/src/cli.js --backtest --start=2026-01-05 --end=2026-01-09 --cash=100000 --source=csv --strategy=codex --csv=C:\data\history.csv --settings=C:\data\trader-settings.json --output=C:\data\report.json
```

`trader-settings.json` 為符合本機設定 schema 的普通設定，需 `codex_enabled: true`，不得包含券商金鑰；登入憑證由官方 Codex 管理。

## Codex 能經驗學習嗎

本版提供持久化經驗回饋：模擬成交價格、費稅、FIFO 已實現損益、風控拒絕及盤後檢討會供下一輪分析參考。設定 `experience_enabled` 控制讀取，`experience_limit` 預設最多最近 40 筆。文字指令 `experience` 可查看摘要。

記錄按模式隔離；每次歷史回測使用全新範圍，只取得虛擬時間之前的事件與檢討。實盤沒有實際成交價及費用時，只記錄已核對成交量，損益保持未知。這是記錄、檢討及提示詞回饋，不會自動改模型權重、修改程式或放寬硬性風控，也不能保證越交易越會賺。

## 設定與預設風控

設定存在 SQLite，主要選項在設定頁直接修改；進階 JSON 收合在下方。不使用 `config.yaml` 或固定股票清單。金額與比率使用十進位字串，整數股數不接受小數；未知欄位會被拒絕。

| 設定 | 預設 |
|---|---:|
| `min_cash_fraction` | 至少保留 25% 淨資產現金 |
| `max_order_fraction` | 單筆不超過可投入淨資產的 10% |
| `max_symbol_fraction` | 單檔不超過淨資產 20% |
| `max_exposure_fraction` | 總股票曝險不超過 75% |
| `max_daily_buy_fraction` | 單日新增買進不超過淨資產 20% |
| `max_daily_buy_orders` | 每日最多 5 筆買進 |
| `daily_loss_fraction` | 達到 2% 日損失停止新買進，仍可賣出舊庫存 |
| `quote_max_age` | 成交與五檔各自最多 30 秒 |
| `account_max_age` | 帳戶快照最多 60 秒 |
| `max_spread_fraction` | 最大買賣價差 2% |
| `price_deviation_fraction` | 委託價距最新成交最多 3% |
| `cooldown_seconds` | 同標的非保護委託間隔 120 秒 |
| `plan_max_minutes` | 計畫最多有效 360 分鐘；到期只停止新進場，既有保護持續 |
| `fee_rate / minimum_fee` | 保守估算 0.1425%／NT$20，須核對你的實際券商費率 |
| `sell_tax_rate` | 普通現股賣出稅 0.3%，不適用當沖減稅 |

現金扣除待付交割款及未完成買單資金；未入帳賣出交割款不立即用於下單。日損失基準為程式本交易日第一次完整帳戶快照，盤中開啟時不是當日開盤淨資產。

實盤前須將 `fee_verified` 設為 `true`，並依你實際交割明細確認 `settlement_debit_sign: "positive"` 或 `"negative"`。預設 `"unverified"` 遇非零交割款會凍結委託，禁止自行推測符號。

## 實盤啟用

此專案建置與測試不會替你啟用實盤、索取金鑰或傳送真實委託。使用者在本機完成下列流程：

1. 先用 READONLY/PAPER 核對你的帳戶、行情、交易日曆、庫存單位與手續費。
2. 官方原生服務使用正式模式，有效 CA 與必要權限；只綁定本機。
3. 本機啟動應用程式時明確設定 `LIVE_TRADING=true`：

```powershell
$env:LIVE_TRADING = 'true'
& '.\Shioaji-Codex-Trader-0.4.0-Windows-x64.exe' --mode=live
```

4. 在 LIVE 的獨立設定核對 `fee_verified`、交割款符號及風控。帳戶必須完整且符合正式服務模式。
5. 在「本機實盤授權」輸入指定文字並接受原生授權視窗。最後再使用 `auto on`。

實盤同時要求 LIVE 模式、環境旗標、與選定帳戶相符的本機授權、有效登入與 CA、自動執行及風控通過。改 JSON 不能跳過這些條件。

如果官方服務啟用 **Agent Harness**，需要可信任主機的逐次能力票證。本版沒有原生票證簽發服務，因此會停止真實委託，顯示需要受信任 broker；不會關閉、繞過或偽造票證。標準官方服務預設 `off` 的情況使用普通 HTTP。若你的使用環境必須使用 Harness，應先整合官方支援的可信任 broker 才能實盤；本機授權不能取代官方能力票證。

## 文字指令

| 指令 | 行為 |
|---|---|
| `status` | 顯示模式、帳戶、計畫、保護與委託 |
| `experience` | 顯示近期經驗、可核對損益及盤後檢討 |
| `decide` / `review` | 立即分析／盤後只讀檢討 |
| `watch` | 立即更新動態觀測，不呼叫 Codex |
| `start-auto` | 啟動自動模式；缺有效策略則先分析 |
| `pause` / `resume` | 暫停／恢復買進；pause 核對撤銷本程式進場餘量，保護持續 |
| `stop` / `continue` | 停止／恢復所有新委託；不自動撤銷券商掛單 |
| `auto on` / `auto off` | 啟用／停止自動執行 |
| `cancel ID前綴` | 核對撤銷指定本機委託 |
| `cancel-all` | 核對撤銷本程式的掛單，不操作外部委託 |
| `reconcile` | 重新核對券商委託與帳戶 |
| `calendar 2027` | 從官方取得指定年度交易日曆 |
| `help` / `exit` | 顯示指令／結束本機監控 |

CLI：`node dist/src/cli.js --mode=readonly --doctor` 或 `node dist/src/cli.js --mode=paper`。可用 `--db=絕對路徑` 指定獨立資料庫；只有桌面介面提供本機實盤授權。

## 智慧單與異常處理

智慧條件由本機程式實作，沒有假設券商提供原生 stop/oco。需讓電腦、官方 Shioaji 服務和程式持續運作。介面預設阻止程式自動休眠，但無法阻止手動休眠、關機或網路中斷。

零股當日新增量不可當沖。停損當日觸發也可能只能等待下一個交易日，並重新評估當時行情；停損不能消除這段持有風險。所有出場仍使用限價單，行情跳空或流動性不足時可能無法成交。

送單前先保存完整意圖及唯一短標籤。回應逾時、欄位不符或券商狀態未知時標記 UNKNOWN，禁止新委託並重新查詢，不會直接重送。撤單不是立即成功；須看到最終 CANCELLED 或 FILLED，更新持倉後才允許重掛。UNKNOWN 不會因找不到委託而自動清除，需人工核對券商；避免把延遲回報誤判為沒有下單。

同一帳戶只執行一套自動程式。資料庫程序鎖防止同一資料庫重複啟動；桌面還有單實例鎖。不同資料庫／不同程式仍可能連到同一券商帳戶，請勿同時啟用。

斷線、SSE gap、資料格式異常、休眠或跨日都會清除行情並重新核對。格式異常需重新啟動。未知年份／非已確認交易日禁止下單。2026-12-07 前盤中零股自 09:10 開始，生效日後改為 09:00；收盤 13:30 排除。

## 開發與驗證

```powershell
npm test
npm run demo
npm run pack:win
```

GitHub Actions 在 Linux 與 Windows 執行 TypeScript 編譯、69 項單元／整合測試、DEMO 及日期區間回測。Windows 另驗證四頁介面、IPC 隔離、排程顯示、觀測／規則成交、自動比較、損益顯示、頁面溢位及系統匣，再驗證打包後 EXE。Release 含實際 DEMO 介面截圖。全部成功才發布測試版及 SHA-256 校驗檔。

測試涵蓋部分成交、計費、禁止同日賣出、未知委託不重送、過期計畫撤單、保護持續、重啟、價格跳動單位、資金與交割預留、日損失、SDK 輸出驗證、環境隔離及 API/SSE 單位解析。真實登入、CA、零股成交、券商費率與 Codex 認證須在你的電腦另外驗收；CI 沒有使用這些帳戶。

舊 Python 版本保留於 Git 歷史，新版預設分支只包含 TypeScript 實作，不會自動匯入舊帳戶資料庫。

## 官方參考

- [Shioaji 官方文件](https://sinotrade.github.io/)
- [Shioaji Pro 操作流程參考](https://github.com/Sinotrade/shioaji-pro-app)
- [官方其他語言／HTTP 安裝](https://sinotrade.github.io/env_setup/other/)
- [官方 TypeScript／JavaScript HTTP 範例](https://github.com/Sinotrade/Shioaji/blob/master/plugins/shioaji/skills/shioaji/references/JAVASCRIPT.md)
- [官方 HTTP API](https://github.com/Sinotrade/Shioaji/blob/master/plugins/shioaji/skills/shioaji/references/HTTP_API.md)
- [官方 Agent Harness](https://github.com/Sinotrade/Shioaji/blob/master/plugins/shioaji/skills/shioaji/references/AGENT_HARNESS.md)
- [Codex SDK](https://developers.openai.com/codex/sdk/)
