# Guia de Instalação WA PRO - Windows Server 2016

Siga estes passos exatos para colocar o sistema a funcionar no seu servidor.

## FASE 1: Preparação do Servidor

1.  **Instalar Node.js**
    *   Vá a https://nodejs.org/en/download/
    *   Descarregue o `Windows Installer (.msi)` (v18 ou v20).
    *   Instale (Next, Next, Next).

2.  **Instalar PostgreSQL**
    *   Vá a https://www.postgresql.org/download/windows/
    *   Descarregue e instale a versão 15 ou 16.
    *   **Importante:** Anote a senha que definir para o superuser `postgres`.

3.  **Preparar Pastas**
    *   Crie a pasta `C:\inetpub\wwwroot\wapro`.
    *   Dentro dessa pasta, coloque todos os ficheiros deste projeto (extraia o zip ou clone o git).

## FASE 2: Configuração da Base de Dados

1.  Abra o **pgAdmin 4** (Vem com o PostgreSQL).
2.  Clique com o botão direito em "Databases" -> Create -> Database.
    *   Nome: `wapro`
3.  Clique com o botão direito na base de dados `wapro` criada -> "Query Tool".
4.  Abra o ficheiro `backend/schema.sql` (que acabei de criar para si) no Bloco de Notas.
5.  Copie todo o conteúdo e cole na Query Tool do pgAdmin.
6.  Clique no botão "Play" (Execute) para criar as tabelas.

## FASE 3: Configuração do Backend (API)

1.  Abra o **PowerShell** como Administrador.
2.  Navegue até à pasta do backend:
    ```powershell
    cd C:\inetpub\wwwroot\wapro\backend
    ```
3.  Instale as dependências:
    ```powershell
    npm install
    ```
4.  Crie um ficheiro `.env` nesta pasta com o seguinte conteúdo (ajuste a senha!):
    ```env
    PORT=3000
    DATABASE_URL=postgresql://postgres:SUA_SENHA_AQUI@localhost:5432/wapro
    WA_VERIFY_TOKEN=minha_senha_secreta_webhook
    WA_API_TOKEN=token_da_meta
    WA_PHONE_ID=id_do_telefone_meta
    ```
5.  Instale o PM2 para manter o site ligado:
    ```powershell
    npm install -g pm2 pm2-windows-service
    pm2-service-install
    pm2 start server.js --name "wapro-api"
    pm2 save
    ```

## FASE 4: Configuração do Frontend (Visual)

1.  No PowerShell, volte à raiz do projeto:
    ```powershell
    cd C:\inetpub\wwwroot\wapro
    ```
2.  Instale e construa o site:
    ```powershell
    npm install
    npm run build
    ```
    *(Isto vai criar uma pasta `dist`)*

## FASE 5: Configuração do IIS (Internet Information Services)

1.  Abra o **IIS Manager**.
2.  Se não tiver o "URL Rewrite" e "ARR" instalados, instale-os agora (links no ficheiro `IMPLEMENTATION_PLAN.md`).
3.  Clique com botão direito em "Sites" -> "Add Website".
    *   **Site name:** `WAPro`
    *   **Physical path:** `C:\inetpub\wwwroot\wapro\dist` (Aponte para a pasta `dist` criada no passo 4!)
    *   **Port:** 80
4.  Certifique-se que o ficheiro `web.config` está dentro da pasta `dist`. Se não estiver, copie-o (o código está no plano de implementação).

**Parabéns!** O seu sistema deve estar acessível em `http://localhost` ou no IP do servidor.
