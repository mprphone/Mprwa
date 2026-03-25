require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const axios = require('axios');

const app = express();
const port = process.env.PORT || 3000;

// Configuração da Base de Dados (PostgreSQL)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

app.use(cors());
app.use(express.json());

// --- Middleware de Log ---
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// --- Rotas de Teste ---
app.get('/api/health', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json({ status: 'ok', db_time: result.rows[0].now });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ==========================================
// WHATSAPP WEBHOOK (Integração Oficial)
// ==========================================

// 1. Verificação do Token (Meta exige isto para configurar)
app.get('/api/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === process.env.WA_VERIFY_TOKEN) {
      console.log('WEBHOOK_VERIFIED');
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403);
    }
  }
});

// 2. Receção de Mensagens
app.post('/api/webhook', async (req, res) => {
  const body = req.body;

  if (body.object) {
    if (body.entry && body.entry[0].changes && body.entry[0].changes[0].value.messages && body.entry[0].changes[0].value.messages[0]) {
      const msg = body.entry[0].changes[0].value.messages[0];
      const contact = body.entry[0].changes[0].value.contacts[0];
      
      const phoneNumber = contact.wa_id; // Ex: 351912345678
      const userName = contact.profile.name;
      const messageBody = msg.text ? msg.text.body : '[Media/Outro]';
      const waMessageId = msg.id;

      try {
        await processIncomingMessage(phoneNumber, userName, messageBody, waMessageId);
      } catch (e) {
        console.error('Erro ao processar mensagem:', e);
      }
    }
    res.sendStatus(200);
  } else {
    res.sendStatus(404);
  }
});

// Lógica de Processamento de Entrada
async function processIncomingMessage(phone, name, text, waId) {
  const client = await pool.connect();
  try {
    // 1. Achar ou Criar Cliente
    let customerRes = await client.query('SELECT id FROM customers WHERE phone = $1', [`+${phone}`]);
    let customerId;

    if (customerRes.rows.length === 0) {
      const newCust = await client.query(
        'INSERT INTO customers (name, phone, company) VALUES ($1, $2, $3) RETURNING id',
        [name, `+${phone}`, 'Novo Cliente']
      );
      customerId = newCust.rows[0].id;
    } else {
      customerId = customerRes.rows[0].id;
    }

    // 2. Achar ou Criar Conversa
    let convRes = await client.query('SELECT id FROM conversations WHERE customer_id = $1 AND status != \'closed\'', [customerId]);
    let conversationId;

    if (convRes.rows.length === 0) {
      const newConv = await client.query(
        'INSERT INTO conversations (customer_id, status) VALUES ($1, \'open\') RETURNING id',
        [customerId]
      );
      conversationId = newConv.rows[0].id;
    } else {
      conversationId = convRes.rows[0].id;
      // Atualizar timestamp
      await client.query('UPDATE conversations SET last_message_at = NOW(), unread_count = unread_count + 1 WHERE id = $1', [conversationId]);
    }

    // 3. Inserir Mensagem
    await client.query(
      'INSERT INTO messages (conversation_id, direction, body, wa_message_id, status) VALUES ($1, \'in\', $2, $3, \'read\')',
      [conversationId, text, waId]
    );

    console.log(`Mensagem guardada de ${name}: ${text}`);

  } finally {
    client.release();
  }
}


// ==========================================
// API REST (Para o Frontend)
// ==========================================

// --- Conversas ---
app.get('/api/conversations', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT c.*, cust.name as customer_name, cust.company 
      FROM conversations c
      JOIN customers cust ON c.customer_id = cust.id
      ORDER BY c.last_message_at DESC
    `);
    // Transformar para o formato que o Frontend espera
    const formatted = result.rows.map(r => ({
      id: r.id.toString(),
      customerId: r.customer_id.toString(),
      ownerId: r.owner_id ? r.owner_id.toString() : null,
      status: r.status,
      lastMessageAt: r.last_message_at,
      unreadCount: r.unread_count
    }));
    res.json(formatted);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Mensagens de uma Conversa ---
app.get('/api/conversations/:id/messages', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC',
      [id]
    );
    const formatted = result.rows.map(r => ({
      id: r.id.toString(),
      conversationId: r.conversation_id.toString(),
      direction: r.direction,
      body: r.body,
      timestamp: r.created_at,
      type: r.type,
      status: r.status
    }));
    res.json(formatted);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Enviar Mensagem (Saída) ---
app.post('/api/conversations/:id/messages', async (req, res) => {
  const { id } = req.params;
  const { text } = req.body;
  
  const client = await pool.connect();
  try {
    // 1. Obter telefone do cliente
    const convInfo = await client.query(
      'SELECT cust.phone FROM conversations c JOIN customers cust ON c.customer_id = cust.id WHERE c.id = $1',
      [id]
    );
    
    if (convInfo.rows.length === 0) return res.status(404).send('Conversa não encontrada');
    const phone = convInfo.rows[0].phone;

    // 2. Enviar para a API do WhatsApp (Meta)
    // NOTA: Em produção, coloque o token no .env
    /*
    await axios.post(`https://graph.facebook.com/v17.0/${process.env.WA_PHONE_ID}/messages`, {
      messaging_product: 'whatsapp',
      to: phone,
      text: { body: text }
    }, {
      headers: { Authorization: `Bearer ${process.env.WA_API_TOKEN}` }
    });
    */

    // 3. Guardar na BD
    const result = await client.query(
      'INSERT INTO messages (conversation_id, direction, body, status) VALUES ($1, \'out\', $2, \'sent\') RETURNING *',
      [id, text]
    );

    await client.query('UPDATE conversations SET last_message_at = NOW() WHERE id = $1', [id]);

    const r = result.rows[0];
    res.json({
      id: r.id.toString(),
      conversationId: r.conversation_id.toString(),
      direction: r.direction,
      body: r.body,
      timestamp: r.created_at,
      type: r.type,
      status: r.status
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// --- Clientes ---
app.get('/api/customers', async (req, res) => {
    const result = await pool.query('SELECT * FROM customers ORDER BY name');
    const formatted = result.rows.map(r => ({
        id: r.id.toString(),
        name: r.name,
        company: r.company,
        phone: r.phone,
        email: r.email,
        type: r.type,
        ownerId: r.owner_id ? r.owner_id.toString() : null,
        allowAutoResponses: r.allow_auto_responses,
        contacts: [] // TODO: Join with contacts table
    }));
    res.json(formatted);
});

app.listen(port, () => {
  console.log(`WA PRO Backend a rodar na porta ${port}`);
});
