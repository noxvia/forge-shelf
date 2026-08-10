<#
    ForgeShelf protocol launcher.

    Registered as the handler for forgeshelf:// so the web catalogue can open a
    file in a desktop slicer. Invoked by Windows as:

        forge-open.ps1 "forgeshelf://open?app=chitubox&path=C%3A%5C..."

    SECURITY
    Any web page in any browser can invoke a registered protocol handler, so
    this deliberately cannot be used as a general "run a program" primitive:

      * The app is a key into an allowlist written at install time. The URL
        never supplies an executable path.
      * The file must resolve inside the library root recorded at install time.
        Traversal, UNC paths and anything outside it are refused.
      * Only known model/print extensions are opened.

    Anything rejected is logged and the script exits without launching.
#>
param([Parameter(Position = 0)][string]$Uri)

$ErrorActionPreference = 'Stop'
$configPath = Join-Path $PSScriptRoot 'config.json'
$logPath = Join-Path $PSScriptRoot 'forge-open.log'

function Write-Log($message) {
    $line = "{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $message
    Add-Content -Path $logPath -Value $line -ErrorAction SilentlyContinue
}

function Fail($message) {
    Write-Log "REFUSED: $message"
    # Shown to the user; a silent no-op would be baffling.
    Add-Type -AssemblyName PresentationFramework -ErrorAction SilentlyContinue
    [System.Windows.MessageBox]::Show($message, 'ForgeShelf', 'OK', 'Warning') | Out-Null
    exit 1
}

if (-not (Test-Path $configPath)) { Fail "ForgeShelf handler is not configured. Re-run the installer." }
$config = Get-Content $configPath -Raw | ConvertFrom-Json

Write-Log "invoked: $Uri"

if ([string]::IsNullOrWhiteSpace($Uri)) { Fail 'No URL was supplied.' }
if ($Uri -notmatch '^forgeshelf://open\?') { Fail "Unrecognised URL: $Uri" }

# Parse the query without System.Web, which isn't present on all installs.
$query = $Uri -replace '^forgeshelf://open\?', ''
$params = @{}
foreach ($pair in $query -split '&') {
    $kv = $pair -split '=', 2
    if ($kv.Count -eq 2) { $params[$kv[0]] = [System.Uri]::UnescapeDataString($kv[1]) }
}

$appKey = $params['app']
$path = $params['path']

if (-not $appKey) { Fail 'No application was specified.' }
if (-not $path) { Fail 'No file was specified.' }

# --- app must be a known key, never a path from the URL ---------------------
$exe = $config.apps.$appKey
if (-not $exe) { Fail "'$appKey' is not a configured application. Re-run the installer if you have since installed it." }
if (-not (Test-Path -LiteralPath $exe)) { Fail "$appKey is configured at`n$exe`nbut that file no longer exists." }

# --- file must sit inside the library root ---------------------------------
$root = [System.IO.Path]::GetFullPath($config.libraryRoot)
try { $full = [System.IO.Path]::GetFullPath($path) } catch { Fail "Not a usable path: $path" }

if ($full -like '\\*') { Fail "Network paths are not allowed:`n$full" }
if (-not $full.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) {
    Fail "That file is outside the library folder and will not be opened:`n$full"
}
if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { Fail "File not found:`n$full" }

$allowedExt = @('.stl', '.3mf', '.obj', '.ply', '.step', '.stp', '.ctb', '.goo', '.cbddlp', '.gcode', '.sl1')
$ext = [System.IO.Path]::GetExtension($full).ToLowerInvariant()
if ($allowedExt -notcontains $ext) { Fail "'$ext' files are not opened by ForgeShelf." }

Write-Log "launching $exe `"$full`""
Start-Process -FilePath $exe -ArgumentList "`"$full`""
exit 0
