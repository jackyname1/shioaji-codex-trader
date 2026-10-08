param([Parameter(Mandatory=$true)][string]$Executable, [switch]$Remove)
$ErrorActionPreference = 'Stop'
$Startup = [Environment]::GetFolderPath('Startup')
$ShortcutPath = Join-Path $Startup 'ShioajiTrader.lnk'
if ($Remove) {
    if (Test-Path $ShortcutPath) { Remove-Item $ShortcutPath }
    exit
}
$Resolved = (Resolve-Path $Executable).Path
$ShellObject = New-Object -ComObject WScript.Shell
$Shortcut = $ShellObject.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = $Resolved
$Shortcut.Arguments = '--minimized'
$Shortcut.WorkingDirectory = Split-Path $Resolved -Parent
$Shortcut.Save()
Write-Host 'Startup shortcut created. No credentials were saved in the shortcut.'
