# Stop AI Terminal Chat development services that are listening on the
# default ports (Flask backend on 9000, Vite on 3000).
#
# This script only targets listeners on those ports. It does not kill
# arbitrary Node or Python processes.
#
# Usage (from repository root):
#   .\scripts\powershell\stop-services.ps1

$ErrorActionPreference = "Stop"

function Stop-ListenersOnPort([int]$Port, [string]$Name) {
  $connections = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  if (-not $connections) {
    Write-Host "$Name (port $Port): no listener found."
    return
  }

  $pids = $connections | Select-Object -ExpandProperty OwningProcess -Unique
  foreach ($procId in $pids) {
    try {
      $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
      $procName = if ($proc) { $proc.ProcessName } else { "unknown" }
      Write-Host "Stopping $Name (port $Port) — PID $procId ($procName)..."
      Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
      # Also attempt to kill the process tree on Windows
      taskkill /PID $procId /T /F 2>$null | Out-Null
    } catch {
      Write-Warning "Could not stop PID $procId on port $Port: $_"
    }
  }
}

Write-Host "Stopping AI Terminal Chat development services..."
Write-Host ""

Stop-ListenersOnPort -Port 9000 -Name "Flask backend"
Stop-ListenersOnPort -Port 3000 -Name "Vite"

Write-Host ""
Write-Host "Done. Ports 9000 and 3000 should now be free (if they were in use)."
