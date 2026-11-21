$ErrorActionPreference = 'SilentlyContinue'
$root = Join-Path $env:LOCALAPPDATA 'beauticode'
$desktop = [Environment]::GetFolderPath('Desktop')
if (-not $desktop) { $desktop = Join-Path $env:USERPROFILE 'Desktop' }
$shortcutPath = Join-Path $desktop 'Doubao - DreamSkin.lnk'
$startup = [Environment]::GetFolderPath('Startup')
if (-not $startup) { $startup = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup' }
$vbsPath = Join-Path $startup 'beauticode-doubao-runner.vbs'

Remove-Item -LiteralPath $shortcutPath -Force
Remove-Item -LiteralPath $vbsPath -Force

Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
  Where-Object { $_.CommandLine -match 'runtime\\doubao\\launcher\.ps1' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'desktop-cdp-runner' -and $_.CommandLine -match 'doubao' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Remove-Item -LiteralPath (Join-Path $root 'runtime\doubao') -Recurse -Force
Remove-Item -LiteralPath (Join-Path $root 'doubao-launch.ps1') -Force

Write-Host 'Doubao DreamSkin adapter removed. Themes and state were kept.'

