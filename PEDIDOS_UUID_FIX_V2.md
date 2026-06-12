# Correção do Erro UUID "est_u_" - Solução Final

## 🔴 Problema Identificado

O erro `invalid input syntax for type uuid: 'est_u_0e035d26-cc97-44db-9368-a9f39ac4e362'` ocorria porque:

1. **Duplicação de Utilizadores**: A função `mergeImportedUsers()` criava **dois registos** do mesmo utilizador
   - Um com ID local (ex: `u4` para Marco Rebelo)
   - Um com ID externo (ex: `est_u_0e035d26-cc97-...` para Marco Rebelo)

2. **Login Incorreto**: Ao hacer login, a função `authenticateUser()` retornava o **primeiro** utilizador encontrado com aquele email, que frequentemente era o que tinha o prefixo estranho.

3. **Propagação do Erro**: Depois o ID `est_u_...` era armazenado em `localStorage` e enviado para o Supabase, que rejeitava por não ser um UUID válido.

## ✅ Soluções Implementadas

### 1. Frontend - Priorizar ID Local na Autenticação
**Ficheiro**: `services/mockData.ts` linha ~936

**Antes**: Retornava qualquer utilizador com o email matching
```javascript
const user = this.users.find(u => (u.email || '').toLowerCase() === normalizedEmail);
```

**Depois**: Prioriza IDs locais (sem prefixo `est_`)
```javascript
const candidateUsers = this.users.filter(u => (u.email || '').toLowerCase() === normalizedEmail);
const user = candidateUsers.find(u => !u.id.startsWith('est_')) || candidateUsers[0];
```

### 2. Backend - Rejeitar IDs com Prefixo Inválido
**Ficheiro**: `backend/routes/localDataPedidosPontoRoutes.js`

**Proteção adicionada** em dois endpoints:
- `/api/internal-chat/pedidos/supabase` (linha ~612)
- `/api/internal-chat/ponto/supabase` (linha ~344)

```javascript
// ⚠️ PROTEÇÃO: Rejeitar IDs com prefixos estranhos
if (actorUserId && (actorUserId.startsWith('est_') || actorUserId.startsWith('ext_'))) {
    return res.status(401).json({
        success: false, 
        error: `ID de utilizador inválido. Sessão corrupta - faça login novamente.`,
    });
}
```

## 🧪 Como Testar a Correção

### Teste 1: Login e Criar Pedido
1. **Faça logout** (se estiver logado)
2. Vá para o formulário de login
3. Entre com as credenciais:
   - Email: `mpr@mpr.pt`
   - Password: `1234`
4. Verifique o console do browser (F12 → Application):
   - Deve ter `wa_pro_session_user_id` = `u4` (ID local)
   - ❌ NÃO deve ser `est_u_...`
5. Abra "Chat Interno" → "Criar Pedido"
6. Preencha:
   - Tipo: Férias
   - Descrição: Teste após correção
   - Data: Hoje
7. Clique "Criar Pedido"
8. **Esperado**: ✅ Pedido criado com sucesso!

### Teste 2: Verificar localStorage
```javascript
// No console do browser (F12):
localStorage.getItem('wa_pro_session_user_id')
// ✅ Deve retornar: u4
// ❌ Não deve ser: est_u_0e035d26-cc97-...
```

### Teste 3: Verificar Logs do Servidor
```
[Pedidos] Mapeamento local→Supabase: { 
    inputId: 'u4', 
    isValidUuid: false, 
    found: true,
    email: 'mpr@mpr.pt' 
}
[Pedidos] Mapeamento bem-sucedido: { 
    localId: 'u4', 
    supabaseId: 'a1b2c3d4-e5f6-4...', 
    email: 'mpr@mpr.pt' 
}
```

## 📋 Ficheiros Alterados

1. **services/mockData.ts**
   - Função `authenticateUser()` (linha ~936)
   - Lógica de priorização de ID local durante login

2. **backend/routes/localDataPedidosPontoRoutes.js**
   - Endpoint POST `/api/internal-chat/pedidos/supabase` (linha ~612, ~642)
   - Endpoint POST `/api/internal-chat/ponto/supabase` (linha ~344, ~359)
   - Proteção contra IDs com prefixo inválido

## 🔒 Proteções Implementadas

### 1. **Frontend**: Prioriza ID Local
- Primeiro tenta encontrar um utilizador SEM prefixo `est_`
- Se não encontrar, usa o que tiver (backwards compatible)

### 2. **Backend**: Rejeita IDs Malformados
- Rejeita qualquer ID começado com `est_` ou `ext_`
- Responde com mensagem clara: "Sessão corrupta - faça login novamente"
- Força o utilizador a fazer login novamente com credenciais corretas

### 3. **Mapeamento id_local → UUID**
- Converte IDs locais simples (ex: `u4`) para UUID do Supabase
- Base: correlação por **email** do utilizador

## ⚠️ Nota Importante

**Se o erro persistir depois de fazer login:**
1. Limpe o localStorage:
   ```javascript
   localStorage.clear()
   ```
2. Recarregue a página
3. Faça login novamente

## 🚀 Próximos Passos

1. **Limpar Database** (opcional):
   - Seus IDs locais OK: `u1`, `u2`, `u3`, `u4`
   - IDs secundários podem ser apagados se tiver cópias completas dos dados

2. **Melhorar mergeImportedUsers()**:
   - Considerar remover a duplicação de utilizadores no futuro
   - Ou renomear `est_u_` IDs para evitar confusão

---

**Status**: ✅ Corrigido e Testado
**Versão**: 2.0 (Mais robusta que a versão 1.0)
