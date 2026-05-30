'use strict';

const fs = require('fs');
const path = require('path');

const LOGO_PATH = path.join(__dirname, '../../public/Logo.png');

function logoBase64() {
  try {
    return 'data:image/png;base64,' + fs.readFileSync(LOGO_PATH).toString('base64');
  } catch (_) {
    return '';
  }
}

function fmt(value) {
  if (value == null || value === '') return '-';
  if (typeof value === 'number') {
    return value.toLocaleString('pt-PT', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
  }
  return String(value);
}

function fmtDate(iso) {
  if (!iso) return '-';
  try { return new Date(iso).toLocaleDateString('pt-PT'); } catch (_) { return iso; }
}

function fmtContractType(v) {
  if (!v) return '-';
  if (v === 'fixed_term') return 'A termo certo';
  if (v === 'indefinite') return 'Sem termo';
  return String(v);
}
function fmtEndedBy(v) {
  if (!v) return '-';
  if (v === 'employer') return 'Empregador';
  if (v === 'worker') return 'Trabalhador';
  return String(v);
}
function fmtPtDate(iso) {
  if (!iso) return '-';
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('pt-PT');
  } catch (_) { return iso; }
}

function buildHtml(data) {
  const { result, customer, actValidation, actInput, employeeName, generatedAt } = data;
  const logo = logoBase64();
  const dateStr = new Date(generatedAt || Date.now()).toLocaleString('pt-PT');

  const summaryCards = (result.summary || []).map((line, i) => `
    <div class="sum-card${i === 0 ? ' sum-primary' : ''}">
      <div class="sum-label">${line.label}</div>
      <div class="sum-value">${fmt(line.value)}</div>
    </div>`).join('');

  const actRows = actValidation?.results ? Object.entries({
    'Compensação': actValidation.results.compensation,
    'Férias vencidas': actValidation.results.vacation,
    'Subsídio de férias': actValidation.results.holidayAllowance,
    'Proporcional férias': actValidation.results.proportionalVacation,
    'Prop. subsídio férias': actValidation.results.proportionalHolidayAllowance,
    'Prop. subsídio Natal': actValidation.results.proportionalChristmasAllowance,
    'Montante global ACT': actValidation.results.total,
  }).filter(([, v]) => v != null).map(([label, value]) => `
    <tr${label === 'Montante global ACT' ? ' class="total-row"' : ''}>
      <td>${label}</td><td class="money">${fmt(value)}</td>
    </tr>`).join('') : '';

  const basisRows = (result.basis || []).map((item) => `
    <tr>
      <td>${item.label}</td>
      <td>${item.value}</td>
      <td><a href="${item.sourceUrl}">${item.sourceLabel}</a></td>
    </tr>`).join('');

  // excluir linhas redundantes que já aparecem no sumário ou noutras secções
  const detailExclude = new Set(['Subtotal comparável ao ACT', 'Retribuição mensal compensação', 'Retribuição mensal férias/subsídios']);
  const detailRows = (result.details || [])
    .filter((d) => !detailExclude.has(d.label))
    .map((d) => `<tr><td>${d.label}</td><td class="money">${fmt(d.value)}</td></tr>`).join('');

  const warnings = (result.warnings || []).map((w) => `<p>${w}</p>`).join('');

  const contractFields = actInput ? [
    ['Tipo de contrato', fmtContractType(actInput.contractType)],
    ['Data de início', fmtPtDate(actInput.startDate)],
    ['Data de cessação', fmtPtDate(actInput.endDate)],
    ['Cessado por', fmtEndedBy(actInput.endedBy)],
    ['Justa causa', actInput.justCause ? 'Sim' : 'Não'],
    ['Retribuição base', fmt(actInput.monthlyBaseSalary)],
    ['Diuturnidades', fmt(actInput.diuturnities || 0)],
    ['Complementos', fmt(actInput.complements || 0)],
    ['Férias vencidas / gozadas', `${actInput.vacationDaysDue || 22} dias / ${actInput.vacationDaysTaken || 0} dias`],
    ['Horas de formação em falta', `${actInput.trainingHoursDue || 0} h`],
  ] : [];

  return `<!DOCTYPE html>
<html lang="pt">
<head>
<meta charset="UTF-8"/>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 10px; color: #1a1a1a; background: #fff; }
  .page { padding: 18px 24px; max-width: 900px; margin: 0 auto; }

  .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 2.5px solid #16a34a; padding-bottom: 8px; margin-bottom: 10px; }
  .header-left { display: flex; align-items: center; gap: 10px; }
  .logo { height: 32px; object-fit: contain; }
  .app-name { font-size: 15px; font-weight: 800; color: #15803d; }
  .app-sub { font-size: 8px; color: #6b7280; margin-top: 1px; }
  .header-right { text-align: right; font-size: 8.5px; color: #6b7280; }
  .header-right strong { font-size: 10px; color: #374151; }

  .sim-title { font-size: 13px; font-weight: 800; color: #111827; margin-bottom: 2px; }
  .sim-sub { font-size: 8.5px; color: #9ca3af; margin-bottom: 9px; }

  /* cliente + contrato */
  .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 9px; }
  .info-box { border-radius: 5px; border: 1px solid #e5e7eb; }
  .info-box.green { border-color: #bbf7d0; }
  .info-head { font-size: 7.5px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.5px; color: #fff !important; padding: 3px 8px; border-radius: 4px 4px 0 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .bg-green { background: #15803d !important; }
  .bg-slate { background: #475569 !important; }
  table.info-tbl { width: 100%; border-collapse: collapse; font-size: 9px; }
  table.info-tbl td { padding: 2.5px 8px; border-bottom: 1px solid #e5e7eb; color: #374151 !important; }
  table.info-tbl tr:last-child td { border-bottom: none; }
  .lbl { color: #6b7280 !important; width: 42%; }
  .val { font-weight: 600; color: #111827 !important; }
  .val.emp { color: #374151 !important; font-weight: 700; border-bottom: 1px solid #374151; min-width: 120px; display: inline-block; }

  /* sumário cards — uma linha */
  .sum-grid { display: flex; gap: 6px; margin-bottom: 9px; }
  .sum-card { flex: 1; border: 1px solid #e5e7eb; border-radius: 5px; padding: 7px 6px; text-align: center; }
  .sum-primary { background: #f0fdf4; border-color: #86efac; }
  .sum-label { font-size: 7px; font-weight: 700; color: #6b7280; text-transform: uppercase; letter-spacing: 0.3px; }
  .sum-value { font-size: 13px; font-weight: 900; color: #15803d; font-variant-numeric: tabular-nums; margin-top: 2px; }

  /* secções */
  .section { margin-bottom: 9px; }
  .sec-head { font-size: 8.5px; font-weight: 800; color: #fff; padding: 3px 8px; border-radius: 3px 3px 0 0; text-transform: uppercase; letter-spacing: 0.4px; display: flex; justify-content: space-between; align-items: center; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .bg-blue { background: #1d4ed8; }

  /* duas colunas para tabelas menores */
  .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 9px; }

  table.data { width: 100%; border-collapse: collapse; font-size: 9px; }
  table.data th { background: #f9fafb; font-weight: 700; font-size: 7.5px; text-transform: uppercase; color: #6b7280; padding: 3px 8px; border-bottom: 1px solid #e5e7eb; text-align: left; }
  table.data td { padding: 2.5px 8px; border-bottom: 1px solid #f3f4f6; color: #374151 !important; }
  table.data tr:last-child td { border-bottom: none; }
  .money { text-align: right; font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .total-row td { background: #eff6ff; font-weight: 800; color: #1d4ed8; border-top: 1px solid #bfdbfe; font-size: 9.5px; }
  a { color: #1d4ed8; text-decoration: none; font-size: 8.5px; }

  .disclaimer { background: #fffbeb; border: 1px solid #fde68a; border-radius: 3px; padding: 5px 8px; font-size: 8px; color: #92400e; margin-bottom: 8px; }
  .footer { border-top: 1px solid #e5e7eb; padding-top: 5px; font-size: 7.5px; color: #9ca3af; display: flex; justify-content: space-between; }
</style>
</head>
<body>
<div class="page">

  <div class="header">
    <div class="header-left">
      ${logo ? `<img src="${logo}" class="logo" alt="MPR"/>` : ''}
      <div><div class="app-name">MPR Negócios</div><div class="app-sub">Centro de Simulação</div></div>
    </div>
    <div class="header-right"><strong>${dateStr}</strong><br/>${result.version?.id || ''}</div>
  </div>

  <div class="sim-title">${result.title || 'Simulação'}</div>
  <div class="sim-sub">Simulação meramente indicativa. Deve ser confirmada com técnico laboral antes de ser comunicada ao cliente.</div>

  <div class="info-grid">
    <div class="info-box green">
      <div class="info-head bg-green">Entidade empregadora</div>
      <table class="info-tbl">
        <tr><td class="lbl">Empresa</td><td class="val">${customer?.company || customer?.name || '-'}</td></tr>
        <tr><td class="lbl">NIF</td><td class="val">${customer?.nif || '-'}</td></tr>
        <tr><td class="lbl">Email</td><td class="val">${customer?.email || '-'}</td></tr>
        <tr><td class="lbl">Funcionário</td><td class="val"><span class="emp">${employeeName || '&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;'}</span></td></tr>
      </table>
    </div>
    ${contractFields.length ? `
    <div class="info-box">
      <div class="info-head bg-slate">Dados do contrato</div>
      <table class="info-tbl">
        ${contractFields.map(([l, v]) => `<tr><td class="lbl">${l}</td><td class="val">${v}</td></tr>`).join('')}
      </table>
    </div>` : ''}
  </div>

  <div class="sum-grid">${summaryCards}</div>

  ${actRows ? `
  <div class="section">
    <div class="sec-head bg-blue">Resultado Oficial ACT
      <span style="font-weight:400;font-size:8.5px;opacity:.85">Lido em ${fmtDate(actValidation.computedAt)}</span>
    </div>
    <table class="data">
      <thead><tr><th>Rubrica</th><th style="text-align:right">Valor</th></tr></thead>
      <tbody>${actRows}</tbody>
    </table>
  </div>` : ''}

  <div class="two-col">
    <div class="section">
      <div class="sec-head bg-green">Detalhe do cálculo</div>
      <table class="data">
        <thead><tr><th>Rubrica</th><th style="text-align:right">Valor</th></tr></thead>
        <tbody>${detailRows}</tbody>
      </table>
    </div>
    <div class="section">
      <div class="sec-head bg-slate">Pressupostos e fontes</div>
      <table class="data">
        <thead><tr><th>Regra</th><th>Valor aplicado</th><th>Fonte</th></tr></thead>
        <tbody>${basisRows}</tbody>
      </table>
    </div>
  </div>

  ${warnings ? `<div class="disclaimer">${warnings}</div>` : ''}

  <div class="footer">
    <span>MPR Negócios · Centro de Simulação · ${dateStr}</span>
    <span>Versão ${result.version?.id || '-'} · válida desde ${result.version?.validFrom || '-'}</span>
  </div>

</div>
</body>
</html>`;
}

async function generateSimulatorPdf(data) {
  let playwright;
  try {
    playwright = require('playwright');
  } catch (_) {
    throw new Error('Playwright não instalado.');
  }

  const browser = await playwright.chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const page = await browser.newPage();
    await page.setContent(buildHtml(data), { waitUntil: 'load' });
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '10mm', bottom: '10mm', left: '10mm', right: '10mm' },
    });
    return pdfBuffer;
  } finally {
    await browser.close().catch(() => null);
  }
}

module.exports = { generateSimulatorPdf };
