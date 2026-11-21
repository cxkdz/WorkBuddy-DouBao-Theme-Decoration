$ErrorActionPreference = 'SilentlyContinue'
$root = Join-Path $env:LOCALAPPDATA 'beauticode'
$desktop = [Environment]::GetFolderPath('Desktop')
if (-not $desktop) { $desktop = Join-Path $env:USERPROFILE 'Desktop' }
$shortcutPath = Join-Path $desktop 'WorkBuddy - DreamSkin.lnk'
$startup = [Environment]::GetFolderPath('Startup')
if (-not $startup) { $startup = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup' }
$vbsPath = Join-Path $startup 'beauticode-workbuddy-watch.vbs'

Remove-Item -LiteralPath $shortcutPath -Force
Remove-Item -LiteralPath $vbsPath -Force

Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
  Where-Object { $_.CommandLine -match 'wb-watch\.ps1|runtime\\workbuddy\\launcher\.ps1' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'runtime\\workbuddy' -and $_.CommandLine -match 'wb-cdp-runner' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Remove-Item -LiteralPath (Join-Path $root 'runtime\workbuddy') -Recurse -Force
Remove-Item -LiteralPath (Join-Path $root 'wb-launch.ps1') -Force
Remove-Item -LiteralPath (Join-Path $root 'wb-watch.ps1') -Force

Write-Host 'WorkBuddy DreamSkin adapter removed. Themes and state were kept.'
