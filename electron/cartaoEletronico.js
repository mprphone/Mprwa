'use strict';

function compactSpaces(value) {
  return String(value || '').replace(/ /g, ' ').replace(/[ \t\r\n]+/g, ' ').trim();
}

function normalizeCartaoCode(value) {
  const raw = String(value || '').trim();
  const grouped = raw.match(/\b(\d{4})\s*[- ]\s*(\d{4})\s*[- ]\s*(\d{4})\b/);
  if (grouped) return `${grouped[1]}-${grouped[2]}-${grouped[3]}`;
  const digits = raw.replace(/\D+/g, '');
  if (digits.length === 12) return `${digits.slice(0, 4)}-${digits.slice(4, 8)}-${digits.slice(8, 12)}`;
  return raw;
}

async function collectDesktopCartaoEletronico(page, payload = {}) {
  const code = normalizeCartaoCode(String(payload?.code || payload?.codigo || '').trim());
  if (!code) return { fields: {}, sourceUrl: '', ficheiroPdf: '' };

  const url = 'https://registo.justica.gov.pt/Empresas/Consultar-Cartao-de-Empresa-ou-Pessoa-Coletiva/iniciar';

  await page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: Number(payload?.navigationTimeoutMs || 30000),
  });
  await page.waitForTimeout(1000);

  // Clicar "Iniciar"
  const iniciarBtn = page.locator('button:has-text("Iniciar"), a:has-text("Iniciar")').first();
  await iniciarBtn.click({ timeout: 10000 }).catch(() => null);
  await page.waitForTimeout(1500);

  // Preencher o código
  const codeInput = page.locator('input[placeholder*="0000"], input[id*="odigo"], input[name*="odigo"], input[type="text"]').first();
  await codeInput.fill(code, { timeout: 8000 }).catch(() => null);
  await page.waitForTimeout(500);

  // Submeter
  const obterBtn = page.locator('button:has-text("Obter"), button:has-text("Consultar"), button[type="submit"]').first();
  await obterBtn.click({ timeout: 8000 }).catch(async () => { await page.keyboard.press('Enter'); });
  await page.waitForTimeout(Number(payload?.settleMs || 3000));

  const text = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
  const fields = parseCartaoText(text, code);

  let ficheiroPdf = '';
  const documentsFolder = String(payload?.documentsFolder || '').trim();
  if (documentsFolder) {
    try {
      const path = require('path');
      const fs = require('fs');
      const resumoDir = path.join(documentsFolder, 'Resumo Fiscal');
      fs.mkdirSync(resumoDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const destPath = path.join(resumoDir, `CartaoEletronico_${stamp}.pdf`);
      await page.pdf({ path: destPath, format: 'A4', printBackground: true });
      ficheiroPdf = destPath;
    } catch (e) {
      console.warn('[CartaoEletronico] Não guardou PDF:', e?.message);
    }
  }

  return { fields, sourceUrl: page.url(), textPreview: compactSpaces(text).slice(0, 500), ficheiroPdf };
}

function parseCartaoText(text, code) {
  const raw = compactSpaces(text);
  const fields = { cartaoEletronicoNumero: code };

  const nipcMatch = raw.match(/NIPC\s*(\d{9})/i) || raw.match(/\b([25]\d{8})\b/);
  if (nipcMatch) fields.nif = nipcMatch[1];

  const nomeMatch = raw.match(/Nome\s+([A-ZÁÉÍÓÚÀÂÊÔÃÕÇ][^\n]{3,80})/i)
    || raw.match(/Denomina[cç][aã]o\s*[:\-]?\s*([^\n\r]{3,80})/i);
  if (nomeMatch) fields.company = nomeMatch[1].trim();

  const natMatch = raw.match(/Natureza Jur[ií]dica\s+([^\n]{3,60})/i);
  if (natMatch) fields.naturezaJuridica = natMatch[1].trim();

  const cpMatch = raw.match(/(\d{4})\s*[—\-]\s*(\d{3})/);
  if (cpMatch) fields.codigoPostal = `${cpMatch[1]}-${cpMatch[2]}`;

  const dataMatch = raw.match(/Data de constitui[cç][aã]o\s+(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/i)
    || raw.match(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})\b/);
  if (dataMatch) fields.dataConstituicao = `${dataMatch[3]}-${dataMatch[2].padStart(2, '0')}-${dataMatch[1].padStart(2, '0')}`;

  const caeMatch = raw.match(/CAE principal\s+(\d{4,5})/i);
  if (caeMatch) fields.caePrincipal = caeMatch[1];

  return fields;
}

module.exports = { collectDesktopCartaoEletronico, normalizeCartaoCode };
