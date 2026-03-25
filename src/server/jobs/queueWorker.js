function createQueueWorker(deps) {
    const {
        dbAllAsync,
        dbRunAsync,
        processQueueJob,
        isProviderReady,
        onError,
        pollIntervalMs = 4000,
    } = deps;

    let queueWorkerRunning = false;
    let queueWorkerBootstrapped = false;

    async function processOutboundQueue(limit = 5) {
        if (queueWorkerRunning) return;
        if (typeof isProviderReady === 'function' && !isProviderReady()) return;

        queueWorkerRunning = true;
        try {
            const jobs = await dbAllAsync(
                `SELECT id, conversation_id, to_number, message_kind, message_body, template_name,
                        account_id, variables_json, status, retry_count, next_attempt_at, created_by
                 FROM outbound_queue
                 WHERE status IN ('queued', 'retry')
                   AND datetime(next_attempt_at) <= datetime('now')
                 ORDER BY id ASC
                 LIMIT ?`,
                [limit]
            );

            for (const job of jobs) {
                await dbRunAsync(
                    `UPDATE outbound_queue
                     SET status = 'processing', updated_at = CURRENT_TIMESTAMP
                     WHERE id = ?`,
                    [job.id]
                );
                await processQueueJob(job);
            }
        } catch (error) {
            if (typeof onError === 'function') {
                onError(error);
            } else {
                // eslint-disable-next-line no-console
                console.error('[Queue] Erro no worker:', error?.message || error);
            }
        } finally {
            queueWorkerRunning = false;
        }
    }

    function bootstrapQueueWorker() {
        if (queueWorkerBootstrapped) return;
        queueWorkerBootstrapped = true;

        setInterval(() => {
            void processOutboundQueue();
        }, pollIntervalMs);
    }

    return {
        processOutboundQueue,
        bootstrapQueueWorker,
    };
}

module.exports = {
    createQueueWorker,
};
