# WA PRO Desktop (Electron)

## Artefacto já gerado neste servidor
- `release/WA-PRO-1.0.0-win-x64.zip`

Este ZIP pode ser descompactado no Windows e executado por `WA PRO.exe`.

## Gerar instalador `.exe` no Windows (recomendado)
No Windows (PowerShell), na pasta do projeto:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
./scripts/build-electron-win.ps1
```

No final, o instalador fica em:
- `release/WA-PRO-1.0.0-win-x64.exe`

## Notas
- O backend sobe automaticamente dentro do Electron.
- A base local fica em `%APPDATA%/WA PRO` (userData do Electron).
- O ficheiro `.env` pode estar:
  - ao lado do `.exe`
  - ou em `%APPDATA%/WA PRO/.env`


## Modo cloud (recomendado para vários PCs)
Por defeito, o desktop abre em modo cloud.
No `.env` ao lado do `WA PRO.exe`, podes definir:

```env
ELECTRON_MODE=cloud
ELECTRON_CLOUD_URL=https://api.mpr.pt/#/inbox
# opcional
# ELECTRON_API_BASE_URL=https://api.mpr.pt
```

Para voltar ao modo local:

```env
ELECTRON_MODE=local
PORT=3010
```


## URL atual do desktop
- DEFAULT atual: `https://wa.mpr.pt/#/inbox`
- Quando criares `wa.mpr.pt`, muda para:

```env
ELECTRON_MODE=cloud
ELECTRON_CLOUD_URL=https://wa.mpr.pt/#/inbox
ELECTRON_API_BASE_URL=https://api.mpr.pt
```
