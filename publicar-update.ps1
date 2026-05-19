$ErrorActionPreference = 'Stop'

Set-Location $PSScriptRoot

$ReleaseScript = Join-Path $PSScriptRoot 'scripts\release-desktop-windows.ps1'
if (-not (Test-Path $ReleaseScript)) {
  throw "Não encontrei o script de release: $ReleaseScript"
}

powershell -ExecutionPolicy Bypass -File $ReleaseScript
