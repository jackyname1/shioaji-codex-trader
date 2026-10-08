# Shioaji Codex Trader（全 TypeScript）

Windows 系統匣程式，開啟後是文字介面。Codex 定時分析動態股票池，Node.js 交易引擎持續監控行情、智慧條件、風控與委託。

應用程式、交易引擎、Codex 整合、Electron 介面、測試及打包腳本全部使用 TypeScript。透過 **Shioaji 官方 HTTP API + SSE** 連接券商，沒有自製 Python 橋接程式。官方原生 `shioaji` 服務與 Codex 原生執行檔是外部依賴。

預設為 `demo`，自動執行與真實下單均關閉。DEMO 只使用虛構代碼、行情、資金及成交。程式不提供獲利保證；完成程式測試不代表已驗證你的券商帳戶或實際成交。

## 功能

| 部分 | 行為 |
|---|---|
| 桌面 | Electron 文字視窗、系統匣、關閉／最小化隱藏、點圖示重開、系統匣暫停與停止 |
| 模式 | DEMO 虛構行情、READONLY 帳戶唯讀、PAPER 真實行情＋模擬資金、LIVE 實盤；資料庫各自獨立 |
| 動態股票池 | Shioaji 成交金額、成交量、漲跌幅排行榜合併，過濾非普通股票、暫停／處置股及注意股 |
| 選股 | Codex 每輪列出 5–20 檔候選；可全部 HOLD，沒有固定買進名單 |
| 分析資料 | 已完成日 K、MA5/20/60、簡單 RSI14（不是 Wilder 平滑）、ATR14、量比、20 日支撐壓力、月營收、重大訊息 |
| Codex | 官方 TypeScript SDK，獨立分析設定目錄、唯讀 sandbox、禁用網路工具，schema 與快照／效期核對 |
| 定時分析 | 台北時間 08:40 盤前、盤中每 60 分鐘、14:00 盤後；可在文字設定修改 |
| 智慧條件 | 限價、立即／價格以下／價格以上進場、停損、停利、移動停損；既有停損不得由 AI 放寬 |
| 零股 | `IntradayOdd`，1–999 股，現股 `Cash`、限價 `LMT`、當日有效 `ROD`；不用盤後零股 |
| 不當沖 | 核對庫存明細取得日及股數單位；今日新增股數不會用於 SELL，舊庫存可賣 |
| 委託 | 送單前持久化、部分成交、重啟核對、外部掛單預留資金、未知委託凍結，不盲目重送 |
| 保護出場 | 每筆最多 999 股；撤單確認＋更新可賣股數後才重掛，最多每天每檔 10 次嘗試 |
| 保存 | SQLite WAL、完整同步寫入、單一寫入佇列、程序鎖、計畫／保護／事件紀錄持久化 |
| 操作 | 暫停買進、緊急停止新委託、逐筆／本程式全部撤單、手動核對、立即分析與盤後檢討 |
| 行事曆 | 官方 TWSE 每日開休市；附 2026 核對資料，未知年份禁止委託；可更新 |

僅開放上市櫃普通現股，禁止融資、融券、借券、當沖及槓桿／反向 ETF。整股預設關閉，啟用後仍須為 1000 股倍數。其他券商 API 功能（期貨、選擇權、借券、保留額度等）沒有開放給交易策略。

## Windows 啟動

1. 在 GitHub 的 **Actions → TypeScript checks and Windows app** 選最新成功的工作流程。
2. 下載 **Shioaji-Codex-Trader-TypeScript-Windows-x64** artifact，解壓後開啟 EXE。
3. 預設開啟 DEMO。按「立即分析」及「自動執行」可測試虛構流程；真實交易需另行設定。

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

連接前會核對 `/info`、`/health`、帳戶簽署狀態及 `/openapi.json` 必要端點。API 欄位、CA 狀態或日期無法核對時停止新增委託；不會猜測未知欄位。

在「連線與模式」先切換 READONLY，核對銀行現金、交割款、庫存與可賣股數；再使用 PAPER 驗證行情與策略。設定 `stock_account_index` 選取官方服務回傳的證券帳戶順序，切換需重新連線；帳戶或服務模式變更須使用新的獨立資料庫，禁止混用。

PAPER 與 DEMO 成交模型依五檔首檔量模擬部分成交，按委託累計金額計費。PAPER 沒有完整模擬 T+2 入扣款、排隊順位、券商拒單或成交價格；不能作為實際交易能力驗收。PAPER 只用真實行情，不向券商送單。

## Codex 本機登入與設定

先依 [Codex 官方文件](https://developers.openai.com/codex/cli/) 安裝並登入 Codex CLI。Windows 建議使用官方支援的本機環境。若唯讀 sandbox 不受支援，分析會失敗，程式不會退回 unrestricted 模式。

```powershell
npm install -g @openai/codex
codex login
```

程式使用官方 `@openai/codex-sdk`，預設使用 SDK 內附執行檔，可在設定指定 `codex_path`。設定 `codex_enabled: true`；`codex_model` 留空使用你的 Codex 預設模型，`codex_reasoning` 可用 `default/low/medium/high/xhigh`。分析可能消耗你的方案額度或 API 費用。

分析使用獨立 `codex-analysis-profile`，只複製你的 Codex 登入檔，不沿用個人 MCP、技能或外掛設定。登入檔維持本機權限，不能上傳或分享。傳給模型的快照沒有帳號、身分證字號、委託識別碼、券商金鑰、CA 路徑或密碼；子程序不繼承任何 `SJ_*` 環境值。

限制 shell／檔案修改／MCP／網路搜尋工具並檢查 SDK 事件。模型只回傳 JSON 決策，交易引擎獨立驗證後才執行。唯讀 sandbox 與環境過濾不等於抵抗同一 OS 使用者的所有惡意程式；需要更強隔離時，應將分析執行在不同 OS 使用者或受控執行環境中。

分析逾時或結果不符會停止新買進並核對撤銷本程式的買進掛單；既有持倉保護獨立持續。盤後檢討只接受 HOLD 決策。

## 設定與預設風控

設定存在 SQLite，以介面中的 JSON 編輯，不使用 `config.yaml` 或固定股票清單。金額與比率使用十進位字串，整數股數不接受小數；未知欄位會被拒絕。

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
| `plan_max_minutes` | 計畫最多有效 120 分鐘 |
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
& '.\Shioaji-Codex-Trader-0.2.0-Windows-x64.exe' --mode=live
```

4. 在 LIVE 的獨立設定核對 `fee_verified`、交割款符號及風控。帳戶必須完整且符合正式服務模式。
5. 在「本機實盤授權」輸入指定文字並接受原生授權視窗。最後再使用 `auto on`。

實盤同時要求 LIVE 模式、環境旗標、與選定帳戶相符的本機授權、有效登入與 CA、自動執行及風控通過。改 JSON 不能跳過這些條件。

如果官方服務啟用 **Agent Harness**，需要可信任主機的逐次能力票證。本版沒有原生票證簽發服務，因此會停止真實委託，顯示需要受信任 broker；不會關閉、繞過或偽造票證。標準官方服務預設 `off` 的情況使用普通 HTTP。若你的使用環境必須使用 Harness，應先整合官方支援的可信任 broker 才能實盤；本機授權不能取代官方能力票證。

## 文字指令

| 指令 | 行為 |
|---|---|
| `status` | 顯示模式、帳戶、計畫、保護與委託 |
| `decide` / `review` | 立即分析／盤後只讀檢討 |
| `pause` / `resume` | 暫停／恢復新增買進，持倉保護持續 |
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

GitHub Actions 在 Linux 與 Windows 執行 TypeScript 編譯、單元／整合測試及 DEMO；Windows 另驗證 Electron 文字介面、IPC 隔離、指令及視窗隱藏／重開，再驗證打包後 EXE。

測試涵蓋部分成交、計費、禁止同日賣出、未知委託不重送、過期計畫撤單、保護持續、重啟、價格跳動單位、資金與交割預留、日損失、SDK 輸出驗證、環境隔離及 API/SSE 單位解析。真實登入、CA、零股成交、券商費率與 Codex 認證須在你的電腦另外驗收；CI 沒有使用這些帳戶。

舊 Python 版本保留於 Git 歷史，新版預設分支只包含 TypeScript 實作，不會自動匯入舊帳戶資料庫。

## 官方參考

- [Shioaji 官方文件](https://sinotrade.github.io/)
- [官方其他語言／HTTP 安裝](https://sinotrade.github.io/env_setup/other/)
- [官方 TypeScript／JavaScript HTTP 範例](https://github.com/Sinotrade/Shioaji/blob/master/plugins/shioaji/skills/shioaji/references/JAVASCRIPT.md)
- [官方 HTTP API](https://github.com/Sinotrade/Shioaji/blob/master/plugins/shioaji/skills/shioaji/references/HTTP_API.md)
- [官方 Agent Harness](https://github.com/Sinotrade/Shioaji/blob/master/plugins/shioaji/skills/shioaji/references/AGENT_HARNESS.md)
- [Codex SDK](https://developers.openai.com/codex/sdk/)
