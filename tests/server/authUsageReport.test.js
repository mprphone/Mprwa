import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { normalizeRoute, parseAuthEventLine, summarize } = require('../../scripts/auth-usage-report.js');

describe('auth usage report', () => {
  it('normaliza identificadores sensíveis das rotas', () => {
    expect(normalizeRoute('/api/customers/ext_c_abc123/documents')).toBe('/api/customers/:id/documents');
    expect(normalizeRoute('/api/chat/conversations/conv_wa_c_351900000000/read')).toBe('/api/chat/conversations/:id/read');
  });

  it('interpreta o formato novo do log', () => {
    const event = parseAuthEventLine(
      '2026-07-14T12:00:00.000Z [allow_internal] POST /api/customers/:id/autologin/financas via=local_direct source=127.0.0.1 clientUser=- sessionUser=- internalKey=valid sessionToken=false uaHash=abc123 origin=-'
    );
    expect(event).toMatchObject({
      kind: 'allow_internal',
      via: 'local_direct',
      source: '127.0.0.1',
      internalKey: 'valid',
    });
  });

  it('mantém compatibilidade com o formato anterior', () => {
    const event = parseAuthEventLine(
      '2026-07-14T12:00:00.000Z [bypass] GET /api/tasks/local via=externo(nginx) remote=127.0.0.1 xff=188.250.229.178 internalKey=false sessionToken=false'
    );
    expect(event).toMatchObject({ kind: 'bypass', via: 'external_proxy', source: '188.250.229.178' });
  });

  it('bloqueia prontidão enquanto existir qualquer bypass', () => {
    const events = [
      parseAuthEventLine('2026-07-14T12:00:00.000Z [bypass] GET /api/tasks/local via=local_direct source=127.0.0.1 internalKey=absent'),
      parseAuthEventLine('2026-07-14T12:00:01.000Z [bypass] GET /api/chat/messages via=external_proxy source=203.0.113.1 internalKey=absent'),
    ];
    const result = summarize(events);
    expect(result.localBypass).toBe(1);
    expect(result.externalBypass).toBe(1);
  });
});
