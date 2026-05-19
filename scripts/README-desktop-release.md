# WA PRO — release desktop automática no Windows

## Comando único

```powershell
npm run release:desktop
```

Por defeito o script envia para:

```txt
ubuntu@wa.mpr.pt:/home/ubuntu/programas/mprWA/release
```

O script faz:

1. `git pull --ff-only`, se existir `.git`;
2. `npm ci`;
3. sobe versão patch;
4. `npm run build`;
5. gera NSIS `.exe` com `electron-builder`;
6. cria pasta local `release/desktop-update-vX.X.X`;
7. envia `.exe`, `.blockmap` e `latest.yml` para o Oracle;
8. valida `latest.yml` publicamente.

## Se precisares de chave SSH específica

```powershell
[Environment]::SetEnvironmentVariable('WAPRO_DEPLOY_KEY', 'C:\caminho\chave.pem', 'User')
```

Fecha e reabre o PowerShell.

## Opções

```powershell
powershell -ExecutionPolicy Bypass -File scripts/release-desktop-windows.ps1 -NoUpload
powershell -ExecutionPolicy Bypass -File scripts/release-desktop-windows.ps1 -NoVersionBump
powershell -ExecutionPolicy Bypass -File scripts/release-desktop-windows.ps1 -SkipInstall
powershell -ExecutionPolicy Bypass -File scripts/release-desktop-windows.ps1 -SkipGitPull
```
