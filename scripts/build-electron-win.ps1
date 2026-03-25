$ErrorActionPreference = 'Stop'

Set-Location -Path (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location ..

Write-Host '==> Instalando dependências...' -ForegroundColor Cyan
npm install

Write-Host '==> Build frontend...' -ForegroundColor Cyan
npm run build

Write-Host '==> Gerando instalador Windows (NSIS)...' -ForegroundColor Cyan
npx electron-builder --win nsis --x64

Write-Host 'OK: instalador criado em ./release' -ForegroundColor Green
