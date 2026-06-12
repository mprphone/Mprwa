'use strict';

/**
 * Routes para ESCREVER dados da Segurança Social no SAFTonline.
 * POST /api/customers/:id/saftonline/write-ss
 *
 * Fluxo:
 *  1. Ler credenciais SS do cliente local (subutilizador + token + validade)
 *  2. Login no SAFTonline via Playwright
 *  3. Localizar a empresa por NIF
 *  4. Navegar para a página de edição
 *  5. Preencher Utilizador SS, Senha SS, Validade e Token WebService SS
 *  6. Guardar
 */

const { decryptCustomerSecret } = require('../../src/server/utils/crypto');

const SAFT_LOGIN_URL = process.env.SAFT_LOGIN_URL ||
    'https://app.saftonline.pt/conta/inss?ReturnUrl=%2Fdossier%2Fdossier';
const SAFT_EMPRESAS_URL = process.env.SAFT_EMPRESAS_URL ||
    'https://app.saftonline.pt/Empresas/Index';
const SAFT_EMAIL    = process.env.Email_saft    || process.env.SAFT_EMAIL    || '';
const SAFT_PASSWORD = process.env.Senha_saft    || process.env.SAFT_PASSWORD || '';

// Mapeamento SAFTonline field IDs → WA PRO service/credentialType
const SAFT_CREDENTIAL_MAP = [
    { usernameId: 'Empresa_API_UsernameAT',       passwordId: 'Empresa_API_PasswordAT',       service: 'AT',                    credentialType: 'principal'  },
    { usernameId: 'Empresa_API_UsernameVIACTT',   passwordId: 'Empresa_API_PasswordVIACTT',   service: 'ViaCTT',                credentialType: ''  },
    { usernameId: 'Empresa_API_UsernameIAPMEI',   passwordId: 'Empresa_API_PasswordIAPMEI',   service: 'IAPMEI',                credentialType: ''  },
    { usernameId: 'Empresa_API_UsernameRU',       passwordId: 'Empresa_API_PasswordRU',       service: 'RU',                    credentialType: ''  },
    { usernameId: 'Empresa_API_UsernameIEFP',     passwordId: 'Empresa_API_PasswordIEFP',     service: 'IEFP',                  credentialType: ''  },
    { usernameId: 'Empresa_API_UsernameB2020',    passwordId: 'Empresa_API_PasswordB2020',    service: 'Balcão 2020',           credentialType: ''  },
    { usernameId: 'Empresa_API_UsernameINE',      passwordId: 'Empresa_API_PasswordINE',      service: 'INE',                   credentialType: ''  },
    { usernameId: 'Empresa_API_UsernameSILIAMB',  passwordId: 'Empresa_API_PasswordSILIAMB',  service: 'SILIAMB',               credentialType: ''  },
    { usernameId: 'Empresa_API_UsernameLivroRec', passwordId: 'Empresa_API_PasswordLivroRec', service: 'Livro de Reclamações',   credentialType: ''  },
    { usernameId: 'Empresa_API_UsernameACT',      passwordId: 'Empresa_API_PasswordACT',      service: 'ACT',                   credentialType: ''  },
];

function registerSaftonlineWriteRoutes(context) {
    const { app, dbGetAsync, dbAllAsync, dbRunAsync } = context;
    const { encryptCustomerSecret } = require('../../src/server/utils/crypto');

    // ── POST /api/customers/:id/saftonline/write-ss ──────────────────────────
    app.post('/api/customers/:id/saftonline/write-ss', async (req, res) => {
        const customerId = String(req.params.id || '').trim();
        if (!customerId) return res.status(400).json({ success: false, error: 'ID inválido.' });

        if (!SAFT_EMAIL || !SAFT_PASSWORD) {
            return res.status(503).json({
                success: false,
                error: 'Credenciais SAFTonline não configuradas (Email_saft / Senha_saft).',
            });
        }

        let playwright;
        try { playwright = require('playwright'); } catch (_) {
            return res.status(503).json({ success: false, error: 'Playwright não instalado.' });
        }

        try {
            // 1. Obter cliente local
            const customer = await dbGetAsync(
                'SELECT id, nif, name, company, access_credentials_json FROM customers WHERE id = ? LIMIT 1',
                [customerId]
            );
            if (!customer) return res.status(404).json({ success: false, error: 'Cliente não encontrado.' });

            const nif = String(customer.nif || '').trim();
            if (!nif) return res.status(400).json({ success: false, error: 'Cliente sem NIF.' });

            // 2. Extrair credenciais SS do access_credentials_json
            let creds = [];
            try { creds = JSON.parse(customer.access_credentials_json || '[]'); } catch (_) {}

            const findCred = (svc, tipo) => creds.find(
                c => (c.service || '').toLowerCase().includes(svc) && (c.credentialType || '') === tipo
            );

            const subCred      = findCred('segurança', 'subutilizador') || findCred('ss', 'subutilizador');
            const chaveCred    = findCred('segurança', 'chave_aplicacional'); // → Senha de acesso SS
            const tokenCred    = findCred('segurança', 'token');               // → Token WebService SS

            if (!subCred) {
                return res.status(400).json({
                    success: false,
                    error: 'Subutilizador SS não encontrado. Execute "Ativar conta/token" primeiro.',
                });
            }

            // Mapeação correcta (confirmada pela equipa SAFTonline):
            // Utilizador SS     = subutilizador username
            // Senha de acesso SS = chave_aplicacional password
            // Token WebService SS = token (JWT Plataforma Interoperabilidade)
            const ssUser     = String(subCred.username || '').trim();
            const ssPassRaw  = decryptCustomerSecret(String(chaveCred?.password || '').trim());
            const ssValidade = String(chaveCred?.validUntil || '').trim();
            const tokenWS    = decryptCustomerSecret(String(tokenCred?.password || '').trim());
            const tokenWSVal = String(tokenCred?.validUntil || '').trim();

            if (!ssUser) return res.status(400).json({ success: false, error: 'Username subutilizador SS vazio.' });

            console.log(`[SAFTonline Write SS] NIF=${nif} | subUser=${ssUser} | temToken=${!!ssPassRaw} | temWS=${!!tokenWS}`);

            // 3. Playwright — login + navegar para edit
            const browser = await playwright.chromium.launch({
                headless: true,
                args: ['--no-sandbox', '--disable-dev-shm-usage'],
            });

            try {
                const context2 = await browser.newContext({
                    viewport: { width: 1400, height: 900 },
                    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                });
                const page = await context2.newPage();
                page.setDefaultTimeout(30000);

                // Função helper — tenta múltiplos seletores
                async function firstVisible(selectors) {
                    for (const sel of selectors) {
                        try {
                            const loc = page.locator(sel).first();
                            if ((await loc.count()) > 0) return sel;
                        } catch (_) {}
                    }
                    return '';
                }

                // Login — suporta fluxo multi-step do SAFTonline
                await page.goto(SAFT_LOGIN_URL, { waitUntil: 'domcontentloaded' });
                await page.waitForTimeout(1000);

                const emailSel = await firstVisible(['#Email', 'input[name="Email"]', 'input[type="email"]']);
                const passSel  = await firstVisible(['#Password', 'input[name="Password"]', 'input[type="password"]']);
                const subSel   = await firstVisible(['button[type="submit"]', 'input[type="submit"]', 'button:has-text("Entrar")']);

                if (!emailSel || !passSel || !subSel) {
                    throw new Error(`Seletores de login não encontrados na página: ${page.url()}`);
                }

                await page.fill(emailSel, SAFT_EMAIL);
                await page.fill(passSel, SAFT_PASSWORD);
                await Promise.allSettled([
                    page.waitForLoadState('networkidle').catch(() => {}),
                    page.locator(subSel).first().click(),
                ]);
                await page.waitForTimeout(2000);

                // Encontrar empresa SEMPRE por NIF — lê coluna NIF da tabela
                const findByNif = async () => page.evaluate((targetNif) => {
                    const fold = (v) => String(v||'').normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase().trim();
                    const tables = Array.from(document.querySelectorAll('table'));
                    let tbl = null;
                    for (const t of tables) {
                        const ths = Array.from(t.querySelectorAll('thead th')).map(th => fold(th.textContent));
                        if (ths.join('|').includes('nif') && ths.join('|').includes('empresa')) { tbl = t; break; }
                    }
                    if (!tbl) return null;
                    const headers = Array.from(tbl.querySelectorAll('thead th')).map(th => fold(th.textContent));
                    const nifIdx = headers.findIndex(h => h.includes('nif'));
                    for (const row of tbl.querySelectorAll('tbody tr')) {
                        const cells = Array.from(row.querySelectorAll('td'));
                        const cellNif = (cells[nifIdx]?.textContent||'').replace(/\D/g,'').trim();
                        if (cellNif === targetNif) {
                            const link = row.querySelector('a[href*="/empresas/Details/"], a[href*="/Empresas/Details/"]');
                            if (link) return new URL(link.getAttribute('href').replace(/\/Details\//gi, '/Edit/'), window.location.href).toString();
                        }
                    }
                    return null;
                }, nif);

                // Pesquisar por NIF — tentar URL com parâmetros de pesquisa e paginação
                // Navegar para lista de empresas
                await page.goto(SAFT_EMPRESAS_URL, { waitUntil: 'domcontentloaded' });
                await page.waitForTimeout(1200);

                // Usar filtro de coluna NIF do mvc-grid (1º input.mvc-grid-value = coluna NIF)
                const nifFilterInput = page.locator('input.mvc-grid-value').first();
                if (await nifFilterInput.isVisible({ timeout: 3000 }).catch(() => false)) {
                    await nifFilterInput.fill(nif);
                    await nifFilterInput.press('Enter');
                    await page.waitForTimeout(1500);
                }

                let finalEditUrl = await findByNif();

                // Se não encontrou via filtro, paginar (até 30 pág)
                if (!finalEditUrl) {
                    for (let pg = 0; pg < 30 && !finalEditUrl; pg++) {
                        const nextHref = await page.evaluate(() => {
                            const sel = ['a[rel="next"]', '.mvc-grid-pager a:last-child', '.pagination li:last-child:not(.disabled) a'];
                            for (const s of sel) {
                                const el = document.querySelector(s);
                                if (el && !el.closest('.disabled') && el.getAttribute('href')) return el.getAttribute('href');
                            }
                            return null;
                        });
                        if (!nextHref) break;
                        await page.goto(new URL(nextHref, page.url()).toString(), { waitUntil: 'domcontentloaded' });
                        await page.waitForTimeout(1000);
                        finalEditUrl = await findByNif();
                    }
                }

                if (!finalEditUrl) {
                    throw new Error(`Empresa com NIF ${nif} não encontrada no SAFTonline.`);
                }

                console.log(`[SAFTonline Write SS] Edit URL: ${finalEditUrl}`);

                // Navegar para a página de edição
                await page.goto(finalEditUrl, { waitUntil: 'domcontentloaded' });
                await page.waitForTimeout(1000);

                // Garantir que estamos no tab "Dados" (primeiro tab)
                const dadosTab = page.locator('a:has-text("Dados"), button:has-text("Dados")').first();
                if (await dadosTab.isVisible({ timeout: 3000 }).catch(() => false)) {
                    await dadosTab.click();
                    await page.waitForTimeout(500);
                }

                // Formatar data ISO → DD/MM/YYYY
                const fmtDate = (raw) => {
                    if (!raw) return '';
                    const d = new Date(raw);
                    if (isNaN(d.getTime())) return raw;
                    return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
                };

                // Preencher directamente via JavaScript (contorna restrições de visibilidade/focus)
                await page.evaluate(({ user, pass, valid, token, tokenValid }) => {
                    function setVal(id, value) {
                        const el = document.getElementById(id);
                        if (!el || !value) return;
                        // Setter nativo para compatibilidade com frameworks JS
                        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
                        if (nativeSetter && nativeSetter.set) nativeSetter.set.call(el, value);
                        else el.value = value;
                        el.dispatchEvent(new Event('input',  { bubbles: true }));
                        el.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                    setVal('Empresa_API_UsernameSS',        user);
                    setVal('Empresa_API_PasswordSS',        pass);
                    setVal('Empresa_SSValidUntil',          valid);
                    setVal('Empresa_API_TokenSSWebService', token);
                    setVal('Empresa_SSWebServiceValidUntil', tokenValid);
                }, {
                    user:       ssUser,
                    pass:       ssPassRaw || '',
                    valid:      fmtDate(ssValidade),
                    token:      tokenWS || '',
                    tokenValid: fmtDate(tokenWSVal),
                });
                await page.waitForTimeout(500);

                // Guardar — submeter o formulário via JavaScript para garantir que funciona
                await Promise.allSettled([
                    page.waitForLoadState('networkidle').catch(() => {}),
                    page.evaluate(() => {
                        const form = document.querySelector('form');
                        if (form) {
                            // Clicar o botão submit se existir
                            const btn = form.querySelector('input[type="submit"], button[type="submit"]');
                            if (btn) btn.click();
                            else form.submit();
                        }
                    }),
                ]);
                await page.waitForTimeout(3000);

                // Verificar URL — após guardar com sucesso o SAFTonline redireciona
                const finalUrl = page.url();
                const errorMsg = await page.locator('.alert-danger, .text-danger, .validation-summary-errors').first()
                    .textContent({ timeout: 2000 }).catch(() => null);
                if (errorMsg && errorMsg.trim()) {
                    throw new Error(`SAFTonline erro ao guardar: ${errorMsg.trim().slice(0, 200)}`);
                }
                console.log(`[SAFTonline Write SS] URL após guardar: ${finalUrl}`);

                console.log(`[SAFTonline Write SS] NIF=${nif} — gravado com sucesso.`);

                return res.json({
                    success: true,
                    nif,
                    ssUser,
                    hasToken: !!ssPassRaw,
                    hasWebServiceToken: !!tokenWS,
                    editUrl: finalEditUrl,
                    message: `Credenciais SS gravadas no SAFTonline para ${nif}.`,
                });

            } finally {
                await browser.close().catch(() => null);
            }

        } catch (error) {
            const details = String(error?.message || error);
            console.error('[SAFTonline Write SS] Erro:', details);
            return res.status(500).json({ success: false, error: details });
        }
    });

    // ── POST /api/customers/:id/saftonline/read-credentials ─────────────────
    // Lê todas as credenciais do formulário SAFTonline e guarda no WA PRO
    app.post('/api/customers/:id/saftonline/read-credentials', async (req, res) => {
        const customerId = String(req.params.id || '').trim();
        if (!customerId) return res.status(400).json({ success: false, error: 'ID inválido.' });
        if (!SAFT_EMAIL || !SAFT_PASSWORD) {
            return res.status(503).json({ success: false, error: 'Credenciais SAFTonline não configuradas.' });
        }

        let playwright;
        try { playwright = require('playwright'); } catch (_) {
            return res.status(503).json({ success: false, error: 'Playwright não instalado.' });
        }

        try {
            const customer = await dbGetAsync(
                'SELECT id, nif, name, company, access_credentials_json FROM customers WHERE id = ? LIMIT 1',
                [customerId]
            );
            if (!customer) return res.status(404).json({ success: false, error: 'Cliente não encontrado.' });

            const nif = String(customer.nif || '').trim();
            if (!nif) return res.status(400).json({ success: false, error: 'Cliente sem NIF.' });

            const browser = await playwright.chromium.launch({
                headless: true,
                args: ['--no-sandbox', '--disable-dev-shm-usage'],
            });

            try {
                const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
                const page = await ctx.newPage();
                page.setDefaultTimeout(30000);

                // Login
                await page.goto(SAFT_LOGIN_URL, { waitUntil: 'domcontentloaded' });
                await page.waitForTimeout(800);
                await page.fill('#Email', SAFT_EMAIL);
                await page.fill('#Senha', SAFT_PASSWORD);
                await Promise.allSettled([page.waitForLoadState('networkidle').catch(() => {}), page.locator('input[type="submit"]').first().click()]);
                await page.waitForTimeout(2000);

                // Localizar empresa por NIF
                await page.goto(SAFT_EMPRESAS_URL, { waitUntil: 'domcontentloaded' });
                await page.waitForTimeout(1000);
                const nifInput = page.locator('input.mvc-grid-value').first();
                if (await nifInput.isVisible({ timeout: 3000 }).catch(() => false)) {
                    await nifInput.fill(nif);
                    await nifInput.press('Enter');
                    await page.waitForTimeout(1200);
                }

                const editUrl = await page.evaluate((targetNif) => {
                    const fold = v => String(v||'').normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase().trim();
                    const tables = Array.from(document.querySelectorAll('table'));
                    let tbl = null;
                    for (const t of tables) {
                        const ths = Array.from(t.querySelectorAll('thead th')).map(th => fold(th.textContent));
                        if (ths.join('|').includes('nif') && ths.join('|').includes('empresa')) { tbl = t; break; }
                    }
                    if (!tbl) return null;
                    const headers = Array.from(tbl.querySelectorAll('thead th')).map(th => fold(th.textContent));
                    const nifIdx = headers.findIndex(h => h.includes('nif'));
                    for (const row of tbl.querySelectorAll('tbody tr')) {
                        const cells = Array.from(row.querySelectorAll('td'));
                        const cellNif = (cells[nifIdx]?.textContent||'').replace(/\D/g,'').trim();
                        if (cellNif === targetNif) {
                            const link = row.querySelector('a[href*="/empresas/Details/"], a[href*="/Empresas/Details/"]');
                            if (link) return new URL(link.getAttribute('href').replace(/\/Details\//gi, '/Edit/'), window.location.href).toString();
                        }
                    }
                    return null;
                }, nif);

                if (!editUrl) {
                    throw new Error(`Empresa com NIF ${nif} não encontrada no SAFTonline.`);
                }

                await page.goto(editUrl, { waitUntil: 'domcontentloaded' });
                await page.waitForTimeout(1000);

                // Ler todos os campos de credenciais
                const rawFields = await page.evaluate((fieldMap) => {
                    const result = {};
                    for (const [id] of fieldMap) {
                        const el = document.getElementById(id);
                        result[id] = el ? (el.value || '').trim() : '';
                    }
                    return result;
                }, SAFT_CREDENTIAL_MAP.flatMap(m => [[m.usernameId, ''], [m.passwordId, '']]));

                // Construir array de credenciais
                let creds = [];
                try { creds = JSON.parse(customer.access_credentials_json || '[]'); } catch (_) {}

                let saved = 0;
                for (const mapping of SAFT_CREDENTIAL_MAP) {
                    const user = rawFields[mapping.usernameId] || '';
                    const pass = rawFields[mapping.passwordId] || '';
                    if (!user && !pass) continue; // ignorar vazios

                    const encPass = pass ? encryptCustomerSecret(pass) : '';
                    const svcNorm = s => String(s||'').toLowerCase().replace(/\s+/g,'').normalize('NFD').replace(/[̀-ͯ]/g,'');
                    // Aceitar credentialType '' como equivalente a 'principal' (presets WA PRO usam '')
                    const typeMatch = (ct) => {
                        const a = (ct||'').toLowerCase().trim();
                        const b = (mapping.credentialType||'').toLowerCase().trim();
                        return a === b || (a === '' && b === 'principal') || (a === 'principal' && b === '');
                    };
                    const existingIdx = creds.findIndex(c =>
                        svcNorm(c.service) === svcNorm(mapping.service) && typeMatch(c.credentialType)
                    );

                    if (existingIdx >= 0) {
                        if (user) creds[existingIdx].username = user;
                        if (pass) creds[existingIdx].password = encPass;
                        // Não sobrescrever observacoes de entradas existentes
                    } else if (user || pass) {
                        creds.push({
                            service: mapping.service,
                            credentialType: mapping.credentialType,
                            username: user,
                            password: encPass,
                            emailAssociado: '',
                            validFrom: '',
                            validUntil: '',
                            status: 'active',
                            observacoes: 'Importado do SAFTonline',
                        });
                    }
                    saved++;
                }

                await dbRunAsync(
                    'UPDATE customers SET access_credentials_json = ?, updated_at = datetime(\'now\') WHERE id = ?',
                    [JSON.stringify(creds), customerId]
                );

                console.log(`[SAFTonline Read Creds] NIF=${nif} — ${saved} tipos de credenciais importados.`);

                return res.json({
                    success: true,
                    nif,
                    savedCount: saved,
                    message: `${saved} credenciais importadas do SAFTonline para ${customer.company || customer.name}.`,
                });

            } finally {
                await browser.close().catch(() => null);
            }

        } catch (error) {
            const details = String(error?.message || error);
            console.error('[SAFTonline Read Creds] Erro:', details);
            return res.status(500).json({ success: false, error: details });
        }
    });
}

module.exports = { registerSaftonlineWriteRoutes };
