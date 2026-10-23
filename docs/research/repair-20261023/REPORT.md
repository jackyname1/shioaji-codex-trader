# v0.1.6 回測修復與驗證結果



已完成程式修復、固定研究比較與可靠性檢查；**沒有達成可正式交易的正期望值證據，正式下單停用**。原始 v0.1.5 的兩份 JSON 及同次分鐘行情目前缺失，不能宣告原始 14 筆交易已獨立核對或 9/9 完整根因已結案。



程式提交 `b95de61253ad88b3e325d8811239023f4086e457`；詳細檔案、函式與測試對應見 [工程紀錄](../../BACKTEST_REPAIR_PROGRESS_20261023.md)。



## 原始基準與可比較範圍

使用者提供基準：初始 100,000，期末 98,904.10，淨損益 -1,095.90，費稅 930，14 筆完整平倉，PF 0.7373、期望 -84.4929、PARTIAL。這些是未獨立核對的參考聲明；未以 v0.1.3 舊附件替代，也未改寫原始成交。

原引擎比較使用精確來源 commit 與固定程式策略代理，**不是原始 AI 策略**。所有組別同起始本金、資料可見性、必要資金上限、單筆 1% 風險及雙邊費稅；原引擎也明確套用相同風險及淨 RR 設定，避免把舊停用風控的預設當成可接受基準。

Optimistic / Neutral / Conservative 分別 0 / 10 / 30bps，均有其流動性／價差情境。更差限價可能改變成交子集，因此單次中性結果優於樂觀並不表示模型出錯或策略穩健。保守日線沒有可推定盤中深度，零成交不是正期望值。



## 已研究公開面板：全部 42 組

此十檔固定股票日線面板有存續偏差及公司行動／零股簿限制，兩段期間均已研究，不稱為未見過 OOS。每組保留完整原始報表。

| 期間 | 版本／假設 | 成交情境 | 淨損益 | 再扣期末估計出場成本 | 回撤% | 平倉數 | PF | 期望值 | 費／稅 | 完整性 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| earlier_studied | 原引擎程式策略代理 | optimistic | 1215.30 | 975.30 | 2.7764 | 13 | 0.7530 | -73.2385 | 946.00/347.00 | COMPLETED |
| earlier_studied | 僅修 Bug | optimistic | 1215.30 | 975.30 | 2.7764 | 13 | 0.7530 | -73.2385 | 946.00/347.00 | COMPLETED |
| earlier_studied | 趨勢進場確認 | optimistic | -80.00 | -113.00 | 0.0800 | 0 | — | — | 20.00/0.00 | COMPLETED |
| earlier_studied | ATR 出場 | optimistic | -1147.80 | -1493.80 | 3.3179 | 11 | 0.3915 | -200.4545 | 930.00/281.00 | COMPLETED |
| earlier_studied | 成本研究門檻 | optimistic | 1215.30 | 975.30 | 2.7764 | 13 | 0.7530 | -73.2385 | 946.00/347.00 | COMPLETED |
| earlier_studied | 組合風控研究 | optimistic | 1333.50 | 1041.50 | 1.6702 | 4 | 0.4036 | -138.9250 | 500.00/84.00 | COMPLETED |
| earlier_studied | 固定組合候選 | optimistic | -80.00 | -113.00 | 0.0800 | 0 | — | — | 20.00/0.00 | COMPLETED |
| earlier_studied | 原引擎程式策略代理 | neutral | 2433.05 | 2180.05 | 2.9202 | 9 | 1.1028 | 25.7611 | 1000.00/279.00 | COMPLETED |
| earlier_studied | 僅修 Bug | neutral | 2433.05 | 2180.05 | 2.9202 | 9 | 1.1028 | 25.7611 | 1000.00/279.00 | COMPLETED |
| earlier_studied | 趨勢進場確認 | neutral | 0.00 | 0.00 | 0.0000 | 0 | — | — | 0.00/0.00 | COMPLETED |
| earlier_studied | ATR 出場 | neutral | 1030.55 | 754.55 | 3.1951 | 6 | 0.6025 | -119.4083 | 860.00/209.00 | COMPLETED |
| earlier_studied | 成本研究門檻 | neutral | 2433.05 | 2180.05 | 2.9202 | 9 | 1.1028 | 25.7611 | 1000.00/279.00 | COMPLETED |
| earlier_studied | 組合風控研究 | neutral | 322.30 | 78.30 | 1.7625 | 3 | 0.2023 | -422.2667 | 420.00/69.00 | COMPLETED |
| earlier_studied | 固定組合候選 | neutral | 0.00 | 0.00 | 0.0000 | 0 | — | — | 0.00/0.00 | COMPLETED |
| earlier_studied | 原引擎程式策略代理 | conservative | 0.00 | 0.00 | 0.0000 | 0 | — | — | 0.00/0.00 | COMPLETED |
| earlier_studied | 僅修 Bug | conservative | 0.00 | 0.00 | 0.0000 | 0 | — | — | 0.00/0.00 | COMPLETED |
| earlier_studied | 趨勢進場確認 | conservative | 0.00 | 0.00 | 0.0000 | 0 | — | — | 0.00/0.00 | COMPLETED |
| earlier_studied | ATR 出場 | conservative | 0.00 | 0.00 | 0.0000 | 0 | — | — | 0.00/0.00 | COMPLETED |
| earlier_studied | 成本研究門檻 | conservative | 0.00 | 0.00 | 0.0000 | 0 | — | — | 0.00/0.00 | COMPLETED |
| earlier_studied | 組合風控研究 | conservative | 0.00 | 0.00 | 0.0000 | 0 | — | — | 0.00/0.00 | COMPLETED |
| earlier_studied | 固定組合候選 | conservative | 0.00 | 0.00 | 0.0000 | 0 | — | — | 0.00/0.00 | COMPLETED |
| later_studied | 原引擎程式策略代理 | optimistic | 1397.20 | 1187.20 | 2.4375 | 9 | 1.1827 | 39.5667 | 749.00/286.00 | COMPLETED |
| later_studied | 僅修 Bug | optimistic | 1397.20 | 1187.20 | 2.4375 | 9 | 1.1827 | 39.5667 | 749.00/286.00 | COMPLETED |
| later_studied | 趨勢進場確認 | optimistic | 0.00 | 0.00 | 0.0000 | 0 | — | — | 0.00/0.00 | COMPLETED |
| later_studied | ATR 出場 | optimistic | 2254.55 | 1974.55 | 3.5796 | 9 | 1.6764 | 183.9000 | 791.00/277.00 | COMPLETED |
| later_studied | 成本研究門檻 | optimistic | 1397.20 | 1187.20 | 2.4375 | 9 | 1.1827 | 39.5667 | 749.00/286.00 | COMPLETED |
| later_studied | 組合風控研究 | optimistic | -396.80 | -510.80 | 1.8800 | 9 | 0.5035 | -108.3111 | 648.00/226.00 | COMPLETED |
| later_studied | 固定組合候選 | optimistic | 0.00 | 0.00 | 0.0000 | 0 | — | — | 0.00/0.00 | COMPLETED |
| later_studied | 原引擎程式策略代理 | neutral | -2781.30 | -2888.30 | 3.4841 | 6 | 0.1999 | -437.5667 | 628.00/209.00 | COMPLETED |
| later_studied | 僅修 Bug | neutral | -2781.30 | -2888.30 | 3.4841 | 6 | 0.1999 | -437.5667 | 628.00/209.00 | COMPLETED |
| later_studied | 趨勢進場確認 | neutral | 0.00 | 0.00 | 0.0000 | 0 | — | — | 0.00/0.00 | COMPLETED |
| later_studied | ATR 出場 | neutral | 86.60 | -57.40 | 3.1699 | 7 | 0.3431 | -296.9857 | 589.00/171.00 | COMPLETED |
| later_studied | 成本研究門檻 | neutral | -2781.30 | -2888.30 | 3.4841 | 6 | 0.1999 | -437.5667 | 628.00/209.00 | COMPLETED |
| later_studied | 組合風控研究 | neutral | -3486.30 | -3583.30 | 3.4863 | 7 | 0.0000 | -559.2000 | 660.00/180.00 | COMPLETED |
| later_studied | 固定組合候選 | neutral | 0.00 | 0.00 | 0.0000 | 0 | — | — | 0.00/0.00 | COMPLETED |
| later_studied | 原引擎程式策略代理 | conservative | 0.00 | 0.00 | 0.0000 | 0 | — | — | 0.00/0.00 | COMPLETED |
| later_studied | 僅修 Bug | conservative | 0.00 | 0.00 | 0.0000 | 0 | — | — | 0.00/0.00 | COMPLETED |
| later_studied | 趨勢進場確認 | conservative | 0.00 | 0.00 | 0.0000 | 0 | — | — | 0.00/0.00 | COMPLETED |
| later_studied | ATR 出場 | conservative | 0.00 | 0.00 | 0.0000 | 0 | — | — | 0.00/0.00 | COMPLETED |
| later_studied | 成本研究門檻 | conservative | 0.00 | 0.00 | 0.0000 | 0 | — | — | 0.00/0.00 | COMPLETED |
| later_studied | 組合風控研究 | conservative | 0.00 | 0.00 | 0.0000 | 0 | — | — | 0.00/0.00 | COMPLETED |
| later_studied | 固定組合候選 | conservative | 0.00 | 0.00 | 0.0000 | 0 | — | — | 0.00/0.00 | COMPLETED |



## 2023–2024 更廣歷史：全部 40 組

官方 dated ALLBUT0999 橫斷面 459,845 筆、480 個有行情交易日、998 個四位代碼。按前一交易日成交額選 40 檔，沒有依盈虧刪除標的。記憶體子集是各期間所有歷史入池標的聯集及各檔此前最多 150 根完整日線。歷史完整證券主檔／OTC、實際零股簿、調整後公司行動與權益帳務仍不足。

四個區間按時間順序重播固定候選，沒有訓練、調參或挑出最好期間；策略假設曾受 2026 診斷啟發，因此這是較早歷史的穩健性研究，**不是純粹向前 walk-forward OOS**。獨立前瞻與 Shadow Trading 尚未完成。

| 區間 | 版本／敏感度 | 成交情境 | 淨損益 | 再扣期末估計出場成本 | 回撤% | 平倉數 | 期望值 | 完整性 | 未解公司行動日數 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2023_Q2 | 僅修 Bug | optimistic | 6481.45 | 6179.45 | 4.6586 | 41 | 115.2146 | PARTIAL | 1 |
| 2023_Q2 | ATR 出場 | optimistic | 9971.10 | 9663.10 | 4.8585 | 30 | 42.1400 | COMPLETED | 0 |
| 2023_Q2 | 固定組合候選 | optimistic | 21.30 | -13.70 | 0.2986 | 1 | 3.5000 | COMPLETED | 0 |
| 2023_Q2 | 僅修 Bug | neutral | -1437.85 | -1810.85 | 6.6524 | 33 | -44.7106 | PARTIAL | 1 |
| 2023_Q2 | ATR 出場 | neutral | 10309.40 | 9858.40 | 7.0119 | 22 | -216.6386 | PARTIAL | 1 |
| 2023_Q2 | 固定組合候選 | neutral | -22.50 | -57.50 | 0.3254 | 1 | -29.5000 | COMPLETED | 0 |
| 2023_Q2 | 僅修 Bug | conservative | 0.00 | 0.00 | 0.0000 | 0 | — | COMPLETED | 0 |
| 2023_Q2 | ATR 出場 | conservative | 0.00 | 0.00 | 0.0000 | 0 | — | COMPLETED | 0 |
| 2023_Q2 | 固定組合候選 | conservative | 0.00 | 0.00 | 0.0000 | 0 | — | COMPLETED | 0 |
| 2023_H2 | 僅修 Bug | optimistic | 2479.80 | 2126.80 | 13.6603 | 81 | 5.5383 | COMPLETED | 0 |
| 2023_H2 | ATR 出場 | optimistic | 3736.60 | 3266.60 | 14.1908 | 69 | -17.9442 | COMPLETED | 0 |
| 2023_H2 | 固定組合候選 | optimistic | -412.80 | -412.80 | 0.4128 | 1 | -412.8000 | COMPLETED | 0 |
| 2023_H2 | 僅修 Bug | neutral | -2654.50 | -3022.50 | 14.8613 | 81 | -65.5543 | COMPLETED | 0 |
| 2023_H2 | ATR 出場 | neutral | 3241.30 | 2772.30 | 14.9862 | 58 | -56.4043 | COMPLETED | 0 |
| 2023_H2 | 固定組合候選 | neutral | -442.10 | -442.10 | 0.4456 | 1 | -442.1000 | COMPLETED | 0 |
| 2023_H2 | 僅修 Bug | conservative | 0.00 | 0.00 | 0.0000 | 0 | — | COMPLETED | 0 |
| 2023_H2 | ATR 出場 | conservative | 0.00 | 0.00 | 0.0000 | 0 | — | COMPLETED | 0 |
| 2023_H2 | 固定組合候選 | conservative | 0.00 | 0.00 | 0.0000 | 0 | — | COMPLETED | 0 |
| 2024_H1 | 僅修 Bug | optimistic | 8046.05 | 7752.05 | 5.0367 | 88 | 86.6750 | COMPLETED | 0 |
| 2024_H1 | ATR 出場 | optimistic | 10605.80 | 10296.80 | 5.3900 | 70 | 129.3186 | COMPLETED | 0 |
| 2024_H1 | 固定組合候選 | optimistic | -104.60 | -104.60 | 0.2596 | 2 | -52.3000 | COMPLETED | 0 |
| 2024_H1 | 僅修 Bug | neutral | -2948.90 | -3259.90 | 9.5329 | 76 | -48.7493 | COMPLETED | 0 |
| 2024_H1 | ATR 出場 | neutral | 6574.35 | 6272.35 | 6.9906 | 67 | 21.7134 | COMPLETED | 0 |
| 2024_H1 | 固定組合候選 | neutral | -155.00 | -155.00 | 0.2677 | 2 | -77.5000 | COMPLETED | 0 |
| 2024_H1 | 僅修 Bug | conservative | 0.00 | 0.00 | 0.0000 | 0 | — | COMPLETED | 0 |
| 2024_H1 | ATR 出場 | conservative | 0.00 | 0.00 | 0.0000 | 0 | — | COMPLETED | 0 |
| 2024_H1 | 固定組合候選 | conservative | 0.00 | 0.00 | 0.0000 | 0 | — | COMPLETED | 0 |
| 2024_H2 | 僅修 Bug | optimistic | -22906.10 | -23128.10 | 22.9479 | 97 | -232.9892 | PARTIAL | 1 |
| 2024_H2 | ATR 出場 | optimistic | -18882.70 | -19268.70 | 21.1652 | 77 | -277.9442 | PARTIAL | 1 |
| 2024_H2 | 固定組合候選 | optimistic | -851.20 | -851.20 | 0.8512 | 3 | -283.7333 | COMPLETED | 0 |
| 2024_H2 | 僅修 Bug | neutral | -23498.65 | -23792.65 | 25.5027 | 73 | -331.7493 | PARTIAL | 2 |
| 2024_H2 | ATR 出場 | neutral | -22744.05 | -23100.05 | 25.3032 | 67 | -405.4634 | PARTIAL | 2 |
| 2024_H2 | 固定組合候選 | neutral | -916.80 | -916.80 | 0.9168 | 2 | -458.4000 | COMPLETED | 0 |
| 2024_H2 | 僅修 Bug | conservative | 0.00 | 0.00 | 0.0000 | 0 | — | COMPLETED | 0 |
| 2024_H2 | ATR 出場 | conservative | 0.00 | 0.00 | 0.0000 | 0 | — | COMPLETED | 0 |
| 2024_H2 | 固定組合候選 | conservative | 0.00 | 0.00 | 0.0000 | 0 | — | COMPLETED | 0 |
| 2024_H2 | sensitivity_min_entry_reward_risk_1.5 | neutral | 0.00 | 0.00 | 0.0000 | 0 | — | COMPLETED | 0 |
| 2024_H2 | sensitivity_min_entry_reward_risk_1.8 | neutral | 0.00 | 0.00 | 0.0000 | 0 | — | COMPLETED | 0 |
| 2024_H2 | sensitivity_max_trade_risk_fraction_0.008 | neutral | -23314.95 | -23580.95 | 25.5027 | 74 | -334.0865 | PARTIAL | 2 |
| 2024_H2 | sensitivity_watch_remove_after_scans_6 | neutral | -20700.20 | -20998.20 | 22.7902 | 81 | -297.1253 | PARTIAL | 2 |



## 判讀與未晉升原因

- 趨勢確認與固定組合候選大多等待或零成交；增加 AND 條件沒有自動產生高品質交易，不能因保留現金就宣布優化成功。

- ATR 出場在部分區間改善、其他區間仍虧損；再扣期末估計費稅後及跨成交情境沒有一致可晉升證據。未把停損拉大當成結論，也未開啟正式研究旗標。

- 兩倍費稅成本研究門檻在既有面板未改變成交：既有淨 RR 與股數限制已先篩除相關交易。這個無效果實驗也保留，不宣稱解決負期望值。

- 組合風控研究在近期面板反而惡化；不因其名稱是風控就自動部署。

- 原始 2634、3665、2383、8299、3324 等交易缺原始明細，無法誠實判定追高、壓力、跳空、停利太早或市場型態的因果。新的描述性歸因分拆原始費稅、報價差、模型價格影響；選股／進場／市場殘差保持不可識別，舊報價缺漏保持 null。

- 3340 掃描、374 新增、357 移除是使用者提供數字，尚未獨立重算。已修正完整觀測事件保存，保留 3 次遲滯原則並測試 6 次保留的預先指定敏感度；不為填滿 50% 軟目標放寬風控。



## 唯一 Entry Funnel

下表選取預先指定的近期中性「僅修 Bug」代理作診斷展示，不能冒充缺失的原始 AI 漏斗。唯一策略／股票不因掃描、lot 或跨日重掛重算；同一訊號可曾阻擋後再通過，拒絕原因不得相加為獨立機會。

| 階段 | 已觀測 | 曾通過 | 無此要求 | 曾阻擋 | 未觀測 | 依序轉換 |
| --- | --- | --- | --- | --- | --- | --- |
| CANDIDATE | 160 | 160 | 0 | 0 | 0 | 160 |
| DATA | 160 | 160 | 0 | 150 | 0 | 160 |
| TREND | 160 | 97 | 0 | 110 | 0 | 97 |
| TRIGGER | 97 | 61 | 0 | 55 | 63 | 61 |
| COST | 51 | 50 | 0 | 1 | 109 | 50 |
| RISK | 61 | 19 | 0 | 46 | 99 | 19 |
| SUBMITTED | 19 | 19 | 0 | 0 | 141 | 19 |
| FILLED | 19 | 19 | 0 | 0 | 141 | 19 |



| 階段 | 拒絕碼 | 唯一訊號 | 重複樣本 |
| --- | --- | --- | --- |
| DATA | RULE_DATA | 150 | 893 |
| TREND | SCREENING_FILTER | 94 | 491 |
| TRIGGER | RULE_TRIGGER | 55 | 176 |
| TREND | RULE_TREND | 37 | 136 |
| RISK | FINAL_RISK_ENGINE | 35 | 94 |
| RISK | RULE_RISK | 12 | 32 |
| COST | FINAL_NET_ECONOMICS | 1 | 2 |



## 完整性與可重現性

每組從原始成交獨立重算 FIFO、費稅、庫存、現金加交割及期末淨值。COMPLETED 僅表示宣告資料與假設下的必要重播流程完成；資料／成交模型限制仍在報表及正式資格阻擋中。PARTIAL 的估值、未解公司行動及缺資料原因必須保留，不能用帳務恆等式通過替代市場資料可信度。

初步 40 組中的 2023/08/03 缺資料，後由交易所 8/2 公告確認為颱風休市及交割順延；修正後依相同參數重跑。初步結果、第一次示範與 GUI 失敗均保留。最後固定版重跑沒有修改參數或排除不利股票。

所有 82 組比較指標（含勝率、平均盈虧、週轉、曝險、Sharpe、成本、拒絕原因與資料覆蓋）見 [results.json](results.json) / [results.csv](results.csv)。完整行情、全部逐筆報表與驗證紀錄另提供壓縮包；不含使用者帳戶或憑證。



## 正式交易判定

**可繼續歷史研究及受限制的模擬驗證；尚未具備正式交易條件。** 即時模擬還需在使用者本機確認行情來源、長時間連線恢復、券商差異及 Shadow Trading。獨立 OOS、足量扣費正期望樣本、保守成交穩健性、完整公司行動／歷史證券資格及原始基準仍未通過。即使未來達標，也須使用者明確同意才能授權正式下單；本版以 `LIVE_VALIDATION_PENDING` 停用 trade scope，撤單另經帳戶與明確動作核對。



## 待補的原始證據

需要本次 v0.1.5 的 `Codex-execution-history(3).json`（或同次完整原始檔）、對應回測 JSON 及該次完整行情 JSON。只附摘要或 v0.1.3 舊檔不能完成原始交易核對、原始策略固定回覆重播及 9/9 全呼叫根因。不要提供 API Key、Secret 或 CA 密碼。



## 工程驗收證據

[Actions 39834203890](https://github.com/jackyname1/shioaji-codex-trader/actions/runs/39834203890) 對來源 `b95de61253ad88b3e325d8811239023f4086e457` 執行 Linux 444/444、Windows 444/444，零失敗及零跳過。來源與封裝 Windows GUI 均通過，包含實際結果頁、12 種匯出、曲線與帳務統計一致性；封裝測試紀錄為 `packaged=true`、`status=PASSED`。11 張實際 Windows 合成資料截圖及來源／圖檔雜湊隨版本保存。這些是工程驗收，不替代策略獲利驗證。
