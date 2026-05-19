# WA PRO — comando único para gerar e enviar atualização desktop

No Windows, depois de extrair este ZIP, abre PowerShell dentro da pasta do projeto e corre:

```powershell
npm run release:desktop
```

O script faz automaticamente:

1. atualiza código se a pasta tiver Git;
2. instala dependências;
3. sobe a versão patch, por exemplo `1.0.74` → `1.0.75`;
4. gera o build web;
5. gera o instalador Electron `.exe`;
6. cria `latest.yml` e `.blockmap`;
7. envia por SSH/SCP para o Oracle:

```txt
ubuntu@wa.mpr.pt:/home/ubuntu/programas/mprWA/release
```

Se o teu SSH já funciona no Windows para `ubuntu@wa.mpr.pt`, não precisas configurar mais nada.

Se usares uma chave específica, define uma vez:

```powershell
[Environment]::SetEnvironmentVariable('WAPRO_DEPLOY_KEY', 'C:\caminho\da\chave.pem', 'User')
```

Depois fecha e abre o PowerShell.

No fim, confirma que o servidor mostra a nova versão em:

```txt
https://wa.mpr.pt/api/desktop/updates/latest.yml
```
