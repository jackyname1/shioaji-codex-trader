# 設定參數 · v0.1.0

比率使用 0–1（0.25 = 25%），金額為 TWD。表列為全新設定預設值，已保存偏好優先；授權風控界線強制套用，較嚴格值保留。完整 JSON 使用嚴格結構驗證，不接受未知欄位。

## 調整方式

- 帳戶連線：API／Secret／CA 透過獨立加密儲存，不屬於設定 JSON。證券帳戶序號在交易風控設定。
- 日常排程：固定或間隔二選一，每日最多 2 次為省用量預設，可調 1–50；補跑 1–60 分鐘。監測 1–300 秒、股票池更新 1–60 分鐘。
- 歷史回測：獨立保存 6 個排程與用量欄位，整次／整批上限可調 1–2000，預設 20。回測本金與整股偏好另可設定；啟動後設定固定。
- 交易風控：現金至少 25%，單筆不超過可投資資金 10%，單檔 20%、總持倉 75%、日新增 20%／5 筆、日損失 2%。現金與總持倉合計不可超過 100%。
- 進階與桌面：保護、成本估計、經驗、官方事實、注意股票及桌面偏好。研究選項只用於明確啟用的模擬／比較。
- 模型與推理：主視窗右上直接設定；其他研究、策略指令及相容欄位保留在完整 JSON。模式與交易啟停透過工作台操作。

## 完整參數索引

| 參數 | 用途 | 全新預設 | 修改入口 |
|---|---|---|---|
| `mode` | 工作區模式 | `paper` | 工作台控制 |
| `auto_execute` | 自動交易狀態 | `false` | 工作台控制 |
| `whole_lots` | 允許整股與盤中零股 | `false` | 設定頁 |
| `base_url` | 本機服務網址 | `http://127.0.0.1:8080` | 系統管理本機連接埠 |
| `manage_quote_subscriptions` | 管理此程式的行情訂閱 | `true` | 設定頁 |
| `stock_account_index` | 證券帳戶序號 | `0` | 設定頁 |
| `min_cash_fraction` | 保留現金 · 比率 | `0.25` | 設定頁 |
| `max_order_fraction` | 單筆上限 · 比率 | `0.10` | 設定頁 |
| `order_budget_basis` | 單筆計算基準 | `AFTER_RESERVE` | 設定頁 |
| `target_exposure_fraction` | 目標持倉 · 比率 | `0.50` | 設定頁 |
| `min_entry_reward_risk` | 扣費報酬風險比門檻 | `0` | 設定頁 |
| `max_trade_risk_fraction` | 單筆停損風險 · 比率 | `0` | 設定頁 |
| `max_symbol_fraction` | 單檔上限 · 比率 | `0.20` | 設定頁 |
| `max_exposure_fraction` | 總持倉上限 · 比率 | `0.75` | 設定頁 |
| `max_daily_buy_fraction` | 每日新增買進上限 · 比率 | `0.20` | 設定頁 |
| `max_daily_buy_orders` | 每日新增買進 · 筆 | `5` | 設定頁 |
| `daily_loss_fraction` | 日損失停單 · 比率 | `0.02` | 設定頁 |
| `price_deviation_fraction` | 價格偏離上限 · 比率 | `0.03` | 設定頁 |
| `max_spread_fraction` | 買賣價差上限 · 比率 | `0.02` | 設定頁 |
| `quote_max_age` | 行情有效秒數 | `30` | 設定頁 |
| `account_max_age` | 帳務有效秒數 | `60` | 設定頁 |
| `cooldown_seconds` | 重複交易冷卻 · 秒 | `120` | 設定頁 |
| `fee_rate` | 手續費率 | `0.001425` | 設定頁 |
| `minimum_fee` | 最低手續費 | `20` | 設定頁 |
| `sell_tax_rate` | 賣出交易稅率 | `0.003` | 設定頁 |
| `entry_strategy_mode` | 程式進場策略 | `legacy` | 設定頁 |
| `entry_policy` | 進場確認策略 | `legacy` | 設定頁 |
| `execution_sizing` | 數量確認 | `deterministic` | 設定頁 |
| `adaptive_protection` | ATR 移動保護與費稅保本 | `true` | 設定頁 |
| `dynamic_allocation` | 動態配置（研究選項） | `false` | 設定頁 |
| `risk_slippage_fraction` | 預估退出滑價 · 比率 | `0.001` | 設定頁 |
| `overnight_gap_fraction` | 隔夜跳空壓測 · 比率 | `0.05` | 設定頁 |
| `max_gap_risk_fraction` | 跳空壓測虧損上限 · 比率 | `0.02` | 設定頁 |
| `min_net_profit_twd` | 最低預期淨利 · 元 | `60` | 設定頁 |
| `entry_tracking_minutes` | 回檔追蹤期限 · 分鐘 | `90` | 設定頁 |
| `portfolio_risk_enabled` | 組合風險研究 | `false` | 進階 JSON |
| `portfolio_components` | 組合研究組件 | `all` | 進階 JSON |
| `portfolio_drawdown_fraction` | 研究回撤門檻 | `0.04` | 進階 JSON |
| `portfolio_cooldown_sessions` | 研究冷卻交易日 | `2` | 進階 JSON |
| `portfolio_loss_streak` | 研究連敗門檻 | `3` | 進階 JSON |
| `entry_quality_enabled` | 進場品質研究 | `false` | 進階 JSON |
| `max_portfolio_stop_fraction` | 組合停損預算研究 | `0` | 進階 JSON |
| `prompt_compaction` | 提示壓縮研究 | `false` | 進階 JSON |
| `research_exit_mode` | 研究退場模式 | `baseline` | 進階 JSON |
| `allow_attention` | 允許注意股票 | `false` | 設定頁 |
| `codex_enabled` | Codex 啟用狀態 | `false` | 工作台控制 |
| `experience_enabled` | 使用歷史策略經驗 | `true` | 設定頁 |
| `experience_limit` | 經驗紀錄上限 · 筆 | `40` | 設定頁 |
| `official_facts_enabled` | 查核官方公開事實 | `true` | 設定頁 |
| `codex_path` | 內建 CLI 路徑覆寫 | `空白` | 進階 JSON |
| `codex_model` | 模型 | `空白` | 主視窗 Codex |
| `codex_instruction` | 策略指令 | `動態挑選台灣普通現股，保留現金，依趨勢、量能與風控設定進場、停損、停利；資料不足時觀望。` | 進階 JSON |
| `codex_reasoning` | 推理強度 | `default` | 主視窗 Codex |
| `codex_timeout_seconds` | Codex 等待上限 · 秒 | `300` | 設定頁 |
| `premarket_time` | 舊設定相容欄位（不安排模型） | `08:40` | 系統相容；不需修改 |
| `postmarket_time` | 盤後檢討時間 | `14:00` | 設定頁 |
| `codex_frequency_version` | 排程遷移版本 | `1` | 系統相容；不需修改 |
| `codex_daily_call_limit` | 每日 Codex 上限 | `2` | 設定頁 |
| `postmarket_review_enabled` | 額外盤後檢討 | `false` | 設定頁 |
| `replay_strategy_schedule` | 策略排程 | `fixed` | 設定頁 |
| `replay_strategy_times` | 回測固定時間 | `09:15` | 設定頁 |
| `replay_interval_minutes` | 分析間隔 · 分鐘 | `360` | 設定頁 |
| `replay_max_codex_calls` | 整次／整批 Codex 上限 | `20` | 設定頁 |
| `replay_review_enabled` | 額外盤後檢討 | `false` | 設定頁 |
| `replay_execution_sizing` | 股數確認 | `deterministic` | 設定頁 |
| `strategy_schedule` | 策略排程 | `fixed` | 設定頁 |
| `strategy_times` | 日常固定時間 | `09:15,11:45` | 設定頁 |
| `schedule_catch_up_minutes` | 錯過排程補跑 · 分鐘 | `20` | 設定頁 |
| `decision_interval_minutes` | 分析間隔 · 分鐘 | `180` | 設定頁 |
| `monitor_interval_seconds` | 條件偵測 · 秒 | `3` | 設定頁 |
| `watch_refresh_minutes` | 觀測更新 · 分鐘 | `5` | 設定頁 |
| `auto_watchlist` | 自動更新觀測清單 | `true` | 設定頁 |
| `watch_max_symbols` | 最多監測股票 | `12` | 設定頁 |
| `watch_remove_after_scans` | 移除前不符次數 | `3` | 設定頁 |
| `watch_min_amount` | 最低成交金額 | `20000000` | 設定頁 |
| `plan_max_minutes` | 策略有效期上限 · 分鐘 | `360` | 設定頁 |
| `candidate_pool_size` | 候選股票池 · 檔 | `40` | 設定頁 |
| `demo_cash` | 模擬本金 | `100000` | 設定頁 |
| `start_minimized` | 開啟後縮小至系統匣 | `false` | 設定頁 |
| `keep_awake` | 執行期間避免系統睡眠 | `true` | 設定頁 |

## 核對與相容性

此次核對全部 80 個設定欄位的單位、預設、儲存與入口。補上常用缺漏欄位，金額及比率接受既有有效精度，整數保留範圍限制；儲存時由後端再次驗證。

保留省用量預設、原趨勢進場、程式股數核算與 ATR 保護，未啟用三策略／動態配置與組合研究。沒有依回測表現自動挑選或放寬風險參數。版本重編不重置本機資料、每日用量及報表格式版本。premarket_time 僅保留讀取相容，實際分析以 strategy_times 或間隔排程為準。
