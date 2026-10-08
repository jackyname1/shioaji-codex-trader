$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
$Python = '.\.venv\Scripts\python.exe'
& $Python -m unittest discover -s tests -v
if ($LASTEXITCODE -ne 0) { throw 'Tests failed' }
& $Python -m PyInstaller --noconfirm --clean --onedir --windowed --name ShioajiTrader --collect-all shioaji --collect-all tzdata --collect-all keyring --hidden-import keyring.backends.Windows scripts/desktop_entry.py
if ($LASTEXITCODE -ne 0) { throw 'Desktop build failed' }
& $Python -m PyInstaller --noconfirm --clean --onedir --console --name ShioajiTraderCLI --collect-all shioaji --collect-all tzdata --collect-all keyring --hidden-import keyring.backends.Windows scripts/cli_entry.py
if ($LASTEXITCODE -ne 0) { throw 'CLI build failed' }
Write-Host 'Distribute the entire dist folders, including _internal.'
