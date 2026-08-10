import fsp from 'node:fs/promises';
import path from 'node:path';
import { handler, HttpError } from '@/lib/json';
import { env } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Serves a Windows installer for the forgeshelf:// handler.
 *
 * Generated rather than static so the library root is baked in — the launcher
 * refuses to open anything outside it, and that boundary has to match this
 * deployment. The launcher script itself is shipped in the image and embedded
 * here so the user ends up with a single file to run.
 */
export const GET = handler(async () => {
  const root = env.hostDataDir;
  if (!root) {
    throw new HttpError(
      'HOST_DATA_DIR is not set, so the installer cannot know where your files live on ' +
        'this machine. Set it to the folder the ./data volume points at, restart, and try again.',
      409,
    );
  }

  const launcherPath = path.join(process.cwd(), 'src', 'tools', 'forge-open.ps1');
  let launcher: string;
  try {
    launcher = await fsp.readFile(launcherPath, 'utf8');
  } catch {
    throw new HttpError('The launcher script is missing from this image', 500);
  }

  const script = buildInstaller(root, launcher);

  return new Response(script, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'content-disposition': 'attachment; filename="install-forgeshelf-open-in.ps1"',
      'cache-control': 'no-store',
    },
  });
});

function buildInstaller(libraryRoot: string, launcher: string): string {
  // Single-quoted PowerShell here-strings take the content literally, so the
  // launcher is embedded without any escaping of its own quotes or $ signs.
  return `<#
    Installs the ForgeShelf "open in" handler for the current user.

    Registers the forgeshelf:// URL scheme so the catalogue in your browser can
    open a file in a desktop slicer. Everything is written under your own
    profile and HKCU — no administrator rights, nothing machine-wide.

    To remove it later:
        Remove-Item -Recurse HKCU:\\Software\\Classes\\forgeshelf
        Remove-Item -Recurse "$env:LOCALAPPDATA\\ForgeShelf"
#>
$ErrorActionPreference = 'Stop'

$installDir = Join-Path $env:LOCALAPPDATA 'ForgeShelf'
New-Item -ItemType Directory -Force -Path $installDir | Out-Null

Write-Host 'Looking for installed slicers...'

# Known install locations. Only apps actually found are offered; the launcher
# resolves an app *key* against this list and never takes a path from the URL.
$candidates = [ordered]@{
  chitubox    = @(
    "$env:ProgramFiles\\CHITUBOX\\CHITUBOX.exe",
    "$env:ProgramFiles\\CHITUBOX Pro\\CHITUBOX Pro.exe",
    "\${env:ProgramFiles(x86)}\\CHITUBOX\\CHITUBOX.exe"
  )
  bambustudio = @(
    "$env:ProgramFiles\\Bambu Studio\\bambu-studio.exe",
    "$env:LOCALAPPDATA\\Programs\\Bambu Studio\\bambu-studio.exe"
  )
  lychee      = @(
    "$env:ProgramFiles\\LycheeSlicer\\LycheeSlicer.exe",
    "$env:LOCALAPPDATA\\Programs\\LycheeSlicer\\LycheeSlicer.exe"
  )
  orca        = @(
    "$env:ProgramFiles\\OrcaSlicer\\orca-slicer.exe",
    "$env:LOCALAPPDATA\\Programs\\OrcaSlicer\\orca-slicer.exe"
  )
  prusaslicer = @(
    "$env:ProgramFiles\\Prusa3D\\PrusaSlicer\\prusa-slicer.exe"
  )
}

$apps = @{}
foreach ($key in $candidates.Keys) {
  foreach ($p in $candidates[$key]) {
    if (Test-Path -LiteralPath $p) { $apps[$key] = $p; Write-Host "  found $key -> $p"; break }
  }
}

if ($apps.Count -eq 0) {
  Write-Warning 'No supported slicers were found. Install one, then run this again.'
}

# The launcher only opens files beneath this folder.
$config = @{ libraryRoot = '${libraryRoot.replace(/'/g, "''")}'; apps = $apps }
$config | ConvertTo-Json -Depth 4 | Set-Content -Path (Join-Path $installDir 'config.json') -Encoding utf8

$launcher = @'
${launcher}
'@
Set-Content -Path (Join-Path $installDir 'forge-open.ps1') -Value $launcher -Encoding utf8

# Register the scheme for this user only.
$root = 'HKCU:\\Software\\Classes\\forgeshelf'
New-Item -Path $root -Force | Out-Null
Set-ItemProperty -Path $root -Name '(default)' -Value 'URL:ForgeShelf'
Set-ItemProperty -Path $root -Name 'URL Protocol' -Value ''
$cmdKey = Join-Path $root 'shell\\open\\command'
New-Item -Path $cmdKey -Force | Out-Null
$launcherFile = Join-Path $installDir 'forge-open.ps1'
$command = '"' + (Get-Command powershell).Source + '" -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $launcherFile + '" "%1"'
Set-ItemProperty -Path $cmdKey -Name '(default)' -Value $command

Write-Host ''
Write-Host 'Installed.' -ForegroundColor Green
Write-Host "  library root : ${libraryRoot.replace(/`/g, '`\`')}"
Write-Host "  apps         : $($apps.Keys -join ', ')"
Write-Host ''
Write-Host 'Go back to the catalogue and use the Open buttons. If nothing happens,'
Write-Host "check $installDir\\forge-open.log for the reason."
`;
}
