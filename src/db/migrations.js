const fs = require('fs');
const path = require('path');

async function ensureMigrationsTable(dbRunAsync) {
    await dbRunAsync(`CREATE TABLE IF NOT EXISTS migrations (
        id TEXT PRIMARY KEY,
        applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
}

function listMigrationFiles(dirPath) {
    return fs
        .readdirSync(dirPath)
        .filter((file) => file.toLowerCase().endsWith('.sql'))
        .sort();
}

async function runSqlFile(dbExecAsync, filePath) {
    const sql = fs.readFileSync(filePath, 'utf8');
    if (!sql.trim()) return;
    await dbExecAsync(sql);
}

async function runMigrations({ dbRunAsync, dbAllAsync, dbExecAsync, migrationsDir }) {
    await ensureMigrationsTable(dbRunAsync);

    const appliedRows = await dbAllAsync('SELECT id FROM migrations');
    const appliedSet = new Set(appliedRows.map((row) => String(row.id || '').trim()).filter(Boolean));

    const files = listMigrationFiles(migrationsDir);
    for (const fileName of files) {
        if (appliedSet.has(fileName)) continue;

        const filePath = path.join(migrationsDir, fileName);
        await runSqlFile(dbExecAsync, filePath);
        await dbRunAsync('INSERT INTO migrations (id) VALUES (?)', [fileName]);
        console.log(`[DB] Migração aplicada: ${fileName}`);
    }
}

module.exports = {
    runMigrations,
};
