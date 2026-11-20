# qqstudio uninstaller for Windows (run with: qqstudio --uninstall).
# Ejects the loaded model and stops qqstudio (and its app window), then removes %LOCALAPPDATA%\qqstudio, the Start
# Menu and desktop shortcuts and the PATH entry.
# Your data in %USERPROFILE%\.qqstudio is kept unless you say otherwise; it asks separately about
#   - downloaded engines and models (often tens of GB), and
#   - settings, workspaces and sessions.
# QQSTUDIO_DELETE_DATA=none / engines / all answers both questions without asking (testing).
$ErrorActionPreference = 'Continue'
$Root    = Join-Path $env:LOCALAPPDATA 'qqstudio'
$AppDir  = Join-Path $Root 'app'
$BinDir  = Join-Path $Root 'bin'
$Data    = if ($env:QQSTUDIO_HOME) { $env:QQSTUDIO_HOME } else { Join-Path $env:USERPROFILE '.qqstudio' }
$Port    = 8003

Write-Host ''
Write-Host 'Uninstalling qqstudio' -ForegroundColor Cyan

# --- eject the loaded model and stop qqstudio ---
try {
  $p = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/ping" -TimeoutSec 2 -UseBasicParsing
  if ($p.app -eq 'qqstudio' -and $p.dir -and ($p.dir.TrimEnd('\') -ieq $AppDir)) {   # this install only, not a copy run from a clone
    $r = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/stop?eject=1" -Method Post -Headers @{ 'X-QQStudio' = 'stop' } -Body '' -UseBasicParsing -TimeoutSec 60
    if ($r.ejected) { Write-Host "  Ejected $($r.ejected)" }
    Write-Host '  Stopped qqstudio'
    Start-Sleep -Milliseconds 1500
  }
} catch {}
try {
  $nodeProcs = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine -like "*$AppDir\*" })
  foreach ($p in $nodeProcs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  if ($nodeProcs.Count) { Start-Sleep -Milliseconds 1200 }
  Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine -like "*$AppDir\tray.ps1*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  # the app window (Edge/Chrome with qqstudio's own profile in $Root\window*), so its files can be removed
  Get-CimInstance Win32_Process -Filter "Name = 'msedge.exe' OR Name = 'chrome.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine -like "*$Root\window*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 800
} catch {}

$lnk = Join-Path ([Environment]::GetFolderPath('Programs')) 'qqstudio.lnk'
if (Test-Path $lnk) { Remove-Item $lnk -Force; Write-Host '  Removed the Start Menu shortcut' }
$desk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'qqstudio.lnk'
if (Test-Path $desk) { Remove-Item $desk -Force; Write-Host '  Removed the desktop shortcut' }

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -and (($userPath -split ';') -contains $BinDir)) {
  $new = (($userPath -split ';') | Where-Object { $_ -and $_ -ne $BinDir }) -join ';'
  [Environment]::SetEnvironmentVariable('Path', $new, 'User')
  Write-Host '  Removed qqstudio from your PATH'
}

if (Test-Path $Root) {
  # Everything but bin\ now: bin\qqstudio.cmd started this uninstaller and is still running, so bin\ goes at the very
  # end, a moment after the launcher exits (deleting a running batch file makes cmd print an error).
  Get-ChildItem $Root -Force | Where-Object { $_.Name -ne 'bin' } | Remove-Item -Recurse -Force
  Write-Host "  Removed $Root"
}

# --- your data ---
function Size-GB($paths) {
  $sum = 0
  foreach ($d in $paths) { if (Test-Path $d) { $sum += (Get-ChildItem $d -Recurse -Force -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum } }
  return [math]::Round($sum / 1GB, 1)
}
function Ask($q) { $a = ''; try { $a = Read-Host $q } catch {}; return ($a -match '^(y|yes)$') }

if (Test-Path $Data) {
  $big = @((Join-Path $Data 'engines'), (Join-Path $Data 'models'))
  $answer = $env:QQSTUDIO_DELETE_DATA
  $delBig = $false; $delRest = $false
  if ($answer) { $delBig = ($answer -eq 'engines' -or $answer -eq 'all'); $delRest = ($answer -eq 'all') }
  else {
    $gb = Size-GB $big
    if (($big | Where-Object { Test-Path $_ }).Count) { $delBig = Ask "  Delete the downloaded engines and models in $Data ($gb GB)? [y/N]" }
    $delRest = Ask "  Delete your settings, workspaces and sessions in $Data? [y/N]"
  }
  if ($delBig -and $delRest) { Remove-Item $Data -Recurse -Force; Write-Host "  Deleted $Data" }
  else {
    if ($delBig) { foreach ($d in $big) { if (Test-Path $d) { Remove-Item $d -Recurse -Force } }; Write-Host '  Deleted the engines and models' }
    if ($delRest) { Get-ChildItem $Data -Force | Where-Object { $_.Name -ne 'engines' -and $_.Name -ne 'models' } | Remove-Item -Recurse -Force; Write-Host '  Deleted the settings, workspaces and sessions' }
    if (-not ($delBig -or $delRest)) { Write-Host "  Kept $Data (installing again picks it up)" }
  }
}
Write-Host ''
Write-Host 'qqstudio has been uninstalled.' -ForegroundColor Green
Write-Host ''

if (Test-Path $Root) {
  Start-Process -FilePath 'cmd.exe' -ArgumentList ('/c ping -n 3 127.0.0.1 >nul & rmdir /s /q "' + $Root + '"') -WindowStyle Hidden
}
