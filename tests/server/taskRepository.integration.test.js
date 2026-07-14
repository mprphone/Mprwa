import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const sqlite3 = require('sqlite3');
const { createTaskRepository } = require('../../src/server/repositories/taskRepository.js');

describe('taskRepository com SQLite', () => {
  let db;
  let repository;

  const run = (sql, params = []) => new Promise((resolve, reject) => {
    db.run(sql, params, function callback(error) {
      if (error) reject(error);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
  const get = (sql, params = []) => new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => error ? reject(error) : resolve(row));
  });
  const all = (sql, params = []) => new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows));
  });

  beforeEach(async () => {
    db = new sqlite3.Database(':memory:');
    await run(`CREATE TABLE customers (
      id TEXT PRIMARY KEY,
      name TEXT,
      company TEXT,
      phone TEXT
    )`);
    await run(`CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      customer_id TEXT
    )`);
    await run(`CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT,
      priority TEXT,
      due_date TEXT,
      assigned_user_id TEXT,
      notes TEXT,
      attachments_json TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    repository = createTaskRepository({
      dbAllAsync: all,
      dbGetAsync: get,
      dbRunAsync: run,
      parseJsonArray: (value) => {
        if (Array.isArray(value)) return value;
        if (!value) return [];
        try { return JSON.parse(value); } catch { return []; }
      },
    });
  });

  afterEach(async () => {
    if (!db) return;
    await new Promise((resolve, reject) => db.close((error) => error ? reject(error) : resolve()));
  });

  it('mantém nomes distintos para clientes que partilham o telefone', async () => {
    await run('INSERT INTO customers (id, name, company, phone) VALUES (?, ?, ?, ?)',
      ['c1', 'Cybercentro', 'Cybercentro', '+351917203280']);
    await run('INSERT INTO customers (id, name, company, phone) VALUES (?, ?, ?, ?)',
      ['c2', 'Dias de Aventura', 'Dias de Aventura', '+351917203280']);
    await run('INSERT INTO conversations (id, customer_id) VALUES (?, ?)', ['conv1', 'c1']);
    await run('INSERT INTO conversations (id, customer_id) VALUES (?, ?)', ['conv2', 'c2']);
    await run(`INSERT INTO tasks
      (id, conversation_id, title, status, priority, due_date, assigned_user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['t1', 'conv1', 'Tarefa um', 'open', 'normal', '2026-07-31T00:00:00.000Z', 'u1']);
    await run(`INSERT INTO tasks
      (id, conversation_id, title, status, priority, due_date, assigned_user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['t2', 'conv2', 'Tarefa dois', 'open', 'normal', '2026-07-31T00:00:00.000Z', 'u1']);

    const tasks = await repository.getLocalTasks();
    expect(tasks).toHaveLength(2);
    expect(tasks.find((item) => item.id === 't1')).toMatchObject({
      customerId: 'c1',
      customerName: 'Cybercentro',
    });
    expect(tasks.find((item) => item.id === 't2')).toMatchObject({
      customerId: 'c2',
      customerName: 'Dias de Aventura',
    });
  });

  it('devolve o cliente enriquecido depois de criar ou atualizar uma tarefa', async () => {
    await run('INSERT INTO customers (id, name, company, phone) VALUES (?, ?, ?, ?)',
      ['c1', 'Cliente SQLite', 'Empresa SQLite', '+351910000000']);
    await run('INSERT INTO conversations (id, customer_id) VALUES (?, ?)', ['conv1', 'c1']);

    const saved = await repository.upsertLocalTask({
      id: 't1',
      conversationId: 'conv1',
      title: 'Nova tarefa',
      status: 'open',
      priority: 'normal',
      dueDate: '2026-07-31T00:00:00.000Z',
      assignedUserId: 'u1',
    });

    expect(saved).toMatchObject({
      id: 't1',
      customerId: 'c1',
      customerName: 'Cliente SQLite',
      customerCompany: 'Empresa SQLite',
    });
  });
});
