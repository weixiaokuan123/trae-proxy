# trae-proxy launcher.
# Starts the proxy detached (via WScript.Shell COM) so the caller never waits on
# the long-lived node process. Idempotent: skips if the ports are already open.
param([switch]$Foreground)

$ErrorActionPreference = 'Stop'
$Root    = Split-Path -Parent $PSScriptRoot
$PidFile = Join-Path $Root 'logs\proxy.pid'
$OutLog  = Join-Path $Root 'logs\proxy.out.log'
$ErrLog  = Join-Path $Root 'logs\proxy.err.log'
$Ports   = @(39303, 39304)

function Test-Port([int]$Port) {
  try {
    $t = New-Object System.Net.Sockets.TcpClient
    $t.Connect('127.0.0.1', $Port)
    $t.Close()
    return $true
  } catch { return $false }
}

function All-PortsUp([int[]]$List) {
  foreach ($p in $List) { if (-not (Test-Port $p)) { return $false } }
  return $true
}

function Owner-PidOf([int]$Port) {
  foreach ($ln in (netstat -ano)) {
    if ($ln -match 'LISTENING' -and $ln -match ":$Port\s") {
      $f = ($ln -split '\s+') | Where-Object { $_ -ne '' }
      if ($f.Count -ge 4) { return [int]$f[-1] }
    }
  }
  return 0
}

# Cap log growth: rotate logs larger than 5 MB before a fresh start (append mode).
function Rotate-Log([string]$Path, [int]$MaxBytes = 5MB) {
  if (Test-Path $Path) {
    if ((Get-Item $Path).Length -gt $MaxBytes) {
      $bak = "$Path.1"
      Remove-Item $bak -Force -ErrorAction SilentlyContinue
      Move-Item $Path $bak -Force -ErrorAction SilentlyContinue
    }
  }
}

if ($Foreground) {
  node (Join-Path $Root 'src\serve.ts')
  exit $LASTEXITCODE
}

if (All-PortsUp $Ports) {
  Write-Host "trae-proxy already running (ports $($Ports -join ','))"
  exit 0
}

# 启动前先收紧 keys/ 与 state/ 的 ACL（幂等，与端口就绪后那次配合）。
# 这次负责纠正上一次运行或手工操作可能留下的宽松权限；
# 目录若尚不存在则跳过，等 node 建出来后再由就绪后那次收紧。
& (Join-Path $PSScriptRoot 'harden-acl.ps1')

$serve = Join-Path $Root 'src\serve.ts'
Rotate-Log $OutLog
Rotate-Log $ErrLog
# 让 node 直接持有日志文件：只有自己握住句柄才能在运行期轮转。
# 此前由 cmd 重定向，句柄在 cmd 手里，进程内无法轮转，只能靠重启时轮一次，
# 于是「长期不重启的进程」日志无上限增长。
# 前台模式（-Foreground）不设这两个变量，日志照常打到控制台。
$env:TRAE_PROXY_LOG_OUT = $OutLog
$env:TRAE_PROXY_LOG_ERR = $ErrLog
$sh = New-Object -ComObject WScript.Shell
$sh.Run('node "' + $serve + '"', 0, $false) | Out-Null

$deadline = (Get-Date).AddSeconds(12)
while ((Get-Date) -lt $deadline) {
  if (All-PortsUp $Ports) { break }
  Start-Sleep -Milliseconds 400
}

if (All-PortsUp $Ports) {
  # 节点启动可能新建了 keys/ 或 state/，此时它们才存在，补一次收紧。
  & (Join-Path $PSScriptRoot 'harden-acl.ps1')

  $procId = Owner-PidOf $Ports[0]
  if ($procId -gt 0) { Set-Content -Path $PidFile -Value $procId -Encoding ASCII }
  Write-Host "trae-proxy started (PID $procId)"
  Write-Host "  cn http://127.0.0.1:39303"
  Write-Host "  ai http://127.0.0.1:39304"
} else {
  Write-Host "trae-proxy failed to start; check $ErrLog"
  Get-Content $ErrLog -ErrorAction SilentlyContinue
  exit 1
}
