function startServerLifecycle(context) {
    const {
        app,
        port,
        host = '127.0.0.1',
        dbReadyPromise,
        isBackofficeOnly,
        isChatCoreOnly,
        appRole,
        seedDefaultTemplates,
        bootstrapConversationsFromMessages,
        bootstrapQueueWorker,
        processOutboundQueue,
        bootstrapSaftWorker,
        processPendingSaftJobs,
        bootstrapObrigacoesAutoScheduler,
        bootstrapCustomersAutoPullScheduler,
    } = context;

    app.listen(port, host, async () => {
        if (dbReadyPromise && typeof dbReadyPromise.then === 'function') {
            const dbReady = await dbReadyPromise;
            if (!dbReady) {
                console.error('[DB] Arranque continuou sem schema pronto. Algumas rotas podem falhar.');
            }
        }
        void seedDefaultTemplates();
        if (!isBackofficeOnly) {
            void bootstrapConversationsFromMessages();
            bootstrapQueueWorker();
            void processOutboundQueue();
        }
        if (!isChatCoreOnly) {
            bootstrapSaftWorker(port);
            void processPendingSaftJobs(port, 5);
            bootstrapObrigacoesAutoScheduler(port);
            bootstrapCustomersAutoPullScheduler(port);
        }
        console.log(`Servidor rodando em ${host}:${port}`);
        console.log(`Iniciado em: ${new Date().toLocaleString()}`);
        console.log(`Perfil ativo: ${appRole || 'all'}`);
        console.log('Aguardando mensagens...');
    });
}

module.exports = {
    startServerLifecycle,
};
