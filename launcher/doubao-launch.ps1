$ErrorActionPreference = 'SilentlyContinue'
$local = $env:LOCALAPPDATA
$launcher = Join-Path $local 'beauticode\runtime\doubao\launcher.ps1'
$pidFile = Join-Path $local 'beauticode\hosts\doubao\runner.pid'
$quickState = Join-Path $local 'beauticode\hosts\doubao\quick-launch.json'
$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

function Write-LaunchLog([string]$message) {
  try {
    $dir = Split-Path -Parent $quickState
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    Add-Content -LiteralPath (Join-Path $dir 'icon-launch.log') -Value ((Get-Date).ToUniversalTime().ToString('o') + ' ' + $message) -Encoding UTF8
  } catch {}
}

function Test-DoubaoRunner {
  try {
    $procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
      Where-Object { $_.CommandLine -and $_.CommandLine -match 'desktop-cdp-runner' -and $_.CommandLine -match 'doubao' }
    return [bool]$procs
  } catch { return $false }
}

function Start-DoubaoRunner {
  $runnerArgs = @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
    '-File', ('"' + $launcher + '"'),
    '--host', 'doubao', '--watchdog', '--pid-file', ('"' + $pidFile + '"')
  )
  Start-Process -FilePath $ps -ArgumentList $runnerArgs -WindowStyle Hidden
}

function Get-DoubaoMainProcess {
  return Get-CimInstance Win32_Process -Filter "Name='Doubao.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine -notmatch '--type=' } |
    Select-Object -First 1
}

& $launcher --quick-launch
$quickExit = $LASTEXITCODE
$quickReason = ''
try {
  $state = Get-Content -LiteralPath $quickState -Raw | ConvertFrom-Json
  if ($state -and $state.result -eq 'failed') { $quickReason = [string]$state.reason }
} catch {}

# A normal first launch is CDP-enabled. If Doubao is already running blind
# (for example started from the taskbar), quick-launch deliberately refuses to
# relaunch it. Restarting it once is the only way to regain CDP and let the
# wallpaper attach; do it only for this explicit, non-destructive failure.
if ($quickExit -ne 0 -and $quickReason -eq 'already-running-without-cdp') {
  $main = Get-DoubaoMainProcess
  if ($main) {
    Write-LaunchLog ('restarting blind main pid=' + $main.ProcessId)
    try {
      $proc = Get-Process -Id ([int]$main.ProcessId) -ErrorAction Stop
      $null = $proc.CloseMainWindow()
      $null = $proc.WaitForExit(8000)
      if (-not $proc.HasExited) { Stop-Process -Id ([int]$main.ProcessId) -Force -ErrorAction SilentlyContinue }
    } catch {}
    Start-Sleep -Seconds 2
    & $launcher --quick-launch
    $quickExit = $LASTEXITCODE
    Write-LaunchLog ('restart quick-exit=' + $quickExit)
  }
} elseif ($quickExit -ne 0) {
  Write-LaunchLog ('quick-launch failed reason=' + $quickReason)
}

# The shortcut must also keep the runner alive. Without it the app opens but
# no wallpaper is injected.
if (-not (Test-DoubaoRunner)) { Start-DoubaoRunner }

# Only fall back to a plain app launch when no Doubao process exists. Starting
# a second copy while one is already open would create a blind instance.
if ($quickExit -ne 0) {
  $main = Get-DoubaoMainProcess
  if (-not $main) {
    $candidates = @(
      (Join-Path $env:LOCALAPPDATA 'Doubao\app\Doubao.exe'),
      (Join-Path $env:ProgramFiles 'Doubao\app\Doubao.exe'),
      'D:\Doubao\app\Doubao.exe'
    )
    $exe = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if ($exe) {
      Write-LaunchLog 'falling back to plain Doubao.exe'
      Start-Process -FilePath $exe
    }
  }
}
