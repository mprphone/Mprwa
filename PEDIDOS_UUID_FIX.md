# Correção do Erro de UUID no Supabase - Pedidos

## 🔴 Problema Identificado

Ao tentar criar um novo pedido, você recebia o erro:
```
Falha ao criar pedido no Supabase (pedidos): 
invalid input syntax for type uuid: 'est_o_b731b160-cd00-4c3c-b2fc-704a89a3f18b'
```

**Causa Raiz:** O sistema estava a passar **IDs locais (SQLite)** em vez de **UUIDs do Supabase** para campos que esperam UUIDs.

## 🎯 Problemas Específicos Corrigidos

### 1. **responsibleUserId Não Mapeado** ❌→✅
**Antes:** O `responsibleUserId` (ID local) era enviado diretamente ao Supabase
```javascript
const payload = {};
payload['funcionario_id'] = responsibleUserId; // ❌ ID local enviado como UUID
```

**Depois:** O ID local é mapeado para o `funcionario_id` correto do Supabase
```javascript
// Validar e mapear responsibleUserId para UUID válido
if (!isValidUuid) {
    const localUser = await dbGetAsync('SELECT id, email FROM users WHERE id = ?', [responsibleUserIdRaw]);
    const funcionarioRow = await fetchFuncionarioByFilter(funcionariosTable, 'email', localUser.email);
    responsibleUserId = String(funcionarioRow.id).trim(); // ✅ UUID válido
}
```

### 2. **requesterIdForPayload Não Mapeado** ❌→✅
**Antes:** O `actorUserId` (ID local) era enviado como `requester_id`
```javascript
const requesterIdForPayload = String(actorUserId || responsibleUserId || '').trim();
payload['requester_id'] = requesterIdForPayload; // ❌ ID local
```

**Depois:** O ID local é mapeado ou excluído se não for válido
```javascript
let mappedRequesterIdForPayload = requesterIdForPayload;
if (requesterIdForPayload && !isValidUuid) {
    const localRequester = await dbGetAsync('SELECT id, email FROM users WHERE id = ?', [requesterIdForPayload]);
    const requesterFuncionario = await fetchFuncionarioByFilter(funcionariosTable, 'email', localRequester.email);
    mappedRequesterIdForPayload = String(requesterFuncionario.id).trim(); // ✅ UUID válido
}
```

## 📋 Ficheiros Alterados

- **[backend/routes/localDataPedidosPontoRoutes.js](backend/routes/localDataPedidosPontoRoutes.js)**
  - Linhas ~620-650: Adicionada validação de UUID e mapeamento de `responsibleUserId`
  - Linhas ~789-810: Adicionada validação de UUID e mapeamento de `requesterIdForPayload`

## 🧪 Como Testar

### Opção 1: Script Automatizado
```bash
node test-pedido-fix.js
```

Isto enviará dois casos de teste:
1. **ID Local para UUID** - Simula o cenário antigo (deve agora funcionar)
2. **UUID Válido Diretamente** - Continua a funcionar como antes

### Opção 2: Testar Manualmente
1. Abra a app (web ou electron)
2. Acesse "Chat Interno" → "Criar Pedido"
3. Preencha os campos:
   - **Tipo:** Férias
   - **Descrição:** Teste de correção
   - **Data:** Hoje
4. Clique em "Criar Pedido"
5. **Esperado:** Na consola do servidor, verá logs como:
   ```
   [Pedidos] Mapeamento local→Supabase: { 
       inputId: 'est_o_...', 
       isValidUuid: false, 
       found: true,
       email: 'utilizador@mpr.pt' 
   }
   [Pedidos] Mapeamento bem-sucedido: { 
       localId: 'est_o_...', 
       supabaseId: 'a1b2c3d4-e5f6-4...', 
       email: 'utilizador@mpr.pt' 
   }
   ```

## 🔍 Validação de UUID

O sistema agora valida UUIDs com a regex:
```
/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
```

Um UUID válido tem o formato: `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`

Exemplo:
- ❌ `est_o_b731b160-cd00-4c3c-b2fc-704a89a3f18b` (começa com `est_o_`)
- ✅ `b731b160-cd00-4c3c-b2fc-704a89a3f18b` (formato correto)

## 📌 Notas Importantes

1. **Mapeamento por Email:** O sistema mapeia IDs locais para Supabase pelo **email** do utilizador
   - Certifique-se de que o email do utilizador local corresponde ao email no Supabase `funcionarios`

2. **Erro de Correspondência:** Se um utilizador não for encontrado no Supabase, receberá:
   ```
   Funcionário 'email@mpr.pt' não encontrado no Supabase. 
   Verifique a correspondência de email.
   ```
   → Solução: Adicione o utilizador à tabela `funcionarios` no Supabase com o mesmo email

3. **Logs de Debug:** Para debug adicional, os logs no servidor mostram:
   - Mapeamentos tentados
   - Erros de correspondência
   - UUIDs mapeados com sucesso

## 🚀 Próximos Passos (Opcional)

Se quiser criar/editar pedidos antigos (conforme mencionou):

1. **GET /api/internal-chat/pedidos/supabase/list** - Implementar listagem de pedidos
2. **PUT /api/internal-chat/pedidos/supabase/:pedidoId** - Implementar edição de pedido
3. **GET /api/internal-chat/pedidos/supabase/:pedidoId** - Implementar busca por ID

Quer que eu implemente estas rotas também?

---

**Status:** ✅ Corrigido | Versão: 1.0
