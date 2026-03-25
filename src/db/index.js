const sqlite3 = require('sqlite3').verbose();

function openDatabase(dbPath) {
    const db = new sqlite3.Database(dbPath, (err) => {
        if (err) {
            console.error('Erro ao abrir BD:', err.message);
        } else {
            console.log('Conectado ao banco SQLite.');
        }
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
