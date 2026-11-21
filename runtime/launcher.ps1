$ErrorActionPreference = 'Stop'
$startupLog = Join-Path $env:LOCALAPPDATA 'beauticode\logs\wb-runner.log'
$startupCode = 'launcher-failure'
try {
$hostName = 'workbuddy'
$portFile = Join-Path $env:APPDATA 'beauticode\workbuddy-port.json'
if (Test-Path -LiteralPath $portFile) { $portRecord = Get-Content -LiteralPath $portFile -Raw | ConvertFrom-Json; $savedPort = [string]$portRecord.port; if ($savedPort -notmatch '^\d{1,5}$' -or [int]$savedPort -lt 1 -or [int]$savedPort -gt 65535) { throw 'workbuddy-port-invalid' }; $env:WORKBUDDY_REMOTE_DEBUGGING_PORT = $savedPort }
$hostRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$pointerPath = Join-Path $hostRoot 'current.json'
$startupCode = 'pointer-missing'
if (-not (Test-Path -LiteralPath $pointerPath -PathType Leaf)) { throw 'beautiCode runtime pointer is missing' }
$pointer = Get-Content -LiteralPath $pointerPath -Raw | ConvertFrom-Json
$startupCode = 'pointer-invalid'
if ($pointer.schema -ne 'beauticode.runtime/v1' -or $pointer.host -ne $hostName -or $pointer.version -notmatch '^[A-Za-z0-9._-]+$') { throw 'beautiCode runtime pointer is invalid' }
$activeRoot = Join-Path (Join-Path $hostRoot 'versions') $pointer.version
$startupCode = 'runtime-missing'
if (-not (Test-Path -LiteralPath $activeRoot -PathType Container)) { throw 'beautiCode runtime version is missing' }
$entryRelative = [string]$pointer.entrypoint
if ($args.Count -gt 0 -and $args[0] -eq '--quick-launch') {
  $entryRelative = if ($hostName -eq 'codex-plugin') { 'quick-launch.mjs' } else { 'scripts\quick-launch.mjs' }
  $args = @($args | Select-Object -Skip 1)
  $args = @($hostName) + $args
}
$entry = Join-Path $activeRoot $entryRelative
$startupCode = 'entry-missing'
if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) { throw 'beautiCode runtime entrypoint is missing' }
$recordPath = Join-Path $hostRoot 'node-source.json'
$candidates = @()
if (Test-Path -LiteralPath $recordPath -PathType Leaf) { try { $record = Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json; if ($record.path) { $candidates += [string]$record.path } } catch {} }
if ($env:BEAUTICODE_NODE_PATH) { $candidates += [string]$env:BEAUTICODE_NODE_PATH }
if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe') }
if ($env:ProgramFiles) { $candidates += (Join-Path $env:ProgramFiles 'nodejs\node.exe') }
if (${env:ProgramFiles(x86)}) { $candidates += (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe') }
$candidates += 'C:\Program Files\nodejs\node.exe'
try { $candidates += @(where.exe node.exe 2>$null) } catch {}
$node = $null
foreach ($candidate in $candidates) {
  if (-not $candidate -or -not [System.IO.Path]::IsPathRooted($candidate) -or -not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
  if ($candidate -match '(?i)workbuddy.*sandbox|sandbox.*workbuddy') { continue }
  try { $version = (& $candidate --version 2>$null).Trim(); if ($version -match '^v?(\d+)(?:\.|$)' -and [int]$Matches[1] -ge 22) { $node = (Resolve-Path -LiteralPath $candidate).Path; break } } catch {}
}
$startupCode = 'node-unavailable'
if (-not $node) { throw 'beautiCode requires Node.js >=22; install Node.js 22+ or set BEAUTICODE_NODE_PATH.' }
# DreamSkin.cc 需要出网；Node 默认不读 HTTP_PROXY，显式开启（NO_PROXY 已含 127.0.0.1，不影响本地 CDP）。
if (-not $env:NODE_USE_ENV_PROXY) { $env:NODE_USE_ENV_PROXY = '1' }
& $node $entry @args
exit $LASTEXITCODE

} catch {
  try {
    $dir = Split-Path -Parent $startupLog; New-Item -ItemType Directory -Path $dir -Force | Out-Null
    if ((Test-Path -LiteralPath $startupLog) -and (Get-Item -LiteralPath $startupLog).Length -gt 1048576) { Move-Item -LiteralPath $startupLog -Destination ($startupLog + '.previous') -Force }
    Add-Content -LiteralPath $startupLog -Value ((Get-Date).ToUniversalTime().ToString('o') + ' [launcher-failure] ' + $startupCode) -Encoding UTF8
  } catch {}
  exit 1
}
