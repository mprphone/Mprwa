# WA PRO - Plano de Implementação (Windows Server 2016)

Este documento descreve a arquitetura técnica para implementar o WA PRO num ambiente **Windows Server 2016**, utilizando o IIS como servidor web e Node.js nativo.

## 1. Arquitetura do Sistema (Windows Native)

Não utilizaremos Docker. O sistema correrá diretamente no SO para máxima performance e compatibilidade.

```mermaid
graph TD
    User[Utilizador] -->|HTTPS :443| IIS[IIS (Internet Information Services)]
    WA[WhatsApp Cloud API] -->|Webhook :443| IIS
    
    subgraph "Windows Server 2016"
        IIS -->|Static Files| Frontend[Pasta do React (build)]
        IIS -->|Reverse Proxy /api| Backend[Node.js (Porta 3000)]
        Backend -->|Conexão TCP| Postgres[PostgreSQL Service]
    end
```

## 2. Pré-requisitos de Software

Deve instalar o seguinte software no servidor:

1.  **Node.js (LTS):** Descarregar o instalador `.msi` (v18 ou v20) em [nodejs.org](https://nodejs.org).
2.  **PostgreSQL para Windows:** Descarregar o instalador em [postgresql.org](https://www.postgresql.org/download/windows/).
3.  **Git para Windows:** Para descarregar o código.
4.  **IIS (Função do Servidor):** Ativar via "Server Manager" > Add Roles and Features > Web Server (IIS).
5.  **Módulos IIS Obrigatórios (Descarregar e Instalar):**
    *   [URL Rewrite Module 2.1](https://www.iis.net/downloads/microsoft/url-rewrite)
    *   [Application Request Routing (ARR) 3.0](https://www.iis.net/downloads/microsoft/application-request-routing) (Necessário para o Proxy reverso).

## 3. Passo a Passo de Instalação

### Passo 1: Configurar a Base de Dados
1.  Abra o **pgAdmin** (instalado com o PostgreSQL) ou SQL Shell.
2.  Crie um utilizador e base de dados:
    ```sql
    CREATE DATABASE wapro;
    CREATE USER wapro_admin WITH PASSWORD 'SenhaSegura123';
    GRANT ALL PRIVILEGES ON DATABASE wapro TO wapro_admin;
    ```

### Passo 2: Configurar o Backend (Node.js)
1.  Crie uma pasta `C:\inetpub\wwwroot\wapro`.
2.  Clone o código ou copie os ficheiros.
3.  Abra o **PowerShell** como Administrador na pasta do backend.
4.  Instale as dependências e compile:
    ```powershell
    npm install
    npm run build
    ```
5.  **Instalar Gestor de Processos (PM2):**
    O PM2 garante que o site não vai abaixo e arranca com o Windows.
    ```powershell
    npm install -g pm2
    npm install -g pm2-windows-service
    pm2-service-install
    # (Siga as instruções para definir a variável PM2_HOME se solicitado)
    ```
6.  **Iniciar o Backend:**
    ```powershell
    # Defina as variáveis de ambiente (SetX para persistir ou ficheiro .env)
    $env:DATABASE_URL="postgres://wapro_admin:SenhaSegura123@localhost:5432/wapro"
    $env:PORT="3000"
    
    pm2 start dist/server.js --name "wapro-api"
    pm2 save
    ```

### Passo 3: Configurar o Frontend (React)
1.  Na sua máquina local ou servidor, compile o frontend:
    ```powershell
    npm install
    npm run build
    ```
2.  Copie o conteúdo da pasta `dist` (gerada pelo build) para uma nova pasta no servidor: `C:\inetpub\wwwroot\wapro-client`.

### Passo 4: Configurar o IIS (Oregastrador)

1.  **Criar o Site:**
    *   Abra o **IIS Manager**.
    *   Botão direito em "Sites" -> "Add Website".
    *   **Site name:** `WAPro`.
    *   **Physical path:** `C:\inetpub\wwwroot\wapro-client`.
    *   **Port:** 80 (ou 443 se já tiver certificado).
    *   **Host name:** `wa.suaempresa.com`.

2.  **Configurar o `web.config`:**
    Na pasta `C:\inetpub\wwwroot\wapro-client`, crie um ficheiro chamado `web.config` com o seguinte conteúdo. Isto é **crítico** para funcionar o React Router e a API no mesmo domínio:

    ```xml
    <?xml version="1.0" encoding="UTF-8"?>
    <configuration>
      <system.webServer>
        <rewrite>
          <rules>
            <!-- Regra 1: Enviar tudo que começa por /api para o Node.js (Porta 3000) -->
            <rule name="ReverseProxyInboundRule1" stopProcessing="true">
              <match url="^api/(.*)" />
              <action type="Rewrite" url="http://localhost:3000/api/{R:1}" />
            </rule>

            <!-- Regra 2: React Router (Single Page App) -->
            <!-- Se não for ficheiro nem pasta, envia para index.html -->
            <rule name="ReactRoutes" stopProcessing="true">
              <match url=".*" />
              <conditions logicalGrouping="MatchAll">
                <add input="{REQUEST_FILENAME}" matchType="IsFile" negate="true" />
                <add input="{REQUEST_FILENAME}" matchType="IsDirectory" negate="true" />
                <add input="{REQUEST_URI}" pattern="^/api/" negate="true" />
              </conditions>
              <action type="Rewrite" url="/" />
            </rule>
          </rules>
        </rewrite>
      </system.webServer>
    </configuration>
    ```

### Passo 5: SSL (HTTPS) - Obrigatório para WhatsApp
O WhatsApp **não funciona** sem HTTPS.
1.  Descarregue a ferramenta **win-acme** (Simples cliente Let's Encrypt para Windows).
2.  Execute `wacs.exe`.
3.  Escolha "N" (Create new certificate).
4.  Escolha o site "WAPro" da lista.
5.  Ele irá gerar o certificado e configurar o IIS automaticamente.

## Resumo de Manutenção

*   **Ver logs do Backend:** `pm2 logs wapro-api` (no PowerShell).
*   **Reiniciar Backend:** `pm2 restart wapro-api`.
*   **Atualizar Frontend:** Substituir ficheiros na pasta `wapro-client`.
