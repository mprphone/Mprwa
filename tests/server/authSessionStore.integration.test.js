import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const sqlite3 = require('sqlite3');
const { createAuthSessionStore } = require('../../src/server/security/authSessionStore.js');

describe('authSessionStore com SQLite', () => {
  let db;
  let currentTime;

  const run = (sql, params = []) => new Promise((resolve, reject) => {
    db.run(sql, params, function callback(error) {
      if (error) reject(error);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
  const get = (sql, params = []) => new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => error ? reject(error) : resolve(row || null));
  });

  const makeStore = () => createAuthSessionStore({
    dbRunAsync: run,
    dbGetAsync: get,
    secret: 'segredo-de-teste-suficientemente-longo',
    ttlMs: 60_000,
    now: () => currentTime,
    cacheTtlMs: 1_000,
  });

  beforeEach(async () => {
    currentTime = Date.parse('2026-07-14T10:00:00.000Z');
    db = new sqlite3.Database(':memory:');
    await run(`CREATE TABLE auth_sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      email TEXT,
      role TEXT,
      expires_at_ms INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      revoked_at DATETIME
    )`);
  });

  afterEach(async () => {
    if (!db) return;
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve, reject) => db.close((error) => error ? reject(error) : resolve()));
  });

  it('recupera uma sessão depois de recriar o store sem guardar o token em claro', async () => {
    const firstStore = makeStore();
    const created = await firstStore.create({ id: 'user-1', email: 'Pessoa@Exemplo.pt', role: 'admin' });
    const sessionId = created.token.split('.')[1];
    const row = await get('SELECT token_hash, user_id FROM auth_sessions LIMIT 1');

    expect(row.user_id).toBe('user-1');
    expect(row.token_hash).toBe(firstStore.hashSessionId(sessionId));
    expect(row.token_hash).not.toContain(sessionId);

    const restartedStore = makeStore();
    await expect(restartedStore.get(created.token)).resolves.toEqual({
      userId: 'user-1',
      email: 'pessoa@exemplo.pt',
      role: 'admin',
      expiresAt: currentTime + 60_000,
    });
  });

  it('rejeita tokens adulterados, expirados e revogados', async () => {
    const store = makeStore();
    const first = await store.create({ id: 'user-1', email: 'a@example.pt', role: 'user' });
    await expect(store.get(`${first.token}x`)).resolves.toBeNull();

    currentTime += 60_001;
    await expect(store.get(first.token)).resolves.toBeNull();

    const second = await store.create({ id: 'user-2', email: 'b@example.pt', role: 'user' });
    await expect(store.revoke(second.token)).resolves.toBe(true);
    await expect(store.get(second.token)).resolves.toBeNull();
  });
});
