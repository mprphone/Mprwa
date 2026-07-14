function registerFrontendRoutes(context) {
    const {
        app,
        express,
        path,
        baseDir,
    } = context;

    app.use(
        express.static(path.join(baseDir, 'dist'), {
            setHeaders: (res) => {
                res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
                res.setHeader('Pragma', 'no-cache');
                res.setHeader('Expires', '0');
            },
        })
    );

    // A interface usa HashRouter, portanto as rotas do cliente ficam depois de
    // "#" e nunca chegam ao servidor. Limitar o fallback evita devolver 200 e
    // o index.html para sondagens como /.env ou /etc/passwd.
    app.get(['/', '/index.html'], (req, res) => {
        const indexPath = path.join(baseDir, 'dist', 'index.html');
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.sendFile(indexPath, (err) => {
            if (err) {
                res.status(500).send("Erro: O build não foi encontrado. Execute 'npm run build' no terminal.");
            }
        });
    });
}

module.exports = {
    registerFrontendRoutes,
};
