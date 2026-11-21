$ErrorActionPreference = 'SilentlyContinue'
$env:PATH = 'C:\WINDOWS\system32;C:\WINDOWS;C:\WINDOWS\System32\Wbem;C:\WINDOWS\System32\WindowsPowerShell\v1.0;C:\Program Files\nodejs;' + $env:PATH
$runtime = Join-Path $env:LOCALAPPDATA 'beauticode\runtime\workbuddy'
$launcher = Join-Path $runtime 'launcher.ps1'
$ps = 'C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe'
$launchLog = Join-Path $env:LOCALAPPDATA 'beauticode\logs\wb-launch.log'
$watch = Join-Path $env:LOCALAPPDATA 'beauticode\wb-watch.ps1'

function Write-LaunchLog([string]$message) {
  try {
    Add-Content -LiteralPath $launchLog -Value ((Get-Date).ToString('o') + ' [launch] ' + $message) -Encoding UTF8
  } catch {}
}

Write-LaunchLog 'start'

# Step 1: start WorkBuddy with CDP (bounded wait; a stuck repair must not keep a hidden wrapper alive).
$quickArgs = @('-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$launcher`"",'--quick-launch')
$quick = Start-Process -FilePath $ps -ArgumentList $quickArgs -PassThru -WindowStyle Hidden
$exited = $false
try { $exited = $quick.WaitForExit(40000) } catch {}
if ($exited) {
  Write-LaunchLog ('quick-launch done code=' + $quick.ExitCode)
} else {
  try { Stop-Process -Id $quick.Id -Force } catch {}
  Write-LaunchLog 'quick-launch timeout'
}

# Step 2: ensure the CDP runner exists.
$running = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*wb-cdp-runner.mjs*' }
Write-LaunchLog ('runner-count=' + @($running).Count)
if (-not $running) {
  Start-Process -FilePath $ps -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$launcher`"",'--watchdog' -WindowStyle Hidden
  Write-LaunchLog 'guardian-spawned'
}

# Step 3: always try to start the watchdog. It is single-instance and exits if one is already alive.
Write-LaunchLog ('watch=' + $watch + ' exists=' + (Test-Path -LiteralPath $watch))
if (Test-Path -LiteralPath $watch) {
  try {
    Start-Process -FilePath $ps -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$watch`"" -WindowStyle Hidden -ErrorAction Stop
    Write-LaunchLog 'watcher-spawned'
  } catch {
    Write-LaunchLog ('watcher-spawn-error=' + $_.Exception.Message)
  }
}
Write-LaunchLog 'end'
