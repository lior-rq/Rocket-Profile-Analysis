# Self-contained RASAero host + engine -> build\dist\rasaero (Windows).
# Usage: powershell -File build\publish_host.ps1 [-Rid win-x64]
param([string]$Rid = "win-x64")
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Out = Join-Path $Root "build\dist\rasaero"
if (-not (Test-Path "$Root\vendor\rasaero\RASAeroEngine.dll")) { throw "vendor\rasaero\RASAeroEngine.dll missing: python tools\rasaero_fetch.py" }
if (Test-Path $Out) { Remove-Item -Recurse -Force $Out }
dotnet publish "$Root\native\RasaeroHost" -c Release -r $Rid --self-contained true `
  -p:PublishReadyToRun=true -p:TieredPGO=true -o $Out --nologo -v q
if ($LASTEXITCODE) { throw "dotnet publish failed" }
Copy-Item "$Root\vendor\rasaero\RASAeroEngine.dll", "$Root\vendor\rasaero\rasp.eng" $Out
Remove-Item "$Out\*.pdb" -ErrorAction SilentlyContinue
Write-Host "host: $Out ($Rid)"
