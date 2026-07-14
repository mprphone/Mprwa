# Migração segura da autenticação da API

Este documento descreve como retirar o bypass local sem interromper mensagens,
chat, aplicações desktop/mobile ou robôs fiscais. A regra principal é simples:
**não alterar `ALLOW_LOCAL_API_WITHOUT_AUTH` até todos os critérios da fase
correspondente estarem cumpridos e registados.**

## Estado confirmado em 14 de julho de 2026

- O backend só escuta em `127.0.0.1:3010`; o acesso externo continua pelo Nginx.
- `AUTH_SECRET` e `INTERNAL_API_KEY` estão configurados.
- `REQUIRE_API_AUTH` está ativo pelo valor default do código.
- `ALLOW_LOCAL_API_WITHOUT_AUTH` não está definido e, por isso, continua `true`.
- O log entre 2 e 14 de julho contém 18.344 observações deduplicadas de bypass.
- A maioria é frontend externo: chat, presença, tarefas, documentos e sincronização.
- Foram encontradas 53 observações locais sem chave. Entre as causas confirmadas
  estavam o helper dos coletores de Finanças, Segurança Social, IAPMEI e Banco
  de Portugal e o benchmark local. Ambos passam agora a enviar a chave. Algumas
  observações podem ser browser/diagnóstico executado no próprio servidor e
  serão distinguidas pelo novo identificador diagnóstico.
- As novas sessões ficam persistidas no SQLite e sobrevivem a restart. No
  arranque, o frontend valida o cookie em `/api/auth/me` antes de aceitar o
  utilizador guardado localmente. O modo de compatibilidade offline permanece
  temporariamente enquanto o bypass estiver em observação.
- O bypass também deixa sondagens externas atravessarem o middleware de auth,
  embora rotas inexistentes acabem normalmente em 404.

Estes números são observações deduplicadas por rota/origem, não o total bruto de
pedidos. Servem para inventário e comparação entre dias.

## Âmbito e integrações externas (Vercel/Supabase)

O fecho de `ALLOW_LOCAL_API_WITHOUT_AUTH` protege apenas os pedidos que chegam ao
backend `mprWA` em `127.0.0.1:3010`, normalmente através de `wa.mpr.pt`. Não se
deve inferir, a partir do log deste backend, que todos os robôs da infraestrutura
foram inventariados.

Inventário confirmado em 14 de julho de 2026:

| Origem/serviço | Caminho observado | Autenticação | Relação com o bypass `mprWA` |
| --- | --- | --- | --- |
| `controle.mpr.pt` | Vercel → Supabase | sessão/RLS do Supabase | não passa pelo `mprWA`; o bundle atual usa diretamente tabelas como `clientes`, `funcionarios`, `pedidos` e `configuracoes` |
| Supabase Edge Functions | Supabase → `iuc.mpr.pt` (`/jobs/:id`, `/emitir-guia-iuc`, `/recolher-iuc`) | `x-robot-secret`; `ROBOT_REQUIRE_SECRET=true` | independente do bypass `mprWA` |
| Supabase Edge Functions | Supabase → `imi.mpr.pt` (`/campanhas/start`) | segredo do robô; `ROBOT_REQUIRE_SECRET=true` | independente do bypass `mprWA` |
| `pri.mpr.pt` | Nginx → serviço local `127.0.0.1:4100` | tokens próprios da extensão Primavera | serviço separado; não passa por `3010` |
| `api.pr.pt` | infraestrutura externa a este servidor | por confirmar no respetivo projeto | fora do âmbito técnico deste backend |

O projeto Supabase contém ainda recursos como `robot_jobs`, `imi_robot_jobs`,
`robot_campaigns`, `imi_robot_campaigns`, `iuc_global_pedidos` e
`imi_global_pedidos`. A atividade nestas tabelas não aparece em
`logs/auth-events.log`; deve ser acompanhada pelos logs das Edge Functions e dos
serviços `iuc-bot`/`imi-bot`.

Regras para estas integrações:

1. Nunca colocar `INTERNAL_API_KEY`, `ROBOT_API_SECRET` ou uma chave
   `service_role` em JavaScript entregue ao browser pelo Vercel.
2. Guardar segredos apenas nas variáveis server-side do Vercel/Supabase Edge e
   enviá-los de funções server-to-server.
3. Não usar allowlist de IP para Vercel ou Supabase Edge; os IPs de saída são
   variáveis. Autenticar por segredo rotacionável e identificar a integração no
   log.
4. Antes de alterar a autenticação de `iuc.mpr.pt`, `imi.mpr.pt`, `pri.mpr.pt`
   ou `api.pr.pt`, criar um plano e uma janela de observação próprios.

## Modos registados

O ficheiro `logs/auth-events.log` passa a distinguir:

- `allow_internal`: chamada autorizada por `x-internal-api-key`.
- `allow_session`: chamada autorizada por sessão real do utilizador.
- `bypass`: chamada que só funcionou porque o bypass continua ativo.
- `reject`: chamada recusada por falta de autenticação.

Cada linha inclui rota normalizada, origem, modo de transporte, hash estável do
User-Agent, utilizador da sessão e `clientUser`. `clientUser` é declarado pelo
frontend apenas para diagnóstico e **nunca é aceite como autenticação**. Não são
registados cookies, tokens, chaves, corpos, palavras-passe, telefones ou IDs de
clientes presentes na rota.

Relatório das últimas 24 horas:

```bash
npm run auth:usage
```

Outros intervalos e formato JSON:

```bash
npm run auth:usage -- --hours=168
npm run auth:usage -- --hours=24 --json
```

O log é deduplicado por modo, rota, origem e cliente durante o período definido
por `AUTH_EVENT_DEDUPE_MS` (default: 10 minutos). O diretório e o ficheiro são
forçados para permissões `700` e `600` quando houver um novo evento.

## Fase 0 — contenção já aplicada

- Backend limitado ao loopback.
- URLs malformadas rejeitadas sem stack trace.
- Fallback SPA limitado a `/` e `/index.html`.
- Nginx continua como única entrada pública.
- O bypass continua ativo para não partir funcionalidades.

Rollback: reverter o commit correspondente e reiniciar `mprwa-backend`. Não é
necessário alterar Nginx, DNS ou sessões WhatsApp.

## Fase 1 — inventário e chave interna

Alterações de baixo risco:

1. Todos os workers que chamam a API local devem usar
   `src/server/utils/internalApi.js`.
2. O helper `backend/services/fiscal/collectors/httpPost.js` deve anexar a chave;
   isso cobre Finanças, Segurança Social, IAPMEI e Banco de Portugal.
3. Manter o bypass ativo e observar pelo menos sete dias.
4. Executar diariamente:

   ```bash
   npm run auth:usage -- --hours=24
   ```

A janela de sete dias começa depois do deploy desta instrumentação. As entradas
anteriores permanecem no mesmo ficheiro para preservar o histórico e sairão
naturalmente do intervalo do relatório.

Critérios para concluir a fase:

- `allow_internal` aparece para cada família de robôs efetivamente executada.
- `bypass local (robôs/processos)` permanece em zero durante sete dias.
- Não existem respostas 401 nos logs funcionais dos robôs.
- Mensagens recebidas/enviadas e filas permanecem saudáveis.

Se aparecer bypass local, não avançar. Identificar a rota, corrigir o chamador
para enviar a chave e reiniciar novamente a janela de observação.

## Fase 2 — tornar sessões persistentes e verificáveis

Antes de exigir login, corrigir o ciclo de sessão:

1. [Implementado] Persistir sessões no SQLite com token assinado, expiração e
   revogação; apenas o hash do identificador secreto fica na base de dados.
2. [Implementado] No arranque do frontend, chamar `/api/auth/me`; `localStorage`
   sozinho já não significa autenticação quando o backend responde normalmente.
3. [Implementado] Se a sessão expirou ou foi revogada, encaminhar para login.
4. Manter cookie `HttpOnly`, `Secure`, `SameSite=Lax` e expiração curta.
5. Migrar palavras-passe em texto simples para Argon2id de forma progressiva no
   próximo login bem-sucedido.
6. Adicionar rate limiting e resposta genérica ao login.

Critérios para concluir a fase:

- Reiniciar o backend não deixa a interface num falso estado autenticado.
- `allow_session` substitui gradualmente `bypass external_proxy`.
- O relatório identifica o utilizador server-side em todas as rotas protegidas.
- Logout revoga a sessão e a sessão expirada recebe 401.

## Fase 3 — ensaio controlado sem bypass

Fazer numa janela acompanhada, com acesso SSH/Tailscale disponível.

Esta fase fecha apenas o bypass do `mprWA`. Antes do ensaio, confirmar que os
fluxos Supabase Edge → IUC/IMI continuam saudáveis, mas não alterar os segredos
desses serviços na mesma janela.

1. Guardar cópia do `.env` com permissões restritas.
2. Definir `ALLOW_LOCAL_API_WITHOUT_AUTH=false`.
3. Reiniciar: `sudo systemctl restart mprwa-backend`.
4. Validar imediatamente a matriz abaixo.
5. Acompanhar `journalctl -u mprwa-backend` e `logs/auth-events.log`.

Matriz mínima de validação:

| Área | Teste seguro | Resultado esperado |
|---|---|---|
| API anónima | GET protegido sem cookie/chave | 401 |
| Login | Login web externo e `/api/auth/me` | sessão válida |
| Restart | reiniciar backend e recarregar frontend | sessão coerente ou novo login |
| WhatsApp | health das duas contas | ambas conectadas |
| Mensagens | enviar/receber com contacto de teste | uma mensagem, sem duplicação |
| Fila | verificar `queuePending`/`deadLetter` | sem itens presos novos |
| Chat interno | listar, enviar, marcar como lida | funcionamento normal |
| Clientes/tarefas | abrir e gravar registo de teste | funcionamento normal |
| Auto-pull | executar sincronização controlada | `allow_internal`, sem 401 |
| Finanças | um cliente de teste | recolha concluída ou erro funcional, nunca 401 |
| Segurança Social | um cliente de teste | idem |
| IAPMEI/Banco Portugal | um teste de cada aplicável | idem |
| Obrigações | um job controlado | worker autorizado pela chave |

Critérios de sucesso:

- Zero bypass, porque estará desativado.
- Zero 401 para `allow_internal` esperado.
- 401 apenas para acessos realmente anónimos/expirados.
- Sem aumento de falhas de envio, duplicados ou reconexões WhatsApp.

Rollback imediato se um fluxo crítico falhar:

```bash
# restaurar ALLOW_LOCAL_API_WITHOUT_AUTH=true no .env
sudo systemctl restart mprwa-backend
curl -fsS http://127.0.0.1:3010/api/chat/health
```

O rollback não exige remover a chave interna nem a nova auditoria.

## Fase 4 — endurecimento posterior

Depois da autenticação estabilizar:

- Restringir CORS a origens aprovadas.
- Aplicar rate limiting no login e endpoints públicos.
- Corrigir permissões de `.env`, SQLite e pastas Baileys.
- Usar chave dedicada para cifrar credenciais de clientes.
- Aplicar firewall local default-deny e restringir PostgreSQL/RDP/SSH/dev servers.
- Adicionar CSP em report-only, HSTS e restantes headers de segurança.
- Testar restauração dos backups e cifrar a cópia externa.

Estas mudanças devem ter janelas e rollbacks próprios; não devem ser misturadas
com o primeiro dia de enforcement da autenticação.
