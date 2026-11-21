param(
  [switch]$SkipShortcuts
)

$ErrorActionPreference = 'Stop'
$root = Join-Path $env:LOCALAPPDATA 'beauticode'
$runtimeSource = Join-Path $PSScriptRoot 'runtime'
$runtimeDest = Join-Path $root 'runtime\workbuddy'
$launcherSource = Join-Path $PSScriptRoot 'launcher'
$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

function Find-Node {
  $candidates = @()
  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($cmd) { $candidates += $cmd.Source }
  $candidates += @(
    (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'),
    (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
    'C:\Program Files\nodejs\node.exe'
  )
  foreach ($candidate in $candidates) {
    if (-not $candidate -or -not (Test-Path -LiteralPath $candidate)) { continue }
    try {
      $version = (& $candidate --version).Trim()
      if ($version -match '^v(\d+)' -and [int]$Matches[1] -ge 22) { return $candidate }
    } catch {}
  }
  throw 'Node.js 22 or newer is required. Install Node.js 22+ and add it to PATH.'
}

$node = Find-Node
Write-Host "Node.js: $node"

New-Item -ItemType Directory -Path $runtimeDest -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $root 'logs') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $root 'hosts\workbuddy') -Force | Out-Null

Copy-Item -Path (Join-Path $runtimeSource '*') -Destination $runtimeDest -Recurse -Force
Copy-Item -LiteralPath (Join-Path $launcherSource 'wb-launch.ps1') -Destination (Join-Path $root 'wb-launch.ps1') -Force
Copy-Item -LiteralPath (Join-Path $launcherSource 'wb-watch.ps1') -Destination (Join-Path $root 'wb-watch.ps1') -Force

if (-not $SkipShortcuts) {
  $desktop = [Environment]::GetFolderPath('Desktop')
  if (-not $desktop) { $desktop = Join-Path $env:USERPROFILE 'Desktop' }
  $shortcutPath = Join-Path $desktop 'WorkBuddy - DreamSkin.lnk'
  $icon = $ps + ',0'
  $workBuddyExe = Join-Path $env:LOCALAPPDATA 'Programs\WorkBuddyAI\WorkBuddyAI.exe'
  if (-not (Test-Path -LiteralPath $workBuddyExe)) {
    $workBuddyExe = Join-Path $env:ProgramFiles 'WorkBuddyAI\WorkBuddyAI.exe'
  }
  if (Test-Path -LiteralPath $workBuddyExe) { $icon = $workBuddyExe + ',0' }

  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = $ps
  $shortcut.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $root 'wb-launch.ps1') + '"'
  $shortcut.WorkingDirectory = $root
  $shortcut.IconLocation = $icon
  $shortcut.Description = 'WorkBuddy with DreamSkin themes'
  $shortcut.Save()

  $startup = [Environment]::GetFolderPath('Startup')
  if (-not $startup) { $startup = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup' }
  $vbsPath = Join-Path $startup 'beauticode-workbuddy-watch.vbs'
  $vbs = @"
Set sh = CreateObject("WScript.Shell")
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""$(Join-Path $root 'wb-watch.ps1')""", 0, False
"@
  Set-Content -LiteralPath $vbsPath -Value $vbs -Encoding Unicode
  Write-Host "Shortcut: $shortcutPath"
  Write-Host "Startup:  $vbsPath"

  $watchArgs = @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"' + (Join-Path $root 'wb-watch.ps1') + '"'))
  Start-Process -FilePath $ps -ArgumentList $watchArgs -WindowStyle Hidden
}

Write-Host ''
Write-Host 'WorkBuddy DreamSkin adapter installed.'
Write-Host 'Launch it with the "WorkBuddy - DreamSkin" desktop shortcut.'
Write-Host 'If WorkBuddy is already open, close and reopen it once so the CDP runner can attach.'
