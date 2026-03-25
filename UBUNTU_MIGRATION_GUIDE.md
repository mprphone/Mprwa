# Guia de Migracao Windows -> Ubuntu (Oracle)

Este projeto foi originalmente montado em Windows. Ao copiar para Linux, os erros mais comuns sao de dependencias nativas e permissoes.

## 1. Pre-requisitos no Ubuntu

```bash
sudo apt update
sudo apt install -y build-essential python3 make g++ sqlite3
node -v
npm -v
```

Recomendado: Node 20 LTS.

## 2. Nao reutilizar `node_modules` de Windows

Se copiou a pasta inteira do Windows, remova apenas `node_modules` e instale de novo no Ubuntu:

```bash
rm -rf node_modules
npm ci
```

Se der erro de permissao no cache do npm em ambientes restritos:

```bash
npm_config_cache=/tmp/.npm npm ci
```

## 3. Correcao rapida de binarios Linux

Depois de instalar, execute:

```bash
npm run fix:linux
```

Este comando faz:
- rebuild do `sqlite3` para Linux
- `chmod +x` dos executaveis em `node_modules/.bin`

## 4. Build e arranque

```bash
npm run build
npm start
```

API e frontend ficam em `http://localhost:3000`.

## 5. Erros comuns e causa

- `invalid ELF header` em `sqlite3`
  - `node_modules` veio do Windows (binario `.node` incompativel com Linux).
  - Solucao: reinstalar dependencias no Ubuntu e correr `npm run fix:linux`.

- `vite: Permission denied`
  - executaveis sem permissao `+x` apos copia entre sistemas.
  - Solucao: `npm run fix:linux`.

- `ENOTEMPTY` em `npm install`/`npm ci`
  - `node_modules` ficou em estado parcial.
  - Solucao: apagar `node_modules` e repetir `npm ci`.

## 6. Oracle Cloud (acesso externo)

Se quiser abrir externamente:
- Security List/NSG: permitir TCP 3000 (ou usar reverse proxy em 80/443).
- Firewall local (`ufw`): `sudo ufw allow 3000/tcp`

Para webhook em teste, use `cloudflared` Linux:

```bash
./cloudflared tunnel --url http://localhost:3000
```
