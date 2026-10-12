# Windows 發行者與 SmartScreen

檔案內容中的 author／CompanyName 是產品中繼資料；Windows 的「已驗證發行者」來自可信 Authenticode 憑證，不能用名稱取代。有效簽章也不保證新版本立即不出現 SmartScreen 提示：Windows 會累積軟體與簽署身分的信譽。自簽憑證僅適合開發，不會解決公開下載的警告。

目前未設定可信簽章憑證時，建置會明確標記為未簽章，WINDOWS-SIGNATURE.json 的 publisher 為 null；不會宣稱已驗證發行者，也不會停用 Windows 防護。

## 已有可信程式碼簽署憑證

GitHub Actions 目前支援以下方式：

- 在儲存庫 Secrets 設定 WINDOWS_SIGNING_PFX_BASE64、WINDOWS_SIGNING_PFX_PASSWORD，僅用於既有可合法匯出的程式碼簽署憑證。
- 使用已設定憑證或雲端 HSM/KSP 的 Windows 建置機，設定 Variable WINDOWS_SIGNING_CERTIFICATE_SHA1；憑證需在執行帳號的 CurrentUser/My，私鑰由該機可存取。硬體或雲端服務需依供應商安裝並使用具相應權限的建置機。
- 設定 Variable WINDOWS_SIGNING_REQUIRED=true，缺少憑證或驗證失敗時，建置與發行會直接停止，不退回未簽章版本。

不要把金鑰或密碼貼在對話、程式碼或設定檔。Shioaji 的 CA 是券商身分憑證，不能拿來簽署 Windows 程式；建置會檢查 Code Signing EKU 並拒絕不適用的憑證。

簽署流程先建置獨立程式目錄，簽署本專案主程式，再封裝及簽署免安裝 EXE。只處理這兩個檔案，不重簽官方 Shioaji／Codex 執行檔。Shioaji 原始 SHA-256 前後均會核對。簽章使用 SHA-256 與可信時間戳，密碼不放進命令列。發行前核對兩個實際簽章、同一簽署身分、時間戳、產品版本與下載檔雜湊；結果隨 Release 提供。

## 尚未有憑證

需要先完成可信憑證服務的身分驗證。第三方 CA 的程式碼簽署服務、硬體金鑰或雲端 HSM 可依供應商方式接入。取得新 OV／EV 憑證後，SmartScreen 仍可能需要時間建立信譽。

Microsoft Store 的 MSIX 發行由 Store 重新簽署，是另一條路線；需要開發者註冊、產品送審與發行設定，不等於 GitHub 的免安裝 EXE 發行。

官方說明：

- https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options
- https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation
- https://learn.microsoft.com/en-us/windows/win32/seccrypto/signtool
