function registerFrontendRoutes(context) {
    const {
        app,
        express,
        path,
        baseDir,
    } = context;

    app.use(
        express.static(path.join(baseDir, 'dist'), {
            setHeaders: (res, filePath) => {
                if (filePath.endsWith('.html')) {
                    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
                    res.setHeader('Pragma', 'no-cache');
                    res.setHeader('Expires', '0');
                }
            },
        })
    );

    app.get('*', (req, res) => {
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
