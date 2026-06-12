const http = require('http');

const payload = JSON.stringify({
  actorUserId: "1",
  responsibleUserId: "1",
  tipo: "Férias",
  descricao: "Teste erro Supabase",
  status: "PENDENTE"
});

const req = http.request({
  hostname: '127.0.0.1',
  port: 3010,
  path: '/api/internal-chat/pedidos/supabase',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload)
  }
}, (res) => {
  let data = '';
  res.on('data', (chunk) => { data += chunk; });
  res.on('end', () => {
    console.log(`Status: ${res.statusCode}`);
    console.log(`Response: ${data}`);
  });
});

req.on('error', (e) => {
  console.error(`Problem with request: ${e.message}`);
});

req.write(payload);
req.end();
