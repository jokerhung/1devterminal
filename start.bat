@echo off
rem Kill ports -> build web static -> start `npm run dev:local`. Run from anywhere.
setlocal
cd /d "%~dp0"
set "PORTS=2208 2200"

echo [1/3] Freeing ports %PORTS%...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$s = Get-Content -Raw -LiteralPath '%~f0'; Invoke-Expression $s.Substring($s.IndexOf('#PS' + '-BEGIN'))"
if errorlevel 1 (
  echo Could not free the ports.
  exit /b 1
)

echo [2/3] Building web static bundle...
call node scripts\buildWebStatic.mjs
if errorlevel 1 (
  echo Build failed - server not started.
  exit /b 1
)

echo [3/3] Starting npm run dev:local...
call npm run dev:local
exit /b %errorlevel%

#PS-BEGIN
# Stops whatever listens on $env:PORTS, plus its dev-runner ancestors (nodemon, npm, run-p):
# killing only the listener leaves them alive, and they would fight the new server later.
$ports = $env:PORTS -split ' ' | Where-Object { $_ }
$runner = 'nodemon|npm-cli|devServer|devWebLocal|run-p|next[\\/]dist'
$procs = @{}
Get-CimInstance Win32_Process | ForEach-Object { $procs[[int]$_.ProcessId] = $_ }

$roots = @()
foreach ($port in $ports) {
  foreach ($c in Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
    $top = [int]$c.OwningProcess
    while ($procs.ContainsKey($top)) {
      $parent = [int]$procs[$top].ParentProcessId
      if (-not $procs.ContainsKey($parent) -or $procs[$parent].CommandLine -notmatch $runner) { break }
      $top = $parent
    }
    if ($roots -notcontains $top) { $roots += $top }
  }
}

foreach ($id in $roots) {
  $name = if ($procs.ContainsKey($id)) { $procs[$id].Name } else { '?' }
  Write-Host "  stopping pid $id ($name)"
  taskkill /PID $id /T /F | Out-Null
}

# Wait for the sockets to actually close before the build/start reuse them.
for ($i = 0; $i -lt 20; $i++) {
  $busy = $ports | Where-Object { Get-NetTCPConnection -LocalPort $_ -State Listen -ErrorAction SilentlyContinue }
  if (-not $busy) { exit 0 }
  Start-Sleep -Milliseconds 500
}
Write-Host "  still in use: $($busy -join ', ')"
exit 1
