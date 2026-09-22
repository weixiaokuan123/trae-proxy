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

if ($Foreground) {
  node (Join-Path $Root 'src\serve.ts')
  exit $LASTEXITCODE
}

if (All-PortsUp $Ports) {
  Write-Host "trae-proxy already running (ports $($Ports -join ','))"
  exit 0
}

$serve = Join-Path $Root 'src\serve.ts'
$cmd = 'cmd /c node "' + $serve + '" > "' + $OutLog + '" 2> "' + $ErrLog + '"'
$sh = New-Object -ComObject WScript.Shell
$sh.Run($cmd, 0, $false) | Out-Null

$deadline = (Get-Date).AddSeconds(12)
while ((Get-Date) -lt $deadline) {
  if (All-PortsUp $Ports) { break }
  Start-Sleep -Milliseconds 400
}

if (All-PortsUp $Ports) {
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
