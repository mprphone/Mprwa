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
  await page.waitForTimeout(2000);

  // Step 1 → 2: clicar "Iniciar"
  await page.evaluate(() => {
    const btn = document.getElementById('PageBreak_1477_4_next');
    if (btn) btn.click();
  });
  await page.waitForTimeout(1200);

  // Preencher o código
  await page.evaluate((c) => {
    const inp = document.getElementById('dnn_ctr1477_View_Textbox_1477_7');
    if (inp) {
      inp.value = c;
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      inp.dispatchEvent(new Event('blur', { bubbles: true }));
    }
  }, code);

  // Aguardar que a API apiv2.justica.gov.pt preencha os campos (só funciona com IP residencial)
  // Esperar que o campo NIPC (Textbox_1477_11) fique preenchido
  await page.waitForFunction(
    () => {
      const nipc = document.getElementById('dnn_ctr1477_View_Textbox_1477_11');
      return nipc && nipc.value && nipc.value.length > 3;
    },
    { timeout: 15000 }
  ).catch(() => null);

  // Extrair os dados dos campos do formulário (mais fiável que innerText)
  const formFields = await page.evaluate(() => {
    const get = id => (document.getElementById(id) || {}).value || '';
    const getText = id => {
      const el = document.getElementById(id);
      return el ? (el.tagName === 'TEXTAREA' ? el.value : el.value) : '';
    };
    return {
      nipc:            get('dnn_ctr1477_View_Textbox_1477_11'),
      naturezaJuridica: get('dnn_ctr1477_View_Textbox_1477_12'),
      nome:            getText('dnn_ctr1477_View_Textbox_1477_15'),
      morada:          get('dnn_ctr1477_View_Textbox_1477_16'),
      codigoPostal:    get('dnn_ctr1477_View_Textbox_1477_18'),
      localidade:      get('dnn_ctr1477_View_Textbox_1477_19'),
      pais:            get('dnn_ctr1477_View_Textbox_1477_21'),
      caePrincipal:    get('dnn_ctr1477_View_Textbox_1477_22'),
    };
  });

  // Clicar Seguinte (step 2 → 3) para mostrar página de resultados
  await page.evaluate(() => {
    const btn = document.getElementById('PageBreak_1477_26_next') || document.getElementById('irn_lightbox_search_button');
    if (btn) btn.click();
  });
  await page.waitForTimeout(2000);

  const text = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');

  // Usar campos do formulário se preenchidos, senão tentar extrair do texto
  const fields = (formFields?.nipc)
    ? {
        cartaoEletronicoNumero: code,
        nif:              formFields.nipc,
        company:          formFields.nome || formFields.nipc,
        naturezaJuridica: formFields.naturezaJuridica,
        morada:           formFields.morada,
        codigoPostal:     formFields.codigoPostal,
        localidade:       formFields.localidade,
        caePrincipal:     formFields.caePrincipal,
      }
    : parseCartaoText(text, code);

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
