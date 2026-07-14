import http from 'node:http';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { postLocalJson } = require('../../backend/services/fiscal/collectors/httpPost.js');

describe('fiscal collector internal authentication', () => {
  let server;
  const previousKey = process.env.INTERNAL_API_KEY;

  afterEach(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    server = null;
    if (previousKey === undefined) delete process.env.INTERNAL_API_KEY;
    else process.env.INTERNAL_API_KEY = previousKey;
  });

  it('envia a chave interna sem expô-la no corpo', async () => {
    process.env.INTERNAL_API_KEY = 'test-internal-secret';
    let captured;
    server = http.createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => {
        captured = { headers: request.headers, body };
        response.setHeader('Content-Type', 'application/json');
        response.end('{"success":true}');
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

    const result = await postLocalJson(server.address().port, '/probe', { customerId: 'c1' }, 2000);

    expect(result.statusCode).toBe(200);
    expect(captured.headers['x-internal-api-key']).toBe('test-internal-secret');
    expect(JSON.parse(captured.body)).toEqual({ customerId: 'c1' });
    expect(captured.body).not.toContain('test-internal-secret');
  });
});
