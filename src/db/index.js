const sqlite3 = require('sqlite3').verbose();

function openDatabase(dbPath) {
    const db = new sqlite3.Database(dbPath, (err) => {
        if (err) {
            console.error('Erro ao abrir BD:', err.message);
        } else {
            console.log('Conectado ao banco SQLite.');
        }
    });
    db.serialize(() => {
        const walEnabled = String(process.env.SQLITE_WAL || '1').trim() !== '0';
        const rawBusyTimeout = Number(process.env.SQLITE_BUSY_TIMEOUT_MS || 5000);
        const busyTimeoutMs = Number.isFinite(rawBusyTimeout)
            ? Math.max(1000, Math.min(30000, Math.floor(rawBusyTimeout)))
            : 5000;
        const pragmas = [
            'PRAGMA foreign_keys=ON',
            `PRAGMA busy_timeout=${busyTimeoutMs}`,
        ];
        if (walEnabled) {
            pragmas.push('PRAGMA journal_mode=WAL');
            pragmas.push('PRAGMA synchronous=NORMAL');
        } else {
            pragmas.push('PRAGMA journal_mode=DELETE');
            pragmas.push('PRAGMA synchronous=FULL');
        }
        db.exec(`${pragmas.join('; ')};`, (pragmaError) => {
            if (pragmaError) {
                console.error('Erro ao aplicar PRAGMAs SQLite:', pragmaError.message || pragmaError);
            }
        });
    });
    return db;
}

function createDbHelpers(db) {
    function dbRunAsync(sql, params = []) {
        return new Promise((resolve, reject) => {
            db.run(sql, params, function onRun(err) {
                if (err) {
                    reject(err);
                    return;
                }
                resolve(this);
            });
        });
    }

    function dbGetAsync(sql, params = []) {
        return new Promise((resolve, reject) => {
            db.get(sql, params, (err, row) => {
                if (err) {
                    reject(err);
                    return;
                }
                resolve(row || null);
            });
        });
    }

    function dbAllAsync(sql, params = []) {
        return new Promise((resolve, reject) => {
            db.all(sql, params, (err, rows) => {
                if (err) {
                    reject(err);
                    return;
                }
                resolve(rows || []);
            });
        });
    }

    function dbExecAsync(sql) {
        return new Promise((resolve, reject) => {
            db.exec(sql, (err) => {
                if (err) {
                    reject(err);
                    return;
                }
                resolve();
            });
        });
    }

    return {
        dbRunAsync,
        dbGetAsync,
        dbAllAsync,
        dbExecAsync,
    };
}

module.exports = {
    openDatabase,
    createDbHelpers,
};
