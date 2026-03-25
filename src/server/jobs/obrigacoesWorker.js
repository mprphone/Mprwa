function createObrigacoesWorker(deps) {
    const {
        axios,
        dbAllAsync,
        nowIso,
        writeAuditLog,
        resolveShiftedYearMonth,
        computeNextDailyRunAt,
        OBRIGACOES_AUTO_ENABLED,
        OBRIGACOES_AUTO_HOUR,
        OBRIGACOES_AUTO_MINUTE,
        OBRIGACOES_AUTO_TIMEZONE,
    } = deps;

    // --- SAFT pending jobs worker ---

    let saftWorkerRunning = false;
    let saftWorkerBootstrapped = false;

    async function processPendingSaftJobs(localPort, limit = 3) {
        if (saftWorkerRunning) return;
        if (!localPort) return;

        saftWorkerRunning = true;
        try {
            const jobs = await dbAllAsync(
                `SELECT id, customer_id, conversation_id, document_type, requested_by
                 FROM saft_jobs
                 WHERE status = 'pending'
                   AND datetime(updated_at) <= datetime('now', '-2 minutes')
                 ORDER BY id ASC
                 LIMIT ?`,
                [limit]
            );
            for (const job of jobs) {
                try {
                    await axios({
                        method: 'POST',
                        url: `http://127.0.0.1:${localPort}/api/saft/fetch-and-send`,
                        headers: { 'Content-Type': 'application/json' },
                        data: {
                            customerId: String(job.customer_id || '').trim(),
                            conversationId: String(job.conversation_id || '').trim(),
                            documentType: String(job.document_type || '').trim(),
                            requestedBy: String(job.requested_by || '').trim() || null,
                            jobId: Number(job.id || 0),
                        },
                        timeout: 45000,
                        validateStatus: () => true,
                    });
                } catch (error) {
                    console.error('[SAFT Worker] Erro ao reprocessar job pendente:', error?.message || error);
                }
            }
        } catch (error) {
            console.error('[SAFT Worker] Falha no ciclo:', error?.message || error);
        } finally {
            saftWorkerRunning = false;
        }
    }

    function bootstrapSaftWorker(localPort) {
        if (saftWorkerBootstrapped) return;
        saftWorkerBootstrapped = true;
        setInterval(() => {
            void processPendingSaftJobs(localPort);
        }, 30000);
    }

    // --- Obrigacoes auto scheduler ---

    let obrigacoesAutoRunning = false;
    let obrigacoesAutoBootstrapped = false;
    let obrigacoesAutoTimer = null;
    const obrigacoesAutoState = {
        enabled: OBRIGACOES_AUTO_ENABLED,
        hour: OBRIGACOES_AUTO_HOUR,
        minute: OBRIGACOES_AUTO_MINUTE,
        timezone: OBRIGACOES_AUTO_TIMEZONE || null,
        running: false,
        lastRunAt: null,
        lastFinishedAt: null,
        nextRunAt: null,
        lastSummary: null,
        lastError: null,
    };

    async function runObrigacoesAutoCollection(localPort) {
        if (obrigacoesAutoRunning) return null;
        obrigacoesAutoRunning = true;
        obrigacoesAutoState.running = true;
        obrigacoesAutoState.lastRunAt = nowIso();
        obrigacoesAutoState.lastError = null;

        const runStartedAt = new Date();
        const previousMonth = resolveShiftedYearMonth(runStartedAt, 1);
        const ivaMonth = resolveShiftedYearMonth(runStartedAt, 2);
        const annualYear = runStartedAt.getFullYear() - 1;
        const monthlyPayload = {
            dryRun: false,
            force: false,
        };
        const annualPayload = {
            year: annualYear,
            dryRun: false,
            force: false,
        };

        const jobs = [
            { route: 'dri', payload: { ...monthlyPayload, year: previousMonth.year, month: previousMonth.month }, timeoutMs: 8 * 60 * 1000 },
            { route: 'dmr', payload: { ...monthlyPayload, year: previousMonth.year, month: previousMonth.month }, timeoutMs: 8 * 60 * 1000 },
            { route: 'saft', payload: { ...monthlyPayload, year: previousMonth.year, month: previousMonth.month }, timeoutMs: 8 * 60 * 1000 },
            { route: 'iva', payload: { ...monthlyPayload, year: ivaMonth.year, month: ivaMonth.month, async: false }, timeoutMs: 25 * 60 * 1000 },
            { route: 'm22', payload: annualPayload, timeoutMs: 12 * 60 * 1000 },
            { route: 'ies', payload: annualPayload, timeoutMs: 12 * 60 * 1000 },
            { route: 'm10', payload: annualPayload, timeoutMs: 12 * 60 * 1000 },
            { route: 'relatorio-unico', payload: annualPayload, timeoutMs: 12 * 60 * 1000 },
        ];

        const summary = {
            startedAt: nowIso(),
            rules: {
                monthlyYear: previousMonth.year,
                monthlyMonth: previousMonth.month,
                ivaYear: ivaMonth.year,
                ivaMonth: ivaMonth.month,
                annualYear,
            },
            jobs: [],
            ok: 0,
            failed: 0,
        };

        try {
            for (const job of jobs) {
                const startedAt = nowIso();
                try {
                    const response = await axios({
                        method: 'POST',
                        url: `http://127.0.0.1:${localPort}/api/import/obrigacoes/${job.route}`,
                        headers: { 'Content-Type': 'application/json' },
                        data: job.payload,
                        timeout: job.timeoutMs,
                        validateStatus: () => true,
                    });
                    const payload = response?.data || {};
                    const success = response.status >= 200 && response.status < 300 && payload?.success === true;
                    if (success) {
                        summary.ok += 1;
                    } else {
                        summary.failed += 1;
                    }
                    summary.jobs.push({
                        route: job.route,
                        payload: job.payload,
                        statusCode: response.status,
                        success,
                        startedAt,
                        finishedAt: nowIso(),
                        result: payload?.result || null,
                        error: success ? null : payload?.error || `HTTP ${response.status}`,
                    });
                } catch (error) {
                    summary.failed += 1;
                    summary.jobs.push({
                        route: job.route,
                        payload: job.payload,
                        statusCode: null,
                        success: false,
                        startedAt,
                        finishedAt: nowIso(),
                        result: null,
                        error: String(error?.message || error),
                    });
                }
            }
            summary.finishedAt = nowIso();
            await writeAuditLog({
                actorUserId: null,
                entityType: 'obrigacoes_auto_scheduler',
                entityId: summary.startedAt,
                action: summary.failed > 0 ? 'completed_with_errors' : 'completed',
                details: summary,
            });
            return summary;
        } catch (error) {
            const details = String(error?.message || error);
            obrigacoesAutoState.lastError = details;
            await writeAuditLog({
                actorUserId: null,
                entityType: 'obrigacoes_auto_scheduler',
                entityId: nowIso(),
                action: 'failed',
                details: { error: details, partialSummary: summary },
            });
            return {
                ...summary,
                finishedAt: nowIso(),
                failed: summary.failed + 1,
                fatalError: details,
            };
        } finally {
            obrigacoesAutoRunning = false;
            obrigacoesAutoState.running = false;
            obrigacoesAutoState.lastFinishedAt = nowIso();
        }
    }

    function scheduleNextObrigacoesAutoRun(localPort) {
        if (!OBRIGACOES_AUTO_ENABLED) return;
        if (obrigacoesAutoTimer) {
            clearTimeout(obrigacoesAutoTimer);
            obrigacoesAutoTimer = null;
        }

        const nextRunAt = computeNextDailyRunAt(OBRIGACOES_AUTO_HOUR, OBRIGACOES_AUTO_MINUTE, OBRIGACOES_AUTO_TIMEZONE || undefined);
        obrigacoesAutoState.nextRunAt = nextRunAt.toISOString();
        const delayMs = Math.max(1000, nextRunAt.getTime() - Date.now());

        console.log(
            `[Auto Obrigações] Próxima recolha agendada para ${nextRunAt.toISOString()}${
                OBRIGACOES_AUTO_TIMEZONE ? ` (${OBRIGACOES_AUTO_TIMEZONE})` : ''
            }`
        );

        obrigacoesAutoTimer = setTimeout(async () => {
            try {
                const summary = await runObrigacoesAutoCollection(localPort);
                obrigacoesAutoState.lastSummary = summary;
                if (summary?.failed > 0) {
                    console.warn(`[Auto Obrigações] Concluído com falhas. OK=${summary.ok} Falhas=${summary.failed}`);
                } else {
                    console.log(`[Auto Obrigações] Concluído com sucesso. Jobs OK=${summary?.ok || 0}`);
                }
            } catch (error) {
                const details = String(error?.message || error);
                obrigacoesAutoState.lastError = details;
                console.error('[Auto Obrigações] Falha no agendamento:', details);
            } finally {
                scheduleNextObrigacoesAutoRun(localPort);
            }
        }, delayMs);
    }

    function bootstrapObrigacoesAutoScheduler(localPort) {
        if (obrigacoesAutoBootstrapped) return;
        obrigacoesAutoBootstrapped = true;

        if (!OBRIGACOES_AUTO_ENABLED) {
            console.log('[Auto Obrigações] Scheduler desativado (OBRIGACOES_AUTO_ENABLED=false).');
            return;
        }
        scheduleNextObrigacoesAutoRun(localPort);
    }

    return {
        obrigacoesAutoState,
        processPendingSaftJobs,
        bootstrapSaftWorker,
        runObrigacoesAutoCollection,
        scheduleNextObrigacoesAutoRun,
        bootstrapObrigacoesAutoScheduler,
    };
}

module.exports = { createObrigacoesWorker };
