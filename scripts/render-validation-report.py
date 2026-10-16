"""Render the recorded, completed comparison. This script never invents missing metrics."""
import json
from pathlib import Path

root = Path(__file__).resolve().parents[1]
comparison = json.loads((root/'validation/comparison.json').read_text())
audit = json.loads((root/'validation/v022-log-audit.json').read_text())
checks = json.loads((root/'validation/checks.json').read_text())
assert comparison['status'] == 'COMPLETED' and comparison['completed_cases'] == comparison['expected_cases'] == 17
assert all(r['status'] == 'COMPLETED' for r in comparison['results'])
labels = {'v022':'v0.2.2 原程式策略', 'entries':'只改三策略進場', 'exits':'只改智慧退場', 'allocation':'只改動態配置',
          'combined':'三項全部啟用', 'adaptive_allocation':'原進場＋退場＋配置'}
order = list(labels)
fmt = lambda v, n=2: '—' if v is None else f'{float(v):,.{n}f}'

lines = ['# v0.2.3 候選版驗證報告', '',
'驗證日期：2026-10-16（台北）。狀態：程式與本地測試完成；發布未通過驗收。', '',
'**結論：本次資料不支持全面啟用三策略進場與動態配置，不能宣稱已提高長期風險調整後收益。** 開發區間較好的配置，在樣本外未勝出且回撤增加；因此預設保留原趨勢進場及原配置，加入智慧保護，三策略與動態配置列為研究選項。沒有用提高收益目標、取消風控或調整樣本外參數製造勝出結果。', '',
'尚未合併、建立 v0.2.3 Tag、Release 或 EXE。首次 GitHub runner 在開始執行步驟前失敗，Windows 來源／封裝 GUI 與新截圖尚未驗收；最新建置狀態以 [PR #26](https://github.com/jackyname1/shioaji-codex-trader/pull/26) 為準。已發布的 v0.2.2 保留可回復。', '',
'## 原始 v0.2.2 執行紀錄核帳', '',
'這一段對應使用者提供的原始 JSON，與下方另外下載的長期間日 K 比較分開計算。原始 JSON 未包含完整分鐘行情，所以不能忠實重跑原來 Codex 選股的成交路徑。原始帳戶快照及模型完整輸入未上傳到 Git。', '',
'| 項目 | 原始紀錄核對 |','|---|---:|']
for name,key in [('起始資金','initial_cash'),('期末權益','final_equity'),('總報酬 %','return_pct'),('已實現淨損益','realized_net_pnl'),
 ('扣已付買費的未實現損益','unrealized_after_buy_fees'),('已支付手續費','fees'),('賣出稅','taxes'),('盤後平均持倉 %','average_close_exposure_pct'),
 ('期末持倉 %','final_exposure_pct'),('可觀察快照最高權益','snapshot_peak_equity'),('快照回撤下界 %','snapshot_max_drawdown_lower_bound_pct'),
 ('退出勝率 %','win_rate_pct'),('平均獲利','average_win'),('平均虧損絕對值','average_loss'),('Profit Factor','profit_factor'),('10/15 退出淨損益','october15_exits_net')]:
    lines.append(f'| {name} | {fmt(audit[key],4 if "pct" in key or key=="profit_factor" else 2)} |')
lines += ['', f'950 個事件，{audit["fills"]} 筆成交、{audit["exits"]} 筆退出、20 個盤後快照。40 個 BUY 提案中，IMMEDIATE 16、REBOUND 21、BELOW 2、ABOVE 1；全部決策的移動啟動價均為 null。原始 RISK 事件 {audit["logged_risk_events"]} 筆、不同完整訊息 {audit["distinct_logged_risk_messages"]} 種，不能把重複監測當成獨立交易。', '',
'期末未實現損益包含已付買費，沒有扣尚未發生的賣出費稅。快照回撤只代表可觀察下界，不能當作完整盤中最大回撤。', '',
f'原始檔 SHA256：`{audit["source_sha256"]}`。可重現核帳程式：`scripts/audit-execution-history.py`；結果：[v022-log-audit.json](../validation/v022-log-audit.json)。', '',
'## 根因與修復', '',
'| 根因／核對結果 | 實作 |','|---|---|',
'| 模型從未提供移動保護，非單純引擎未判斷門檻 | 持倉補上 ATR 預設、完整 high_water、費稅／滑價保本底線；保護底線只升不降。既有較緊移動回落不被 ATR 放寬。 |',
'| 10/5 的 FAILED 是已持有 3324 離開當日排行池 | 驗證容許有完整帳戶／持倉資料的股票繼續被檢討，未知標的仍拒絕；不擴張當日新買資格。 |',
'| 參考股數不等於實際股數，原紀錄出現反覆風控拒絕 | 最終數量按最新現金、交割、掛單、集中度、含成本風險重算；真正提交前再次核對；拒絕經驗按日／計畫／股票／原因去重。 |',
'| 固定 5% 規則配置與最低費用可能形成資金效率問題 | 新增按強度、淨目標收益／風險排序及目標缺口的配置；保留單筆、單檔、總曝險與每日上限；實測未支持預設啟用。 |',
'| 隔夜跳空與無買盤能突破名目停損預算 | 成本核算加入退出滑價、獨立跳空壓測；實作連續跌停零深度測試，沒有買盤不假設成交，之後按真正可成交價格成交。 |',
'| 日損失曾超限後，短暫回升可能再次允許買入 | 日損失限制按日保存；重啟與權益回升均不解除當日停買。SELL 保護仍持續。 |',
'| 賣款在 T+2 一開始便可使用；交易日與交割日混用 | 改為交割營業日 T+2 11:00 才可用；春節前「休市但辦理交割」分開建模；颱風休市連同交割順延。 |',
'| 歷年日曆錯用 queryYear，官方回傳當年度 | 改用官網表單的 date=YYYY0101；仍驗證回傳年份，禁止拿錯年份代替。 |',
'| 長回測逐次解析全部歷史委託 | SQL 索引、單筆查詢、異動游標；離線無新鮮價格時省略重複副作用，與完整 GUI 路徑的成交、成本、權益、回撤逐項比對。 |',
'| 持倉主圖需要更完整、可刷新的明細 | 保留切換股票／清舊圖／鍵盤與回放截止保護；新增含買費成本、股數、浮損益、比例、保本／有效底線、追蹤期限與阻擋原因。Windows 實際畫面仍待驗收。 |', '',
'盤後 review_only 不進場、缺少行情不授權、今日新增零股不能當日賣出，都維持為安全規則。沒有把這些限制當成 Bug。', '',
'## 參數與預設', '',
'以下硬性數字採使用者原積極回測配置；沒有提高風險上限。既有設定讀取時保留其數值，模式啟動為 paper、自動執行關閉。', '',
'| 項目 | v0.2.2 基準 | v0.2.3 候選版 |','|---|---|',
'| 目標／最大持倉 | 70%／80% | 70%／80% |','| 最低現金保留 | 20% | 20% |','| 單筆／單檔上限 | 20%／25% | 20%／25% |',
'| 單筆名目風險／日損失停買 | 1.25%／2% | 1.25%／2%，日損失按日鎖定 |',
'| 每日買進額度／筆數 | 60%／8 筆 | 60%／8 筆 |','| 淨報酬風險比 | 1.2 | 1.2 |',
'| 程式規則原單筆配置 | 5% | 預設 5%；動態研究模式最多受 20% 及實際風險約束 |',
'| 三策略並行／動態配置 | 無完整並行與目標缺口機制 | 可選；樣本外未過，不預設啟用 |',
'| 本機智慧保護 | 依模型提供欄位 | 預設啟用；補缺少的移動保護及費稅保本 |',
'| 退出滑價估計 | 無獨立估計 | 0.1%；不允許成交超過委託限價 |',
'| 隔夜壓測／單筆壓測預算 | 無獨立門檻 | 5%／權益 2%；壓測不是最壞損失保證 |',
'| 最低預期淨利／反彈追蹤期限 | 無／依計畫到期 | 60 元／90 分鐘，跌破支撐失效、新計畫可重啟 |',
'| 費率／最低費用／賣出稅 | 0.1425%／20 元／0.3% | 相同；比較沿用原紀錄的向上取整，實際帳戶費用須依設定 |', '',
'移動缺省啟動距離為 max(1.25 倍初始風險、1.5 ATR、買價 2.5%)；缺省回落為 1.8 ATR 相對買價，限制於 2–8%。已明訂更緊的百分比不會被放寬。保本以實際含買費成本優先，否則保守估買費，再估賣費、稅、滑價與委買價差；它不保證穿價、隔夜或排隊時零損失。', '',
'## 比較方法', '',
'10 檔事先固定普通股：2330、2303、2317、2454、2308、2881、2882、2603、2002、1216。官方日資料 4,319 筆，涵蓋 2025-01-02 至 2026-10-15，兩年度官方日曆與已公告特殊休市另行核對。', '',
'開發區間：2025-05-01–2026-03-31；樣本外：2026-04-01–2026-10-15。完整五項拆解，加上一個模組組合、五個只在開發區間做的參數敏感度，共 17 組。所有個案完成；同一份資料、100,000 元、費率、滑價／跳空假設與修正後成交／交割引擎。', '',
'基準載入 v0.2.2 原 programAnalysis，並核對 Git blob；它是原「程式策略」的共用引擎比較，不是原 Codex 一個月交易紀錄的逐筆重跑。日 K 僅使用此前已完成資料形成訊號，以已標示的開／收盤近似及後一事件成交；不能驗證盤中反彈、零股集合競價排隊或 K 線內高低順序。', '',
'未來資料由 HistoricalMarket 截止、日 K 完成時點及回放截止共同限制；資料不插值成交。原始日行情未做股利、除權息、分割與退市完整還原，固定股票池存在存活者／成分偏差，因此研究結果不能當作實盤收益。', '',
f'資料 SHA256（解壓後）：`{comparison["dataset_sha256"]}`。原策略 Commit：`{comparison["baseline_commit"]}`。', '']

for period,title in [('development','開發區間'),('out_of_sample','樣本外區間')]:
    rows={r['variant']:r for r in comparison['results'] if r['period']==period}
    lines += [f'### {title}', '', '| 版本 | 淨報酬 % | 最大回撤 % | 日 Sharpe | 平均盤後持倉 % | 成交明細／完成交易 |', '|---|---:|---:|---:|---:|---:|']
    for key in order:
        r=rows[key];m=r['metrics'];t=m['trades']
        lines.append(f'| {labels[key]} | {fmt(m["return_pct"],4)} | {fmt(m["max_drawdown_pct"],4)} | {fmt(m["daily_sharpe"],3)} | {fmt(m["average_close_exposure_pct"],4)} | {m["fill_count"]}／{t["closed_trades"]} |')
    lines += ['', '| 版本 | 已實現淨損益 | 未實現損益 | 手續費 | 交易稅 |', '|---|---:|---:|---:|---:|']
    for key in order:
        m=rows[key]['metrics'];lines.append(f'| {labels[key]} | {fmt(m["realized_pnl"])} | {fmt(m["unrealized_pnl"])} | {fmt(m["fees"])} | {fmt(m["taxes"])} |')
    lines += ['', '| 版本 | 完成交易勝率 % | 平均獲利 | 平均虧損絕對值 | Profit Factor | 日損失超限天數／去重拒絕 |', '|---|---:|---:|---:|---:|---:|']
    for key in order:
        m=rows[key]['metrics'];t=m['trades'];pf='∞（無已完成虧損）' if t['profit_factor_unbounded'] else fmt(t['profit_factor'],4)
        lines.append(f'| {labels[key]} | {fmt(t["win_rate_pct"])} | {fmt(t["average_win"])} | {fmt(t["average_loss"])} | {pf} | {len(m["daily_loss_breach_days"])}／{m["risk_refusals"]} |')
    lines += ['', '| 版本 | 退場已成交委託（STOP／固定停利／TRAILING／保本） |', '|---|---|']
    for key in order:
        exits=rows[key]['metrics']['exits'];counts='／'.join(str(exits.get(k,{}).get('filled',0)) for k in ['STOP','TAKE_PROFIT','TRAILING','BREAKEVEN'])
        lines.append(f'| {labels[key]} | {counts} |')
    lines += ['', '退場完整提交、成交與拒絕數另見 JSON 的 metrics.exits；未成交原因為監測狀態樣本次數，不是互斥的獨立交易筆數。', '', '| 版本 | 無候選 | 未觸發 | 淨報酬風險 | 成本 | 購買力 | 未交割 | 持倉／風險上限 | 資料 | 日損失 | 其他 |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|']
    for key in order:
        counts=rows[key]['diagnostics'].get('reason_categories',{});vals=[counts.get(k,0) for k in ['NO_CANDIDATE','TRIGGER','REWARD_RISK','COST','BUYING_POWER','UNSETTLED_CREDIT','POSITION_OR_RISK_LIMIT','DATA','DAILY_LOSS','OTHER']]
        lines.append('| '+labels[key]+' | '+' | '.join(str(v) for v in vals)+' |')
    lines.append('')

lines += ['### 參數敏感度（開發區間，全部採三策略研究組合）', '', '| 變更 | 淨報酬 % | 最大回撤 % | 平均盤後持倉 % |', '|---|---:|---:|---:|']
for r in comparison['results']:
    if r['period']=='sensitivity_development_only':
        m=r['metrics'];lines.append(f'| {json.dumps(r["overrides"],ensure_ascii=False)} | {fmt(m["return_pct"],4)} | {fmt(m["max_drawdown_pct"],4)} | {fmt(m["average_close_exposure_pct"],4)} |')
lines += ['', '勝率及 Profit Factor 依已完整結束的同股 FIFO 持倉週期計算，合併部分成交與分段退出；仍持有部位不列入完成交易勝率。期末權益未扣未來平倉成本。Sharpe 以交易日權益報酬、零無風險利率、樣本標準差及 √252 計算；不是已通過顯著性檢定的 alpha。', '',
'## 測試與發布狀態', '',
'最新本地測試結果、Node 版本及來源檔雜湊記錄於 [checks.json](../validation/checks.json)。新增測試覆蓋三種訊號、固定目標、失效／超時、成本與股數、重啟保護、日損失鎖定、T+2 11:00、交割營業日、颱風休市、錯年日曆、重複委託、部分成交、零深度與連續跌停穿價；離線快速路徑與完整事件路徑的實際模擬成交、成本、權益及回撤一致。', '',
f'本地 `npm test`：{checks["local_tests"]["total"]} 項，{checks["local_tests"]["passed"]} 通過、{checks["local_tests"]["failed"]} 失敗、{checks["local_tests"]["skipped"]} 跳過。完整輸出：[local-tests.txt](../validation/local-tests.txt)。17 份完整回測報告另經獨立封存程式驗證：摘要一致、成交必須晚於提交、買賣遵守限價、賣出不超過前日庫存、費稅與權益勾稽、觸發及提交事件都有訂單識別。', '',
'[run-audits.zip](../validation/run-audits.zip) 保存 17 份完整 JSON.gz（含 workflow、orders、fills、daily_equity、settings），各檔 SHA256 見 [execution-audit-manifest.json](../validation/execution-audit-manifest.json) 與 comparison.json。這些都是隔離公開行情模擬，不包含使用者的帳戶原始紀錄。', '',
'首次 GitHub Linux／Windows 工作在分配 runner 前結束，無步驟、無建置日誌，原因尚未取得，不能推定為測試通過或程式測試失敗。Windows 原始與封裝 GUI、實際截圖、EXE、簽章與發布資產雜湊均待驗證。此環境也未能提供可用的原生桌面顯示後端；Linux headless Electron 沒有通過 GUI。', '',
'[AGENTS.md](../AGENTS.md) 要求「Never publish failed builds or claim an EXE is available before release assets and their hashes are verified.」及 Linux／Windows、來源／封裝 GUI 和本版 Windows 截圖驗收。本次不繞過這些條件，保留 PR 草稿；v0.2.3 Tag／Release 尚未建立。', '',
'## 重現', '', '```bash', 'npm ci', 'npm test',
'git worktree add ../baseline-v022 df744f638b1013b9d644218818862e8e19180872', 'npm --prefix ../baseline-v022 ci', 'npm --prefix ../baseline-v022 run build',
'node scripts/compare-v023.mjs validation/twse-daily.json.gz ../baseline-v022 validation/comparison.json',
'python3 scripts/archive-validation.py',
'python3 scripts/render-validation-report.py', '```', '',
'比較程式核對原策略 Git blob、壓縮檔的解壓後 SHA256，所有組別共用修正後引擎。要重新下載公開行情可執行 scripts/fetch-validation-data.py；重新下載可能含供應商修訂，完整重現請優先使用已保存的資料。scripts/audit-execution-history.py 需由使用者另提供原始執行 JSON 路徑。', '',
'## 主要程式位置', '', '| 檔案 | 作用 |', '|---|---|',
'| core/opportunities.ts、watchlist.ts、program-strategy.ts | 三訊號、固定證據目標、去重、機會排序與受限配置。 |',
'| core/smart.ts、engine.ts | 高低點、保護狀態、保本、最終核對、日停買及訂單生命週期。 |',
'| core/costs.ts、execution.ts、risk.ts | 含成本／滑價／跳空的股數與硬性風控。 |',
'| broker/paper.ts、core/calendar.ts | 後一報價撮合、零深度、FIFO 成本及獨立交割日曆。 |',
'| core/backtest.ts、performance.ts、entry-diagnostics.ts | 共用引擎、完整交易統計、事件鏈及等待分類。 |',
'| core/store.ts、models.ts、backtest-controller.ts | 原子意圖、狀態保存、索引／異動游標及舊報表相容。 |',
'| desktop/renderer.ts、index.html、styles.css、main.ts | 持倉明細、研究設定、排版及預設模擬啟動。 |', '',
'## 後續最值得做的三項', '',
'1. 取得原始完整分鐘 JSON 與可核對的零股撮合／五檔、成交回報，重跑原模型案例；加入模型延遲、排隊及股利／拆股／退市還原。',
'2. 重新驗證進場目標與訊號選擇，使用當時成分的較廣股票池及多市場階段 walk-forward；保留失敗組別，使用未開封的新驗證期間。',
'3. 以波動、相關性、跳空與組合回撤預算改進配置，而非只追求 70% 持倉。新配置須先通過扣成本後樣本外門檻。', '',
'官方依據：[交易／T+2 制度](https://www.twse.com.tw/zh/products/system/trading.html)、[年曆查詢表單](https://www.twse.com.tw/zh/trading/holiday.html)、[2026/7/10 休市及交割順延公告](https://www.twse.com.tw/staticFiles/news/news/tsecnews/8a8216d69ef76943019f46cb86ae0110.pdf)。公開行情各次請求與原始回應雜湊見 [market-provenance.json](../validation/market-provenance.json)。', '']
(root/'docs/V0.2.3_VALIDATION.md').write_text('\n'.join(lines))
print('Rendered docs/V0.2.3_VALIDATION.md from 17 completed comparisons')
