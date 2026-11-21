param(
  [switch]$SkipShortcuts
)

$ErrorActionPreference = 'Stop'
$root = Join-Path $env:LOCALAPPDATA 'beauticode'
$runtimeSource = Join-Path $PSScriptRoot 'runtime'
$runtimeDest = Join-Path $root 'runtime\doubao'
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
New-Item -ItemType Directory -Path (Join-Path $root 'hosts\doubao') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $root 'logs') -Force | Out-Null

Copy-Item -Path (Join-Path $runtimeSource '*') -Destination $runtimeDest -Recurse -Force
Copy-Item -LiteralPath (Join-Path $launcherSource 'doubao-launch.ps1') -Destination (Join-Path $root 'doubao-launch.ps1') -Force

$exeCandidates = @(
  (Join-Path $env:LOCALAPPDATA 'Doubao\app\Doubao.exe'),
  (Join-Path $env:ProgramFiles 'Doubao\app\Doubao.exe'),
  'D:\Doubao\app\Doubao.exe'
)
$doubaoExe = $exeCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
$icon = if ($doubaoExe) { $doubaoExe + ',0' } else { $ps + ',0' }

if (-not $SkipShortcuts) {
  $desktop = [Environment]::GetFolderPath('Desktop')
  if (-not $desktop) { $desktop = Join-Path $env:USERPROFILE 'Desktop' }
  $shortcutPath = Join-Path $desktop 'Doubao - DreamSkin.lnk'
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = $ps
  $shortcut.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $root 'doubao-launch.ps1') + '"'
  $shortcut.WorkingDirectory = $root
  $shortcut.IconLocation = $icon
  $shortcut.Description = 'Doubao with DreamSkin themes'
  $shortcut.Save()

  $startup = [Environment]::GetFolderPath('Startup')
  if (-not $startup) { $startup = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup' }
  $vbsPath = Join-Path $startup 'beauticode-doubao-runner.vbs'
  $launcherPath = Join-Path $runtimeDest 'launcher.ps1'
  $pidPath = Join-Path $root 'hosts\doubao\runner.pid'
  $vbs = @"
Set sh = CreateObject("WScript.Shell")
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""$launcherPath"" --host doubao --watchdog --pid-file ""$pidPath""", 0, False
"@
  Set-Content -LiteralPath $vbsPath -Value $vbs -Encoding Unicode
  Write-Host "Shortcut: $shortcutPath"
  Write-Host "Startup:  $vbsPath"

  $runnerArgs = @('-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',('"' + $launcherPath + '"'),'--host','doubao','--watchdog','--pid-file',('"' + $pidPath + '"'))
  Start-Process -FilePath $ps -ArgumentList $runnerArgs -WindowStyle Hidden
}

Write-Host ''
Write-Host 'Doubao DreamSkin adapter installed.'
Write-Host 'Launch it with the "Doubao - DreamSkin" desktop shortcut.'
Write-Host 'If Doubao is already open without CDP, the shortcut will restart it once.'

