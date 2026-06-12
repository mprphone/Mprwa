#!/usr/bin/env node
/**
 * Test script to validate the pedido UUID mapping fix
 * Tests both local ID → Supabase UUID conversion scenarios
 */

const API_BASE = 'http://localhost:3012';

// Mock data - substitute with real values from your system
const TEST_CASOS = [
    {
        name: 'Novo Pedido - ID Local para UUID',
        payload: {
            actorUserId: 'est_o_8f3a4d8c2g1h5j6k', // ID local (deve ser mapeado)
            actorName: 'João Silva',
            actorEmail: 'joao@mpr.pt',
            responsibleUserId: 'est_o_8f3a4d8c2g1h5j6k', // ID local (será mapeado)
            tipo: 'Férias',
            descricao: 'Teste de mapeamento UUID',
            dataInicio: new Date().toISOString().split('T')[0],
            dataFim: new Date().toISOString().split('T')[0],
            status: 'PENDENTE'
        }
    },
    {
        name: 'Novo Pedido - UUID Válido Diretamente',
        payload: {
            actorUserId: 'a1b2c3d4-e5f6-4g7h-8i9j-0k1l2m3n4o5p', // UUID válido
            actorName: 'Maria Santos',
            actorEmail: 'maria@mpr.pt',
            responsibleUserId: 'b1c2d3e4-f5g6-4h7i-8j9k-0l1m2n3o4p5q', // UUID válido
            tipo: 'Licença',
            descricao: 'Teste com UUID válido',
            dataInicio: new Date().toISOString().split('T')[0],
            dataFim: new Date().toISOString().split('T')[0],
            status: 'PENDENTE'
        }
    }
];

async function testarPedido(testCase) {
    console.log(`\n📝 Testando: ${testCase.name}`);
    console.log('─'.repeat(60));
    
    try {
        const response = await fetch(`${API_BASE}/api/internal-chat/pedidos/supabase`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(testCase.payload)
        });
        
        const data = await response.json();
        
        if (response.ok && data.success) {
            console.log('✅ SUCESSO');
            console.log(`   Tabela: ${data.table}`);
            console.log(`   Pedido ID: ${data.pedido?.id || 'N/A'}`);
            if (data.pedido?.funcionario_id) {
                console.log(`   Funcionário ID (UUID): ${data.pedido.funcionario_id}`);
                // Validar que é um UUID válido
                if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(data.pedido.funcionario_id)) {
                    console.log(`   ✓ UUID válido detectado`);
                } else {
                    console.log(`   ⚠️  UUID pode estar malformado!`);
                }
            }
        } else {
            console.log('❌ ERRO');
            console.log(`   Status: ${response.status}`);
            console.log(`   Erro: ${data.error}`);
            if (data.details) {
                console.log(`   Detalhes:`, data.details);
            }
        }
    } catch (error) {
        console.log('❌ ERRO DE CONEXÃO');
        console.log(`   ${error.message}`);
        console.log('   (Verifique se o servidor está a correr em http://localhost:3012)');
    }
}

async function main() {
    console.log('🧪 Teste de Mapeamento de UUID em Pedidos');
    console.log('═'.repeat(60));
    console.log('Este teste valida a correção do erro UUID no Supabase');
    console.log('Problema: IDs locais estavam sendo passados como UUIDs\n');
    
    for (const testCase of TEST_CASOS) {
        await testarPedido(testCase);
    }
    
    console.log('\n' + '═'.repeat(60));
    console.log('✓ Testes concluídos');
    console.log('\nVerifique o console do servidor para logs detalhados de mapeamento');
}

main().catch(console.error);
