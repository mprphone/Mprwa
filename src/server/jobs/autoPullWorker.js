function createAutoPullWorker(deps) {
    const {
        axios,
        nowIso,
        writeAuditLog,
        supabaseUrl,
        supabaseKey,
        supabaseClientsSource,
        enabled,
        intervalMinutes,
        startupDelaySeconds,
    } = deps;

    let customersAutoPullRunning = false;
    let customersAutoPullBootstrapped = false;
    let customersAutoPullTimer = null;
    const customersAutoPullState = {
        enabled,
        intervalMinutes,
        startupDelaySeconds,
        running: false,
        lastRunAt: null,
        lastFinishedAt: null,
        nextRunAt: null,
        lastSummary: null,
        lastError: null,
    };

    async function runCustomersAutoPull(localPort, options = {}) {
        if (customersAutoPullRunning) return null;
        if (!supabaseUrl || !supabaseKey || !supabaseClientsSource) {
            customersAutoPullState.lastError = 'Supabase clientes não configurado.';
            return null;
        }

        const full = !!options.full;
        const limit = Number(options.limit || 5000);

        customersAutoPullRunning = true;
        customersAutoPullState.running = true;
        customersAutoPullState.lastRunAt = nowIso();
        customersAutoPullState.lastError = null;

        try {
            const response = await axios({
                method: 'POST',
                url: `http://127.0.0.1:${localPort}/api/customers/sync/pull`,
                headers: { 'Content-Type': 'application/json' },
                data: { full, limit },
                timeout: 5 * 60 * 1000,
                validateStatus: () => true,
            });
            const payload = response?.data || {};
            const success = response.status >= 200 && response.status < 300 && payload?.success === true;

            const summary = {
                startedAt: customersAutoPullState.lastRunAt,
                finishedAt: nowIso(),
                statusCode: response.status,
                success,
                full,
                limit,
                result: payload,
                error: success ? null : (payload?.error || `HTTP ${response.status}`),
            };

            customersAutoPullState.lastSummary = summary;
            if (!success) {
                customersAutoPullState.lastError = String(summary.error || 'Falha na sincronização automática de clientes.');
                return summary;
            }

            await writeAuditLog({
                actorUserId: null,
                entityType: 'customers_auto_sync',
                entityId: summary.startedAt,
                action: 'completed',
                details: summary,
            });
            return summary;
        } catch (error) {
            const details = String(error?.message || error);
            customersAutoPullState.lastError = details;
            const summary = {
                startedAt: customersAutoPullState.lastRunAt,
                finishedAt: nowIso(),
                statusCode: null,
                success: false,
                full,
                limit,
                result: null,
                error: details,
            };
            customersAutoPullState.lastSummary = summary;
            await writeAuditLog({
                actorUserId: null,
                entityType: 'customers_auto_sync',
                entityId: summary.startedAt,
                action: 'failed',
                details: summary,
            });
            return summary;
        } finally {
            customersAutoPullRunning = false;
            customersAutoPullState.running = false;
            customersAutoPullState.lastFinishedAt = nowIso();
        }
    }

    function scheduleNextCustomersAutoPull(localPort, delayMs = null) {
        if (!enabled) return;
        if (customersAutoPullTimer) {
            clearTimeout(customersAutoPullTimer);
            customersAutoPullTimer = null;
        }

        const intervalMs = Math.max(60 * 1000, Number(intervalMinutes || 15) * 60 * 1000);
        const hasCustomDelay = delayMs !== null && delayMs !== undefined && String(delayMs).trim() !== '';
        const waitMs = hasCustomDelay && Number.isFinite(Number(delayMs))
            ? Math.max(1000, Number(delayMs))
            : intervalMs;
        const nextRun = new Date(Date.now() + waitMs);
        customersAutoPullState.nextRunAt = nextRun.toISOString();

        console.log(
            `[Auto Clientes] Próxima sincronização incremental em ${Math.round(waitMs / 1000)}s (${nextRun.toISOString()})`
        );

        customersAutoPullTimer = setTimeout(async () => {
            try {
                const summary = await runCustomersAutoPull(localPort, { full: false, limit: 5000 });
                if (summary?.success) {
                    const synced = Number(summary?.result?.synced || 0);
                    const fetched = Number(summary?.result?.fetched || 0);
                    console.log(`[Auto Clientes] Concluído. Sincronizados=${synced} | Lidos=${fetched}`);
                } else if (summary) {
                    console.warn(`[Auto Clientes] Falha: ${summary.error || 'erro desconhecido'}`);
                }
            } catch (error) {
                customersAutoPullState.lastError = String(error?.message || error);
                console.error('[Auto Clientes] Falha no agendamento:', error?.message || error);
            } finally {
                scheduleNextCustomersAutoPull(localPort);
            }
        }, waitMs);
    }

    function bootstrapCustomersAutoPullScheduler(localPort) {
        if (customersAutoPullBootstrapped) return;
        customersAutoPullBootstrapped = true;

        if (!enabled) {
            console.log('[Auto Clientes] Scheduler desativado (CUSTOMERS_AUTO_PULL_ENABLED=false).');
            return;
        }
        if (!supabaseUrl || !supabaseKey || !supabaseClientsSource) {
            console.log('[Auto Clientes] Scheduler não iniciado: Supabase clientes não configurado.');
            return;
        }

        const startupDelayMs = Math.max(0, Number(startupDelaySeconds || 20) * 1000);
        scheduleNextCustomersAutoPull(localPort, startupDelayMs);
    }

    function isCustomersAutoPullRunning() {
        return customersAutoPullRunning;
    }

    return {
        runCustomersAutoPull,
        bootstrapCustomersAutoPullScheduler,
        isCustomersAutoPullRunning,
        customersAutoPullState,
    };
}

module.exports = {
    createAutoPullWorker,
};
