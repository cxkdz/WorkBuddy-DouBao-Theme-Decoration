$ErrorActionPreference = 'SilentlyContinue'
$root = Join-Path $env:LOCALAPPDATA 'beauticode'
$launcher = Join-Path $root 'runtime\workbuddy\launcher.ps1'
$log = Join-Path $root 'logs\wb-watch.log'
$self = $PID

# 单实例：如果已有 watcher，直接退出，避免登录项/手动启动叠加
$existing = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
  Where-Object { $_.CommandLine -match 'wb-watch\.ps1' -and [int]$_.ProcessId -ne $self }
if ($existing) { exit 0 }

function Write-WatchLog([string]$message) {
  try {
    $dir = Split-Path -Parent $log
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    if ((Test-Path -LiteralPath $log) -and (Get-Item -LiteralPath $log).Length -gt 1048576) {
      Move-Item -LiteralPath $log -Destination ($log + '.previous') -Force
    }
    Add-Content -LiteralPath $log -Value ((Get-Date).ToString('o') + ' [watch] ' + $message) -Encoding UTF8
  } catch {}
}

$lastLaunch = [datetime]::MinValue
Write-WatchLog 'watcher-started'

while ($true) {
  try {
    $wb = Get-Process -Name WorkBuddy -ErrorAction SilentlyContinue
    if ($wb) {
      $runner = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
        Where-Object { $_.CommandLine -match 'wb-cdp-runner' })
      if (-not $runner -and ((Get-Date) - $lastLaunch).TotalSeconds -gt 20) {
        $lastLaunch = Get-Date
        Write-WatchLog 'workbuddy-detected, starting guardian'
        $env:PATH = 'C:\WINDOWS\system32;C:\WINDOWS;C:\WINDOWS\System32\Wbem;C:\WINDOWS\System32\WindowsPowerShell\v1.0;C:\Program Files\nodejs;' + $env:PATH
        Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" `
          -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',"`"$launcher`"",'--watchdog') `
          -WindowStyle Hidden
        Start-Sleep -Seconds 15
      }
    }
  } catch {
    Write-WatchLog ('watcher-error: ' + $_.Exception.Message)
  }
  Start-Sleep -Seconds 3
}
