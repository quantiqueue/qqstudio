# qqstudio's tray icon. Windows only; started by tray.js, not meant to be run by hand:
#   powershell -NoProfile -NonInteractive -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File tray.ps1 `
#              -Port 8003 -Version 0.1.1 -Icon C:\...\public\qqstudio.ico -ParentPid 1234
# The icon lives and dies with that server process: this helper holds a handle to it, checks it every 500 ms and
# takes the icon down itself when it exits. Nothing kills the helper on a stop (a killed PowerShell never reaches
# $notify.Dispose(), and Windows then keeps the dead icon until the mouse crosses it). The menu items are loopback
# calls to the same server (Open qqstudio -> POST /api/tray/open, Quit qqstudio -> POST /api/stop).
# ASCII only in this file: Windows PowerShell 5 reads a file without a BOM in the system codepage.
param(
  [Parameter(Mandatory = $true)][int]$Port,
  [Parameter(Mandatory = $true)][string]$Version,
  [Parameter(Mandatory = $true)][string]$Icon,
  [Parameter(Mandatory = $true)][int]$ParentPid
)

$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
} catch {
  Write-Output 'System.Windows.Forms / System.Drawing are not available (PowerShell may be restricted on this PC)'
  exit 2
}

$label = 'qqstudio ' + $Version + ' - port ' + $Port

$iconObj = $null
try { $iconObj = New-Object System.Drawing.Icon($Icon, 16, 16) } catch { }
if (-not $iconObj) { try { $iconObj = New-Object System.Drawing.Icon($Icon) } catch { } }
if (-not $iconObj) { try { $iconObj = [System.Drawing.SystemIcons]::Application } catch { } }
if (-not $iconObj) { Write-Output 'no icon could be loaded'; exit 2 }

function Write-TrayLog([string]$line) { try { [Console]::Out.WriteLine($line) } catch { } }

# Write-TrayLog, not Write-Output, in here: pipeline output would become part of the return value.
function Ask-Server([string]$apiPath, [string]$headerTag) {
  try {
    Invoke-WebRequest -Uri ('http://127.0.0.1:' + $Port + $apiPath) -Method Post -Headers @{ 'X-QQStudio' = $headerTag } -Body '' -UseBasicParsing -TimeoutSec 5 | Out-Null
    return $true
  } catch {
    Write-TrayLog ($apiPath + ' failed: ' + $_.Exception.Message)
    return $false
  }
}

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$head = $menu.Items.Add($label)
$head.Enabled = $false
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$openItem = $menu.Items.Add('Open qqstudio')
$quitItem = $menu.Items.Add('Quit qqstudio')

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = $iconObj
$notify.Visible = $true
$notify.Text = $label
$notify.ContextMenuStrip = $menu

# Left click opens qqstudio; right click shows the menu (NotifyIcon does that itself).
$notify.Add_MouseClick({
  param($s, $e)
  if ($e.Button.ToString() -eq 'Left') { [void](Ask-Server '/api/tray/open' 'open') }
})

function Leave-Tray {
  try { $timer.Stop() } catch { }
  try { $notify.Visible = $false; $notify.Dispose() } catch { }
  Write-TrayLog 'icon taken down'
  [System.Windows.Forms.Application]::Exit()
}

$openItem.Add_Click({ [void](Ask-Server '/api/tray/open' 'open') })
$quitItem.Add_Click({ if (Ask-Server '/api/stop' 'stop') { Leave-Tray } })

# The handle is taken once: looking the PID up on every tick could find an unrelated program that got the same number.
$parent = $null
try { $parent = [System.Diagnostics.Process]::GetProcessById($ParentPid) } catch { }

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 500
$timer.Add_Tick({
  try {
    if ($parent) { if ($parent.HasExited) { Leave-Tray } }
    elseif (-not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { Leave-Tray }
  } catch { Leave-Tray }
})
$timer.Start()

Write-Output ('qqstudio ' + $Version + ' on port ' + $Port + ' (pid ' + $ParentPid + ')')
[System.Windows.Forms.Application]::Run()
