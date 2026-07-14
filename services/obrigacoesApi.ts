export class ObrigacoesApi {
  constructor(
    private readonly browserAvailable: () => boolean,
    private readonly currentUserId: () => string,
  ) {}

  private isBrowser(): boolean {
    return this.browserAvailable();
  }

  async collectDriObrigacoes(options?: {
    obrigacaoType?: 'dri' | 'dmr' | 'goff_dmr' | 'goff_dri' | 'saft' | 'goff_saft' | 'iva' | 'goff_iva' | 'm22' | 'ies' | 'm10' | 'relatorio_unico' | 'goff_m22' | 'goff_ies' | 'goff_m10' | 'goff_inventario' | 'goff_relatorio_unico';
    year?: number;
    month?: number;
    monthOffset?: number;
    usePreviousMonth?: boolean;
    dryRun?: boolean;
    force?: boolean;
    requestedBy?: string | null;
  }): Promise<{
    success: boolean;
    dryRun?: boolean;
    period?: { tipo?: string; ano?: number; mes?: number | null; trimestre?: number | null };
    updatePeriod?: { tipo?: string; ano?: number; mes?: number | null; trimestre?: number | null };
    obrigacao?: { id?: number; nome?: string; periodicidade?: string };
    result?: {
      totalRows?: number;
      matchedCustomers?: number;
      missingCustomers?: number;
      skippedAlreadyCollected?: number;
      skippedInvalidStatus?: number;
      skippedTypeUnknown?: number;
      localSaved?: number;
      recolhasSyncOk?: number;
      periodosUpdateOk?: number;
      syncErrors?: number;
    };
    warnings?: string[];
    missingCustomers?: Array<{ empresa?: string | null; nif?: string | null }>;
    errors?: Array<{ customerId?: string; nif?: string; step?: string; error?: string }>;
    error?: string;
  }> {
    if (!this.isBrowser()) {
      return { success: false, error: 'Ação disponível apenas no browser.' };
    }

    const controller = new AbortController();
    const obrigacaoType =
      options?.obrigacaoType === 'dmr'
        ? 'dmr'
        : options?.obrigacaoType === 'goff_dmr'
          ? 'goff/dmr'
          : options?.obrigacaoType === 'goff_dri'
            ? 'goff/dri'
        : options?.obrigacaoType === 'saft'
          ? 'saft'
          : options?.obrigacaoType === 'goff_saft'
            ? 'goff/saft'
          : options?.obrigacaoType === 'iva'
            ? 'iva'
            : options?.obrigacaoType === 'goff_iva'
              ? 'goff/iva'
            : options?.obrigacaoType === 'goff_m22'
              ? 'goff/m22'
              : options?.obrigacaoType === 'goff_ies'
                ? 'goff/ies'
                : options?.obrigacaoType === 'goff_m10'
                  ? 'goff/m10'
                  : options?.obrigacaoType === 'goff_inventario'
                    ? 'goff/inventario'
                  : options?.obrigacaoType === 'goff_relatorio_unico'
                    ? 'goff/relatorio-unico'
            : options?.obrigacaoType === 'm22'
              ? 'm22'
              : options?.obrigacaoType === 'ies'
                ? 'ies'
                : options?.obrigacaoType === 'm10'
                  ? 'm10'
                  : options?.obrigacaoType === 'relatorio_unico'
                    ? 'relatorio-unico'
          : 'dri';
    const timeoutMs = obrigacaoType === 'iva' || obrigacaoType === 'goff/iva' ? 900000 : 240000;
    const isGoffSaft = obrigacaoType === 'goff/saft';
    const isGoffMonthly = obrigacaoType === 'goff/saft' || obrigacaoType === 'goff/dmr' || obrigacaoType === 'goff/dri';
    const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

    const normalizeWarnings = (raw: unknown): string[] =>
      Array.isArray(raw) ? raw.map((item) => String(item || '').trim()).filter(Boolean) : [];

    const normalizeMissingCustomers = (raw: unknown): Array<{ empresa?: string | null; nif?: string | null }> =>
      Array.isArray(raw) ? raw as Array<{ empresa?: string | null; nif?: string | null }> : [];

    const normalizeErrors = (
      raw: unknown,
    ): Array<{ customerId?: string; nif?: string; step?: string; error?: string }> =>
      Array.isArray(raw)
        ? raw as Array<{ customerId?: string; nif?: string; step?: string; error?: string }>
        : [];

    const mapPayloadResult = (
      payload: {
        success?: boolean;
        dryRun?: boolean;
        period?: { tipo?: string; ano?: number; mes?: number | null; trimestre?: number | null };
        updatePeriod?: { tipo?: string; ano?: number; mes?: number | null; trimestre?: number | null };
        obrigacao?: { id?: number; nome?: string; periodicidade?: string };
        result?: {
          totalRows?: number;
          matchedCustomers?: number;
          missingCustomers?: number;
          skippedTypeUnknown?: number;
          localSaved?: number;
          recolhasSyncOk?: number;
          periodosUpdateOk?: number;
          syncErrors?: number;
        };
        warnings?: unknown;
        missingCustomers?: unknown;
        errors?: unknown;
        error?: unknown;
      },
      statusCode: number,
      forceError?: string,
    ) => {
      const warnings = normalizeWarnings(payload.warnings);
      const missingCustomers = normalizeMissingCustomers(payload.missingCustomers);
      const errors = normalizeErrors(payload.errors);

      if (forceError || !payload.success) {
        const errorText =
          forceError ||
          (typeof payload.error === 'string'
            ? payload.error
            : payload.error
              ? JSON.stringify(payload.error)
              : `Falha na recolha ${obrigacaoType.toUpperCase()} (${statusCode}).`);
        return {
          success: false as const,
          dryRun: payload.dryRun,
          period: payload.period,
          updatePeriod: payload.updatePeriod,
          obrigacao: payload.obrigacao,
          result: payload.result,
          warnings,
          missingCustomers,
          errors,
          error: errorText,
        };
      }

      return {
        success: true as const,
        dryRun: payload.dryRun,
        period: payload.period,
        updatePeriod: payload.updatePeriod,
        obrigacao: payload.obrigacao,
        result: payload.result,
        warnings,
        missingCustomers,
        errors,
      };
    };

    try {
      const response = await fetch(`/api/import/obrigacoes/${obrigacaoType}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          year: isGoffMonthly ? undefined : options?.year,
          month: isGoffMonthly ? undefined : options?.month,
          monthOffset: isGoffMonthly ? undefined : options?.monthOffset,
          usePreviousMonth: isGoffMonthly ? undefined : options?.usePreviousMonth,
          dryRun: options?.dryRun,
          force: isGoffMonthly ? undefined : options?.force,
          async: obrigacaoType === 'iva',
          requestedBy: options?.requestedBy ?? this.currentUserId() ?? null,
        }),
        signal: controller.signal,
      });

      const payload = await response.json().catch(() => ({})) as {
        success?: boolean;
        dryRun?: boolean;
        period?: { tipo?: string; ano?: number; mes?: number | null; trimestre?: number | null };
        updatePeriod?: { tipo?: string; ano?: number; mes?: number | null; trimestre?: number | null };
        obrigacao?: { id?: number; nome?: string; periodicidade?: string };
        result?: {
          totalRows?: number;
          matchedCustomers?: number;
          missingCustomers?: number;
          skippedTypeUnknown?: number;
          localSaved?: number;
          recolhasSyncOk?: number;
          periodosUpdateOk?: number;
          syncErrors?: number;
        };
        warnings?: unknown;
        missingCustomers?: unknown;
        errors?: unknown;
        error?: unknown;
        async?: boolean;
        jobId?: string;
      };
      if (
        obrigacaoType === 'iva' &&
        response.status === 202 &&
        payload.success &&
        payload.async === true &&
        typeof payload.jobId === 'string' &&
        payload.jobId.trim()
      ) {
        const jobId = payload.jobId.trim();
        while (true) {
          await new Promise((resolve) => window.setTimeout(resolve, 2000));

          const jobResponse = await fetch(`/api/import/obrigacoes/iva/jobs/${encodeURIComponent(jobId)}`, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
          });
          const jobPayload = await jobResponse.json().catch(() => ({})) as {
            success?: boolean;
            job?: {
              status?: string;
              result?: {
                success?: boolean;
                dryRun?: boolean;
                period?: { tipo?: string; ano?: number; mes?: number | null; trimestre?: number | null };
                updatePeriod?: { tipo?: string; ano?: number; mes?: number | null; trimestre?: number | null };
                obrigacao?: { id?: number; nome?: string; periodicidade?: string };
                result?: {
                  totalRows?: number;
                  matchedCustomers?: number;
                  missingCustomers?: number;
                  localSaved?: number;
                  recolhasSyncOk?: number;
                  periodosUpdateOk?: number;
                  syncErrors?: number;
                };
                warnings?: unknown;
                missingCustomers?: unknown;
                errors?: unknown;
                error?: unknown;
              };
              error?: unknown;
            };
            error?: unknown;
          };

          if (!jobResponse.ok || !jobPayload.success || !jobPayload.job) {
            const endpointError =
              typeof jobPayload.error === 'string'
                ? jobPayload.error
                : `Falha ao consultar estado da recolha IVA (${jobResponse.status}).`;
            return mapPayloadResult({}, jobResponse.status, endpointError);
          }

          const jobStatus = String(jobPayload.job.status || '').trim().toLowerCase();
          if (jobStatus === 'queued' || jobStatus === 'running') {
            continue;
          }

          const jobResult = jobPayload.job.result || {};
          if (jobStatus === 'completed') {
            return mapPayloadResult(jobResult, 200);
          }

          const jobError =
            typeof jobPayload.job.error === 'string'
              ? jobPayload.job.error
              : 'Falha no processamento da recolha IVA.';
          return mapPayloadResult(jobResult, 500, jobError);
        }
      }

      return mapPayloadResult(payload, response.status);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return {
          success: false,
          error: `Recolha ${obrigacaoType.toUpperCase()} demorou demasiado tempo (${Math.round(timeoutMs / 1000)}s).`,
        };
      }
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : `Falha de rede na recolha ${obrigacaoType.toUpperCase()}.`,
      };
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  async getObrigacoesAutoStatus(): Promise<{
    success: boolean;
    scheduler?: { enabled?: boolean; hour?: number; minute?: number; timezone?: string | null };
    state?: {
      enabled?: boolean;
      running?: boolean;
      lastRunAt?: string | null;
      lastFinishedAt?: string | null;
      nextRunAt?: string | null;
      lastError?: string | null;
      lastSummary?: {
        startedAt?: string;
        finishedAt?: string;
        ok?: number;
        failed?: number;
        jobs?: Array<{
          route?: string;
          success?: boolean;
          statusCode?: number | null;
          startedAt?: string;
          finishedAt?: string;
          error?: string | null;
        }>;
      } | null;
    };
    error?: string;
  }> {
    if (!this.isBrowser()) {
      return { success: false, error: 'Ação disponível apenas no browser.' };
    }

    try {
      const response = await fetch('/api/import/obrigacoes/auto/status', {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      });
      const payload = await response.json().catch(() => ({})) as {
        success?: boolean;
        scheduler?: { enabled?: boolean; hour?: number; minute?: number; timezone?: string | null };
        state?: {
          enabled?: boolean;
          running?: boolean;
          lastRunAt?: string | null;
          lastFinishedAt?: string | null;
          nextRunAt?: string | null;
          lastError?: string | null;
          lastSummary?: {
            startedAt?: string;
            finishedAt?: string;
            ok?: number;
            failed?: number;
            jobs?: Array<{
              route?: string;
              success?: boolean;
              statusCode?: number | null;
              startedAt?: string;
              finishedAt?: string;
              error?: string | null;
            }>;
          } | null;
        };
        error?: unknown;
      };

      if (!response.ok || !payload.success) {
        const errorText =
          typeof payload.error === 'string'
            ? payload.error
            : payload.error
              ? JSON.stringify(payload.error)
              : `Falha ao carregar estado do scheduler (${response.status}).`;
        return { success: false, error: errorText };
      }

      return {
        success: true,
        scheduler: payload.scheduler,
        state: payload.state,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Falha de rede ao carregar scheduler automático.',
      };
    }
  }

  async runObrigacoesAutoNow(): Promise<{
    success: boolean;
    summary?: {
      startedAt?: string;
      finishedAt?: string;
      ok?: number;
      failed?: number;
      jobs?: Array<{
        route?: string;
        success?: boolean;
        statusCode?: number | null;
        startedAt?: string;
        finishedAt?: string;
        error?: string | null;
      }>;
    };
    state?: {
      running?: boolean;
      lastRunAt?: string | null;
      lastFinishedAt?: string | null;
      nextRunAt?: string | null;
      lastError?: string | null;
    };
    error?: string;
  }> {
    if (!this.isBrowser()) {
      return { success: false, error: 'Ação disponível apenas no browser.' };
    }

    try {
      const response = await fetch('/api/import/obrigacoes/auto/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const payload = await response.json().catch(() => ({})) as {
        success?: boolean;
        summary?: {
          startedAt?: string;
          finishedAt?: string;
          ok?: number;
          failed?: number;
          jobs?: Array<{
            route?: string;
            success?: boolean;
            statusCode?: number | null;
            startedAt?: string;
            finishedAt?: string;
            error?: string | null;
          }>;
        };
        state?: {
          running?: boolean;
          lastRunAt?: string | null;
          lastFinishedAt?: string | null;
          nextRunAt?: string | null;
          lastError?: string | null;
        };
        error?: unknown;
      };

      if (!response.ok || !payload.success) {
        const errorText =
          typeof payload.error === 'string'
            ? payload.error
            : payload.error
              ? JSON.stringify(payload.error)
              : `Falha na execução manual (${response.status}).`;
        return { success: false, error: errorText, state: payload.state };
      }

      return {
        success: true,
        summary: payload.summary,
        state: payload.state,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Falha de rede ao executar recolha automática.',
      };
    }
  }

}
