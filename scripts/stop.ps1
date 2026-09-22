# Stop trae-proxy. No WMI, no Get-NetTCPConnection (slow); use netstat -ano.
$ErrorActionPreference = 'Continue'
$Root    = Split-Path -Parent $PSScriptRoot
$PidFile = Join-Path $Root 'logs\proxy.pid'
$Ports   = @(39303, 39304)

function Port-Owners([int[]]$List) {
  $ids = @()
  foreach ($ln in (netstat -ano)) {
    if ($ln -match 'LISTENING') {
      $f = ($ln -split '\s+') | Where-Object { $_ -ne '' }
      if ($f.Count -ge 4) {
        $port = [int](($f[1] -split ':')[-1])
        if ($List -contains $port) { $ids += [int]$f[-1] }
      }
    }
  }
  return ($ids | Where-Object { $_ -gt 0 } | Sort-Object -Unique)
}

$targets = @()
if (Test-Path $PidFile) {
  $targets += [int]((Get-Content $PidFile -Raw).Trim())
  Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
}
$targets += Port-Owners $Ports
$targets = $targets | Where-Object { $_ -gt 0 } | Sort-Object -Unique

foreach ($procId in $targets) {
  try { Stop-Process -Id $procId -Force -ErrorAction Stop; Write-Host "stopped PID $procId" } catch { }
}
if ($targets.Count -eq 0) { Write-Host 'trae-proxy not running' }
