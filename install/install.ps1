# qqstudio installer for Windows.
#
#   irm https://github.com/quantiqueue/qqstudio/releases/latest/download/install.ps1 | iex
#
# Installs to %LOCALAPPDATA%\qqstudio (no admin rights, nothing system-wide):
#   app\    qqstudio itself (from the latest GitHub release; replaced on every run)
#   node\   a private node.exe - only if this PC has no Node.js 18+
#   bin\    qqstudio.cmd (added to your user PATH) and qqstudio.vbs (starts it without a console window)
# plus a Start Menu shortcut "qqstudio" (and, if you want, one on the desktop). The shortcuts run "qqstudio --app":
# qqstudio starts in the background and opens in its own window. While it runs, its tray icon has Open qqstudio
# and Quit qqstudio.
# Your settings, sessions, engines and models stay in %USERPROFILE%\.qqstudio (never touched by an update).
# Run the same line again to update. Uninstall: qqstudio --uninstall
#
# Options (set before running):
#   $env:QQSTUDIO_NO_START = "1"        don't start qqstudio after installing
#   $env:QQSTUDIO_DESKTOP = "1" / "0"   desktop shortcut yes / no, without asking
#   $env:QQSTUDIO_VERSION = "v0.1.1"    install a specific release instead of the latest
#   $env:QQSTUDIO_ZIP = "C:\path.zip"   install from a local qqstudio.zip (testing)
#   $env:QQSTUDIO_PRIVATE_NODE = "1"    always use a private Node.js, even if this PC has one

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # the progress bar makes downloads very slow in Windows PowerShell 5
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}

$Repo    = if ($env:QQSTUDIO_REPO) { $env:QQSTUDIO_REPO } else { 'quantiqueue/qqstudio' }
$Root    = Join-Path $env:LOCALAPPDATA 'qqstudio'
$AppDir  = Join-Path $Root 'app'
$NodeDir = Join-Path $Root 'node'
$BinDir  = Join-Path $Root 'bin'
$MinNode = 18
$Port    = 8003

function Say($msg)  { Write-Host "  $msg" }
function Step($msg) { Write-Host "> $msg" -ForegroundColor Cyan }

Write-Host ''
Write-Host 'qqstudio installer' -ForegroundColor Cyan
Write-Host ''

# --- stop a running qqstudio from this install (its files would be locked) ---
# Politely first (POST /api/stop: MCP servers and background commands stop with it; a loaded model keeps running
# and is picked up again), then any node.exe still running from the app folder (another port, or not answering).
function Stop-QQStudio {
  $stopped = $false
  try {
    $p = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/ping" -TimeoutSec 2 -UseBasicParsing
    if ($p.app -eq 'qqstudio' -and $p.dir -and ($p.dir.TrimEnd('\') -ieq $AppDir)) {
      Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/stop" -Method Post -Headers @{ 'X-QQStudio' = 'stop' } -Body '' -UseBasicParsing -TimeoutSec 5 | Out-Null
      $stopped = $true
      Start-Sleep -Milliseconds 1500
    }
  } catch {}
  try {
    $procs = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine -like "*$AppDir\*" })
    foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue; $stopped = $true }
    # The tray helper takes its icon down itself within 500 ms of its server ending; give it that, then end any left.
    if ($procs.Count) { Start-Sleep -Milliseconds 1200 }
    Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine -like "*$AppDir\tray.ps1*" } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  } catch {}
  if ($stopped) { Say 'Stopped the running qqstudio.'; Start-Sleep -Milliseconds 500 }
}

# --- 1. download qqstudio ---
Step 'Downloading qqstudio'
$tmp = Join-Path ([IO.Path]::GetTempPath()) ('qqstudio-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
$zip = Join-Path $tmp 'qqstudio.zip'
if ($env:QQSTUDIO_ZIP) {
  Copy-Item $env:QQSTUDIO_ZIP $zip
  Say "from $($env:QQSTUDIO_ZIP)"
} else {
  if ($env:QQSTUDIO_VERSION) { $url = "https://github.com/$Repo/releases/download/$($env:QQSTUDIO_VERSION)/qqstudio.zip" }
  else { $url = "https://github.com/$Repo/releases/latest/download/qqstudio.zip" }
  Say $url
  Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
}
$unpacked = Join-Path $tmp 'app'
Expand-Archive -Path $zip -DestinationPath $unpacked -Force
if (-not (Test-Path (Join-Path $unpacked 'bin\qqstudio.js'))) { throw "The download doesn't look like qqstudio." }

Stop-QQStudio
New-Item -ItemType Directory -Path $Root -Force | Out-Null
if (Test-Path $AppDir) { Remove-Item $AppDir -Recurse -Force }
Copy-Item -Path $unpacked -Destination $AppDir -Recurse   # (Move-Item can't move a folder to another drive)
$version = (Get-Content (Join-Path $AppDir 'package.json') -Raw | ConvertFrom-Json).version
Say "Installed version $version to $AppDir"

# --- 2. Node.js: the PC's own if it's new enough, otherwise a private node.exe ---
Step 'Checking Node.js'
$nodeExe = $null
$sys = Get-Command node -ErrorAction SilentlyContinue
if ($env:QQSTUDIO_PRIVATE_NODE -eq '1') { $sys = $null; Say 'Using a private Node.js (QQSTUDIO_PRIVATE_NODE=1)' }
if ($sys) {
  try {
    $v = (& $sys.Source -v) -replace '^v', ''
    if ([int]($v.Split('.')[0]) -ge $MinNode) { $nodeExe = $sys.Source; Say "Using your Node.js $v ($($sys.Source))" }
    else { Say "Your Node.js $v is too old (needs $MinNode+), using a private copy instead" }
  } catch {}
}
$privNode = Join-Path $NodeDir 'node.exe'
if (-not $nodeExe) {
  if (Test-Path $privNode) {
    $nodeExe = $privNode
    Say "Using the private Node.js $((& $privNode -v)) in $NodeDir"
  } else {
    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { 'win-arm64' } else { 'win-x64' }
    $index = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -UseBasicParsing
    $lts = $index | Where-Object { $_.lts -and ($_.files -contains ($arch + '-zip')) } | Select-Object -First 1
    if (-not $lts) { throw 'Could not find a Node.js LTS release for this PC.' }
    $nv = $lts.version
    Say "Downloading Node.js $nv ($arch, about 90 MB)"
    New-Item -ItemType Directory -Path $NodeDir -Force | Out-Null
    $dl = Join-Path $tmp 'node.exe'
    Invoke-WebRequest -Uri "https://nodejs.org/dist/$nv/$arch/node.exe" -OutFile $dl -UseBasicParsing
    $sums = [string](Invoke-RestMethod -Uri "https://nodejs.org/dist/$nv/SHASUMS256.txt" -UseBasicParsing)
    $line = ($sums -split "`n") | Where-Object { $_ -match ("\s" + [regex]::Escape("$arch/node.exe") + "\s*$") } | Select-Object -First 1
    if (-not $line) { throw 'Could not find the Node.js checksum.' }
    $want = ($line.Trim() -split '\s+')[0].ToLower()
    $got = (Get-FileHash $dl -Algorithm SHA256).Hash.ToLower()
    if ($want -ne $got) { throw 'The Node.js download failed the checksum check - please try again.' }
    Move-Item $dl $privNode -Force
    $nodeExe = $privNode
    Say "Saved to $NodeDir (only qqstudio uses it)"
  }
}

# --- 3. the qqstudio command ---
Step 'Adding the qqstudio command'
New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
$cmd = @"
@echo off
rem qqstudio launcher (made by install.ps1). "qqstudio --help" for the options, "qqstudio --uninstall" to remove it.
for %%I in ("%~dp0..") do set "QQSTUDIO_ROOT=%%~fI"
if /i "%~1"=="--uninstall" (copy /y "%QQSTUDIO_ROOT%\app\install\uninstall.ps1" "%TEMP%\qqstudio-uninstall.ps1" >nul & powershell -NoProfile -ExecutionPolicy Bypass -File "%TEMP%\qqstudio-uninstall.ps1" & exit /b)
set "QQSTUDIO_LAUNCHER=%~f0"
set "QQSTUDIO_NODE=%QQSTUDIO_ROOT%\node\node.exe"
if not exist "%QQSTUDIO_NODE%" (set "QQSTUDIO_NODE=node" & where node >nul 2>nul || (echo Node.js was not found. Run the qqstudio installer again to get a private copy. & exit /b 1))
"%QQSTUDIO_NODE%" "%QQSTUDIO_ROOT%\app\bin\qqstudio.js" %*
"@
Set-Content -Path (Join-Path $BinDir 'qqstudio.cmd') -Value $cmd -Encoding ASCII

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not $userPath) { $userPath = '' }
if (($userPath -split ';') -notcontains $BinDir) {
  [Environment]::SetEnvironmentVariable('Path', (($userPath.TrimEnd(';') + ';' + $BinDir).TrimStart(';')), 'User')
  Say "Added $BinDir to your PATH (new terminals will see it)"
}
if (($env:Path -split ';') -notcontains $BinDir) { $env:Path = $env:Path + ';' + $BinDir }

# --- 4. shortcuts: qqstudio in its own window (qqstudio --app), with no console window ---
$vbs = Join-Path $BinDir 'qqstudio.vbs'
$vbsText = @'
' qqstudio app launcher (made by install.ps1): runs "qqstudio --app" without a console window.
' --app starts qqstudio in the background if it isn't running, then opens it in its own window.
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
args = ""
For Each a In WScript.Arguments
  args = args & " """ & a & """"
Next
CreateObject("WScript.Shell").Run """" & dir & "\qqstudio.cmd"" --app" & args, 0, False
'@
Set-Content -Path $vbs -Value $vbsText -Encoding ASCII

$ico = Join-Path $AppDir 'public\qqstudio.ico'
$sh = New-Object -ComObject WScript.Shell
function New-AppShortcut($lnk) {
  $s = $sh.CreateShortcut($lnk)
  $s.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
  $s.Arguments = '"' + $vbs + '"'
  $s.WorkingDirectory = $Root
  $s.Description = 'qqstudio - local AI studio'
  if (Test-Path $ico) { $s.IconLocation = $ico + ',0' }
  $s.Save()
  Say $lnk
}

Step 'Adding a Start Menu shortcut'
New-AppShortcut (Join-Path ([Environment]::GetFolderPath('Programs')) 'qqstudio.lnk')

$desk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'qqstudio.lnk'
$wantDesk = $env:QQSTUDIO_DESKTOP
if (-not $wantDesk) {
  if (Test-Path $desk) { $wantDesk = '1' }   # updating: keep (and refresh) the one there
  else {
    $a = ''
    try { $a = Read-Host '  Create a desktop shortcut? [Y/n]' } catch {}
    $wantDesk = if ($a -match '^(n|no)$') { '0' } else { '1' }
  }
}
if ($wantDesk -eq '1') { Step 'Adding a desktop shortcut'; New-AppShortcut $desk }

Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ''
Write-Host "qqstudio $version is installed." -ForegroundColor Green
Say 'Start it from the Start Menu (qqstudio) or the desktop shortcut: it opens in its own window.'
Say 'Closing the window keeps qqstudio running; its tray icon has Open qqstudio and Quit qqstudio.'
Say 'From a terminal:  qqstudio  (runs there, Ctrl+C to stop)   qqstudio --open  (in your browser)'
Say 'Options:  qqstudio --help      Uninstall:  qqstudio --uninstall'
Write-Host ''

# --- 5. start it ---
if ($env:QQSTUDIO_NO_START -ne '1') {
  Start-Process -FilePath (Join-Path $env:WINDIR 'System32\wscript.exe') -ArgumentList ('"' + $vbs + '"') -WorkingDirectory $Root
  Say "qqstudio is starting and will open in its own window (http://localhost:$Port)"
  Write-Host ''
}
