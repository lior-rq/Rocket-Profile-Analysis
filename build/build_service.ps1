# Everything the desktop shell bundles: build\dist\{rpa-service,rasaero,template}.
# Usage: powershell -File build\build_service.ps1 [-SkipUi] [-SkipHost] [-SkipSmoke]
# Then:  cd app; npm run tauri build
param([switch]$SkipUi, [switch]$SkipHost, [switch]$SkipSmoke)
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Py = if ($env:PYTHON) { $env:PYTHON } elseif (Test-Path "$Root\.venv\Scripts\python.exe") { "$Root\.venv\Scripts\python.exe" } else { "python" }
Set-Location $Root
& $Py build\sync_version.py; if ($LASTEXITCODE) { throw "sync_version" }
& $Py build\make_template.py; if ($LASTEXITCODE) { throw "make_template" }
New-Item -ItemType Directory -Force build\dist | Out-Null
if (Test-Path build\dist\template) { Remove-Item -Recurse -Force build\dist\template }
Copy-Item -Recurse build\template build\dist\template
if (-not $SkipUi) {
  Push-Location app
  if (-not (Test-Path node_modules)) { npm ci --no-audit --no-fund; if ($LASTEXITCODE) { throw "npm ci" } }
  npm run build; if ($LASTEXITCODE) { throw "npm run build" }
  Pop-Location
}
if (Test-Path rpa\service\ui) { Remove-Item -Recurse -Force rpa\service\ui }
Copy-Item -Recurse app\dist rpa\service\ui
if (Test-Path build\dist\rpa-service) { Remove-Item -Recurse -Force build\dist\rpa-service }
& $Py -m PyInstaller build\rpa-service.spec --noconfirm --distpath build\dist --workpath build\work --log-level WARN
if ($LASTEXITCODE) { throw "pyinstaller" }
if (-not $SkipHost) { & "$PSScriptRoot\publish_host.ps1" }
if (-not $SkipSmoke) { & $Py build\smoke_service.py build\dist\rpa-service; if ($LASTEXITCODE) { throw "smoke" } }
Write-Host "service: build\dist\rpa-service"
