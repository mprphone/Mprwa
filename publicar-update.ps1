$ErrorActionPreference = 'Stop'

Set-Location $PSScriptRoot

$ReleaseScript = Join-Path $PSScriptRoot 'scripts\release-desktop-windows.ps1'
if (-not (Test-Path $ReleaseScript)) {
  throw "Nao encontrei o script de release: $ReleaseScript"
}

powershell -ExecutionPolicy Bypass -File $ReleaseScript
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}
