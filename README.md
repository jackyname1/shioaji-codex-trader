# Shioaji Codex Trader

Windows 文字介面／系統匣股票交易程式。Python 持續監控行情與委託，Codex CLI 定時提出選股、股數、限價、停損及移動停利計畫，程式驗證後才執行。以盤中零股為主，整股預設關閉；不支援當沖、融資融券或放空。

**初始模式是虛構行情 demo，自動執行關閉。本專案沒有使用你的券商帳號，也沒有實際下單。** 核心模擬已驗證；Windows GUI、打包、Codex 真實登入及券商連線需本機驗證。這是可測試的第一版，不是已完成券商驗收的產品。

## Windows 安裝

準備 Windows 10/11、Python 3.12 x64；需要 AI 分析時另裝 Node.js LTS 與官方 Codex CLI。下載／clone 原始碼後，在專案目錄用 PowerShell 執行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install.ps1
.\.venv\Scripts\python.exe -m shioaji_trader doctor
.\.venv\Scripts\python.exe -m shioaji_trader demo
.\.venv\Scripts\shioaji-trader-desktop.exe
```

`demo` 用 2026-10-08 虛擬時鐘展示一次買進與今日不可賣庫存；不連線券商。桌面 demo 依目前台北時間及已載入行事曆运行，休市時不送模擬單。

桌面最小化或關閉視窗會收進系統匣；雙擊圖示開啟文字介面。退出請用系統匣「結束」或 `exit`。無系統匣的環境會保留視窗。`--minimized` 可啟動隱藏。預設阻止 Windows 自動睡眠，但不阻止關螢幕；手動睡眠、關機與斷網仍會中斷監控。

## 文字指令

| 指令 | 行為 |
|---|---|
| `decide` | 非重疊地準備快照與呼叫 Codex；demo 未啟用 Codex 時用虛構範例 |
| `auto on` / `auto off` | 開關自動執行，不改變交易模式 |
| `pause` / `resume` | 暫停／恢復買進，既有保護條件繼續 |
| `stop` / `continue` | 停止／恢復全部新委託；不會自動撤掉券商既有掛單 |
| `cancel` | 撤銷本程式記錄且可核對的掛單，不撤其他程式或人工單 |
| `settings` | JSON 文字設定，保存在本機 SQLite |
| `calendar` | 更新本年度證交所開休市表 |
| `help` / `exit` | 說明／結束程式 |

## 本機設定與資料

預設資料在 `%LOCALAPPDATA%\ShioajiCodexTrader\state.db`。模型設定、委託意圖、庫存、保護條件、事件與每日基準存在 SQLite。CLI 全域 `--db PATH` 必須放子命令之前；GUI 也接受 `--db PATH`。一個資料庫同時只能有一個引擎。**同一券商帳號只運行一套實盤引擎；不要藉不同資料庫重複啟動。** 改模式前結束程式；建議 demo、paper、live 分別使用資料庫。

```powershell
.\.venv\Scripts\python.exe -m shioaji_trader settings
.\.venv\Scripts\python.exe -m shioaji_trader set start_minimized true
.\.venv\Scripts\python.exe -m shioaji_trader set codex_enabled true
.\.venv\Scripts\python.exe -m shioaji_trader set decision_interval_minutes 60
```

盤前 08:40、盤中每 60 分鐘、盤後 14:00 為預設排程；可調整時間與間隔。盤後僅檢討 HOLD，不補掛盤後零股。關機期間的排程不補追單。未載入年度行事曆時，未知日期拒單；已附官方 2026 年資料，跨年前更新下一年度。不是以政府辦公日判斷股市開市。

## Codex

```powershell
npm install -g @openai/codex
codex login
codex --version
.\.venv\Scripts\python.exe -m shioaji_trader set codex_enabled true
```

沿用本機 Codex CLI 登入；實際可用模型與額度依你的帳號及官方支援而定。`codex_model` 空白使用 CLI 預設，`codex_path` 可指定執行檔路徑。每次執行 `codex exec`，使用唯讀模式、暫存目錄及 JSON Schema。回傳格式、標的範圍、快照、期限與風控不合即拒絕；超時不啟用新計畫。Codex 思考在背景工作執行緒，交易監控仍持續。

快照包含動態成交額／成交量／漲幅 scanner 股票池、MA5/20/60、簡單 RSI14、ATR14、支撐壓力、量能、現金／待交割款／可賣庫存，以及可取得的官方月營收與重大訊息。資料缺漏會列出限制，不編造消息。候選通常 5–20 檔，訊號不足可以不交易。報價及帳戶核對會序列化 SDK 呼叫，因此網路慢時仍可能延遲監控，不能保證即時出場。

券商金鑰、憑證密碼及帳戶 ID 不放進 AI 快照；傳給 CLI 的環境移除 `SJ_`／`SHIOAJI_`、`LIVE_TRADING`、GitHub Token。這不是 OS 層級隔離：Codex 與券商使用同一使用者執行時，仍需保護該使用者的本機權限。模型若回報執行外部工具，計畫會被拒絕。

## Shioaji 連線與模擬資金

先完成永豐帳戶/API 權限與憑證申請。金鑰與憑證只在自己的電腦輸入：

```powershell
.\.venv\Scripts\python.exe -m shioaji_trader credentials
.\.venv\Scripts\python.exe -m shioaji_trader readonly-test
```

輸入項目：`SJ_API_KEY`、`SJ_SEC_KEY`、`SJ_CA_PATH`、`SJ_CA_PASSWD`。使用 Windows Credential Manager/keyring；也可由本機環境提供。不要貼到聊天、GitHub 或設定 JSON，不上傳 CA 檔案。

唯讀測試使用真實 API 登入，讀取餘額、交割、部位及委託，不啟用 CA 下單。`paper` 使用真實市場行情及本程式模擬帳本，**不是 Shioaji simulation**：

```powershell
.\.venv\Scripts\python.exe -m shioaji_trader set mode paper
.\.venv\Scripts\python.exe -m shioaji_trader set codex_enabled true
.\.venv\Scripts\shioaji-trader-desktop.exe
```

先檢查 `decide` 的計畫，再開 `auto on` 進行模擬。Paper 帳本預設十萬元，成交按可見五檔與深度模擬；不含完整排隊、滑價或 T+2 交割，手續費按每次成交保守計算。不能當作實盤績效回測。

## 零股與風控

零股每單 1–999 股，現股、LMT、ROD；整股啟用後輸入股數需為 1000 倍數。整股與零股行情分開。零股改價採撤單、確認成功、再掛剩餘數量；部分成交不重買已成交數量。重啟先核對券商委託，送單逾時寫入 UNKNOWN，停止新委託，不能盲目重送。

今日新增庫存排除可賣量；既有庫存仍可卖。保護条件觸發但全是今日新買時，不送出賣單，下一交易日以當時行情重判。停損／停利是程式監控的條件限價單，**不是券商伺服器保證执行的智慧單**；斷網、關機、跌停無量、隔夜跳空都可能無法成交。

預設保留現金 25%、單筆最多可投入資金 10%、单一股票淨資產 20%、總持倉 75%、每日新增買進 20%與最多五筆；日損失 2%停止買進，保護賣出仍可執行。日損基準是本日第一次完整帳戶快照，不是歷史開盤資產。資金扣除待付交割及未成交買單，交割收入不當成可立即動用現金。價格跳動、漲跌停、報價時效、庫存、注意／處置／停牌等均另行檢查。

一檔股票每次最多撤換十次保護單／日；大於 999 股的部位分次零股出場，可能跨越多次檢查。模型未為人工已有持倉提供保護条件时，不會凭空補出停損；請在計畫中核對每個持倉。

## 本機實盤啟用

這些步驟會啟用真實自動交易，請在完成唯讀與 paper 核對後自行執行。先關閉執行中的程式，核對實際手續費、零股最低費用與證交稅，再設定 `fee_rate`、`minimum_fee`、`sell_tax_rate`。交割款正負號依券商明細確認，設 `settlement_debit_sign` 為 `positive` 或 `negative`；無法確認時保留 `unverified`，有非零交割資料會拒單。

```powershell
.\.venv\Scripts\python.exe -m shioaji_trader set fee_verified true
# 下行僅在已核對「正數代表待付款」時使用；否則改 negative
.\.venv\Scripts\python.exe -m shioaji_trader set settlement_debit_sign positive
.\.venv\Scripts\python.exe -m shioaji_trader readonly-test
.\.venv\Scripts\python.exe -m shioaji_trader enable-live --ack 'ENABLE CASH STOCK AUTO TRADING'
$env:LIVE_TRADING = 'true'
.\.venv\Scripts\shioaji-trader-desktop.exe
```

`enable-live` 本身只保存本機設定；啟動仍須 `LIVE_TRADING=true`、CA 啟用成功与完整帳戶核對。這不是本次聊天已替你核准的實盤操作；我們目前只開發與模擬。`disable-live` 保存停用設定，但正在執行的引擎需退出重啟；立即停止新單用 GUI `stop`，撤既有掛單另用 `cancel` 或券商介面。

## 打包／開機啟動

```powershell
powershell -ExecutionPolicy Bypass -File scripts/build.ps1
powershell -ExecutionPolicy Bypass -File scripts/startup.ps1 -Executable .\dist\ShioajiTrader\ShioajiTrader.exe
# 移除開機捷徑
powershell -ExecutionPolicy Bypass -File scripts/startup.ps1 -Executable .\dist\ShioajiTrader\ShioajiTrader.exe -Remove
```

傳送整個 `dist/ShioajiTrader` 與 `dist/ShioajiTraderCLI` 目錄，不只 exe。CLI exe 支援相同子命令。開機捷徑不保存金鑰或啟用實盤環境變數。GitHub Actions 在 Linux/Windows 跑核心測試，再於 Windows 建置并上傳 artifact；首次推送後需確認 Actions 結果，不能把配置檔當作已成功打包。

## 開發與驗證

```bash
PYTHONPATH=src python -m unittest discover -s tests -v
PYTHONPATH=src python -m compileall -q src tests
PYTHONPATH=src python -m shioaji_trader demo
```

目前涵蓋 26 個核心／整合模擬測試。Codex subprocess 用 mock 驗證指令、Schema、環境过滤與重疊拒絕；尚未實際呼叫登入服務。雲端環境無法安裝 PySide6/Shioaji 等外部套件，Windows GUI、CA、API 資料格式与建置需本機驗收。實盤前逐一確認：新版本 API 契約、零股行情、交割正負號、舊庫存可賣量、部分成交与撤單回報、睡眠恢复、断线与 UNKNOWN 处理。

官方參考：[Shioaji](https://sinotrade.github.io/) · [Codex CLI](https://developers.openai.com/codex/cli/) · [證交所開休市表](https://www.twse.com.tw/zh/trading/holiday.html)
