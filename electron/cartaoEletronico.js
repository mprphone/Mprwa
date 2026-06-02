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

  const url = `https://registo.justica.gov.pt/Empresas/Cartao-Empresa/Iniciar?codigocartao=${encodeURIComponent(code)}`;

  await page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: Number(payload?.navigationTimeoutMs || 30000),
  });
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

  const nifMatch = raw.match(/\b(\d{9})\b/);
  if (nifMatch) fields.nif = nifMatch[1];

  const denomMatch = raw.match(/Denomina[cç][aã]o\s*[:\-]?\s*([^\n\r]+)/i);
  if (denomMatch) fields.company = denomMatch[1].trim();

  const dataMatch = raw.match(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})\b/);
  if (dataMatch) fields.dataRegisto = `${dataMatch[3]}-${dataMatch[2].padStart(2, '0')}-${dataMatch[1].padStart(2, '0')}`;

  return fields;
}

module.exports = { collectDesktopCartaoEletronico, normalizeCartaoCode };
