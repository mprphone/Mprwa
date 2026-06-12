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
  if (value == null || value === '') return '—';
  if (typeof value === 'number') {
    return value.toLocaleString('pt-PT', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
  }
  return String(value);
}

function fmtDate(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleDateString('pt-PT'); } catch (_) { return iso; }
}

function fmtContractType(v) {
  if (!v) return '—';
  if (v === 'fixed_term') return 'A termo certo';
  if (v === 'indefinite') return 'Sem termo';
  return String(v);
}
function fmtEndedBy(v) {
  if (!v) return '—';
  if (v === 'employer') return 'Empregador';
  if (v === 'worker') return 'Trabalhador';
  return String(v);
}
function fmtPtDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('pt-PT');
  } catch (_) { return iso; }
}

function buildLoanHtml(data) {
  const { result, customer, employeeName, generatedAt, loanSchedule, loanInput } = data;
  const logo = logoBase64();
  const dateStr = new Date(generatedAt || Date.now()).toLocaleString('pt-PT');
  const sch = loanSchedule || {};
  const li = loanInput || {};
  const annualRate = ((li.euribor || 0) + (li.spread || 0)).toFixed(3);
  const isVariable = li.rateType === 'variable';

  const header = (pageNum) => `
  <div class="header">
    <div class="header-left">
      ${logo ? `<img src="${logo}" class="logo" alt="MPR"/>` : ''}
      <div><div class="app-name">MPR Negócios</div><div class="app-sub">Centro de Simulação</div></div>
    </div>
    <div class="header-right">
      <div class="header-date">${dateStr}</div>
      <div class="header-ver">${result.version?.id || ''} · pág. ${pageNum}</div>
    </div>
  </div>`;

  // ── PAGE 1: Summary ──────────────────────────────────────────────────────
  const summaryCards = (result.summary || []).map((line, i) => `
    <div class="sum-card ${i === 0 ? 'sum-primary' : ''}">
      <div class="sum-label">${line.label}</div>
      <div class="sum-value">${typeof line.value === 'number' ? line.value.toLocaleString('pt-PT', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €' : line.value}</div>
    </div>`).join('');

  const infoRows = [
    ['Empresa', customer?.company || customer?.name || '—'],
    ['NIF', customer?.nif || '—'],
    ['Funcionário / Referência', employeeName || '—'],
  ].map(([l, v]) => `<tr><td class="lbl">${l}</td><td class="val">${v}</td></tr>`).join('');

  const loanRows = [
    ['Valor do empréstimo', fmt(li.loanAmount)],
    ['Euribor', `${(li.euribor || 0).toFixed(3)}%`],
    ['Spread', `${(li.spread || 0).toFixed(3)}%`],
    ['TAN (Taxa Anual Nominal)', `${annualRate}%`],
    ['Tipo de taxa', isVariable ? `Variável (revisão ${li.euriborReviewMonths || 12} meses)` : 'Fixa'],
    ['Prazo', `${li.termYears || '—'} anos (${sch.numScheduledPayments || '—'} meses)`],
    ['Pagamento extra mensal', fmt(li.extraPaymentMonthly)],
  ].map(([l, v]) => `<tr><td class="lbl">${l}</td><td class="val">${v}</td></tr>`).join('');

  const resultRows = [
    ['Prestação mensal programada', fmt(sch.scheduledMonthly), true],
    ['Nº prestações reais', sch.numActualPayments || '—', false],
    ['Total amortização capital', fmt(li.loanAmount), false],
    ['Total juros pagos', fmt(sch.totalInterest), false],
    ['Total pago', fmt(sch.totalPaid), true],
    ...(sch.interestSaved > 0 ? [
      ['Juros poupados c/ extra', fmt(sch.interestSaved), false],
      ['Meses antecipados', `${(sch.numScheduledPayments || 0) - (sch.numActualPayments || 0)}`, false],
    ] : []),
  ].map(([l, v, bold]) => `<tr${bold ? ' class="total-row"' : ''}><td>${l}</td><td class="money">${v}</td></tr>`).join('');

  const warnings = (result.warnings || []).map((w) => `<p>${w}</p>`).join('');

  // ── PAGE 2+: Amortization schedule ──────────────────────────────────────
  const ROWS_PER_PAGE = 32;
  const rows = sch.rows || [];
  const schedulePages = [];
  for (let i = 0; i < rows.length; i += ROWS_PER_PAGE) {
    schedulePages.push(rows.slice(i, i + ROWS_PER_PAGE));
  }

  const scheduleHtml = schedulePages.map((pageRows, pi) => `
  <div class="page page-break">
    ${header(pi + 2)}
    <div class="doc-title-row">
      <div class="doc-title">Plano de Amortização</div>
      <div class="doc-sub">Prestações ${pageRows[0].num} a ${pageRows[pageRows.length - 1].num} de ${rows.length} · ${result.title}</div>
    </div>
    <div class="section">
      <div class="sec-title bg-green">Plano de prestações</div>
      <table class="data sched">
        <thead>
          <tr>
            <th>Nº</th><th>Data</th><th style="text-align:right">Saldo inicial</th>
            <th style="text-align:right">Prestação</th><th style="text-align:right">Extra</th>
            <th style="text-align:right">Capital</th><th style="text-align:right">Juros</th>
            <th style="text-align:right">Saldo final</th>
          </tr>
        </thead>
        <tbody>
          ${pageRows.map((r) => `
          <tr>
            <td>${r.num}</td>
            <td>${r.date}</td>
            <td class="money">${r.beginBalance.toLocaleString('pt-PT', { minimumFractionDigits: 2 })} €</td>
            <td class="money">${r.scheduled.toLocaleString('pt-PT', { minimumFractionDigits: 2 })} €</td>
            <td class="money" style="color:${r.extra > 0 ? '#1d4ed8' : '#9ca3af'}">${r.extra > 0 ? r.extra.toLocaleString('pt-PT', { minimumFractionDigits: 2 }) + ' €' : '—'}</td>
            <td class="money" style="color:#15803d">${r.principal.toLocaleString('pt-PT', { minimumFractionDigits: 2 })} €</td>
            <td class="money" style="color:#dc2626">${r.interest.toLocaleString('pt-PT', { minimumFractionDigits: 2 })} €</td>
            <td class="money font-bold">${r.endBalance.toLocaleString('pt-PT', { minimumFractionDigits: 2 })} €</td>
          </tr>`).join('')}
        </tbody>
        ${pi === schedulePages.length - 1 ? `
        <tfoot>
          <tr class="total-row">
            <td colspan="3">Total</td>
            <td class="money">${(sch.totalPaid || 0).toLocaleString('pt-PT', { minimumFractionDigits: 2 })} €</td>
            <td class="money" style="color:#1d4ed8">${(sch.totalExtraPayments || 0) > 0 ? (sch.totalExtraPayments).toLocaleString('pt-PT', { minimumFractionDigits: 2 }) + ' €' : '—'}</td>
            <td class="money" style="color:#15803d">${(li.loanAmount || 0).toLocaleString('pt-PT', { minimumFractionDigits: 2 })} €</td>
            <td class="money" style="color:#dc2626">${(sch.totalInterest || 0).toLocaleString('pt-PT', { minimumFractionDigits: 2 })} €</td>
            <td class="money">0,00 €</td>
          </tr>
        </tfoot>` : ''}
      </table>
    </div>
    <div class="footer">
      <span>MPR Negócios · Centro de Simulação · ${dateStr}</span>
      <div class="footer-badge">Versão ${result.version?.id || '—'}</div>
    </div>
  </div>`).join('');

  return `<!DOCTYPE html>
<html lang="pt">
<head>
<meta charset="UTF-8"/>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 10px; color: #1a1a2e; background: #fff; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .page { padding: 16px 20px 14px; max-width: 210mm; margin: 0 auto; min-height: 277mm; display: flex; flex-direction: column; }
  .page-break { page-break-before: always; }

  .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; padding-bottom: 10px; border-bottom: 3px solid #16a34a; }
  .header-left { display: flex; align-items: center; gap: 10px; }
  .logo { height: 32px; object-fit: contain; }
  .app-name { font-size: 16px; font-weight: 900; color: #15803d; }
  .app-sub { font-size: 8px; color: #6b7280; }
  .header-right { text-align: right; }
  .header-date { font-size: 10px; font-weight: 700; color: #374151; }
  .header-ver { font-size: 8px; color: #9ca3af; }

  .doc-title { font-size: 15px; font-weight: 900; color: #111827; }
  .doc-sub { font-size: 8.5px; color: #9ca3af; margin-top: 2px; margin-bottom: 10px; }
  .doc-title-row { margin-bottom: 10px; }

  .sum-strip { display: grid; grid-template-columns: repeat(4,1fr); gap: 8px; margin-bottom: 14px; }
  .sum-card { border-radius: 8px; border: 1.5px solid #e5e7eb; padding: 10px 8px; text-align: center; background: #fafafa; }
  .sum-primary { background: linear-gradient(135deg,#15803d,#16a34a); border-color: #15803d; }
  .sum-label { font-size: 7px; font-weight: 700; color: #9ca3af; text-transform: uppercase; letter-spacing: 0.4px; margin-bottom: 4px; }
  .sum-primary .sum-label { color: #bbf7d0; }
  .sum-value { font-size: 16px; font-weight: 900; color: #15803d; }
  .sum-primary .sum-value { color: #fff; font-size: 18px; }

  .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 12px; }
  .info-box { border-radius: 5px; border: 1px solid #e5e7eb; }
  .info-head { font-size: 7.5px; font-weight: 800; text-transform: uppercase; color: #fff; padding: 3px 8px; border-radius: 4px 4px 0 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .bg-green { background: #15803d !important; }
  .bg-slate { background: #334155 !important; }
  table.info-tbl { width: 100%; border-collapse: collapse; font-size: 9px; }
  table.info-tbl td { padding: 3px 8px; border-bottom: 1px solid #f1f5f9; }
  table.info-tbl tr:last-child td { border-bottom: none; }
  .lbl { color: #6b7280; width: 45%; }
  .val { font-weight: 700; color: #111827; }

  .section { margin-bottom: 12px; flex: 1; }
  .sec-title { font-size: 8.5px; font-weight: 800; color: #fff; padding: 4px 10px; border-radius: 4px 4px 0 0; text-transform: uppercase; letter-spacing: 0.4px; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  table.data { width: 100%; border-collapse: collapse; font-size: 9px; border: 1px solid #e5e7eb; border-top: none; }
  table.data th { background: #f8fafc; font-weight: 700; font-size: 7.5px; text-transform: uppercase; color: #6b7280; padding: 3px 8px; border-bottom: 1px solid #e5e7eb; text-align: left; }
  table.data td { padding: 2.5px 8px; border-bottom: 1px solid #f3f4f6; }
  table.data tr:last-child td { border-bottom: none; }
  .money { text-align: right; font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .total-row td { background: #f0fdf4 !important; font-weight: 800; color: #15803d !important; border-top: 1.5px solid #86efac !important; }
  table.data.sched { font-size: 8.5px; }
  table.data.sched td, table.data.sched th { padding: 2px 6px; }
  .font-bold { font-weight: 700; }

  .disclaimer { background: #fffbeb; border-left: 3px solid #f59e0b; border-radius: 0 4px 4px 0; padding: 6px 10px; font-size: 8px; color: #92400e; margin-bottom: 10px; line-height: 1.5; }
  .spacer { flex: 1; }
  .footer { border-top: 1px solid #e5e7eb; padding-top: 6px; font-size: 7.5px; color: #9ca3af; display: flex; justify-content: space-between; align-items: center; margin-top: 8px; }
  .footer-badge { background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 4px; padding: 2px 6px; font-size: 7px; font-weight: 700; color: #15803d; }

  ${isVariable ? `.variable-badge { display:inline-block; background:#fef3c7; border:1px solid #fde68a; border-radius:4px; padding:1px 6px; font-size:7.5px; font-weight:700; color:#92400e; margin-left:6px; }` : ''}
</style>
</head>
<body>

<!-- PAGE 1: Summary -->
<div class="page">
  ${header(1)}
  <div class="doc-title-row">
    <div class="doc-title">Simulador de Empréstimo ${isVariable ? '<span class="variable-badge">Taxa Variável</span>' : ''}</div>
    <div class="doc-sub">Plano de amortização pelo método francês (prestação constante) · ${dateStr}</div>
  </div>

  <div class="sum-strip">${summaryCards}</div>

  <div class="two-col">
    <div class="info-box">
      <div class="info-head bg-green">Entidade / Referência</div>
      <table class="info-tbl"><tbody>${infoRows}</tbody></table>
    </div>
    <div class="info-box">
      <div class="info-head bg-slate">Condições do empréstimo</div>
      <table class="info-tbl"><tbody>${loanRows}</tbody></table>
    </div>
  </div>

  <div class="section">
    <div class="sec-title bg-slate">Resumo financeiro</div>
    <table class="data">
      <thead><tr><th style="width:60%">Rubrica</th><th style="text-align:right">Valor</th></tr></thead>
      <tbody>${resultRows}</tbody>
    </table>
  </div>

  ${warnings ? `<div class="disclaimer">${warnings}</div>` : ''}
  <div class="spacer"></div>
  <div class="footer">
    <span>MPR Negócios · Centro de Simulação · ${dateStr}</span>
    <div class="footer-badge">Versão ${result.version?.id || '—'} · válida desde ${result.version?.validFrom || '—'}</div>
  </div>
</div>

${scheduleHtml}

</body></html>`;
}

function buildHtml(data) {
  const { result, customer, actValidation, actInput, employeeName, generatedAt } = data;
  const logo = logoBase64();
  const dateStr = new Date(generatedAt || Date.now()).toLocaleString('pt-PT');
  const isSalary = (result.title || '').toLowerCase().includes('sal');

  // ── Summary cards ──────────────────────────────────────────────
  const summaryCards = (result.summary || []).map((line, i) => {
    const isPrimary = i === 0;
    return `
    <div class="sum-card ${isPrimary ? 'sum-primary' : ''}">
      <div class="sum-label">${line.label}</div>
      <div class="sum-value">${fmt(line.value)}</div>
    </div>`;
  }).join('');

  // ── ACT official rows ──────────────────────────────────────────
  const actRows = actValidation?.results ? Object.entries({
    'Compensação por cessação': actValidation.results.compensation,
    'Férias vencidas': actValidation.results.vacation,
    'Subsídio de férias': actValidation.results.holidayAllowance,
    'Proporcional de férias': actValidation.results.proportionalVacation,
    'Prop. subsídio de férias': actValidation.results.proportionalHolidayAllowance,
    'Prop. subsídio de Natal': actValidation.results.proportionalChristmasAllowance,
    'Montante global ACT': actValidation.results.total,
  }).filter(([, v]) => v != null).map(([label, value]) => `
    <tr${label === 'Montante global ACT' ? ' class="total-row"' : ''}>
      <td>${label}</td><td class="money">${fmt(value)}</td>
    </tr>`).join('') : '';

  // ── Basis rows ─────────────────────────────────────────────────
  const basisRows = (result.basis || []).map((item) => `
    <tr>
      <td>${item.label}</td>
      <td class="applied">${item.value}</td>
      <td><a href="${item.sourceUrl}">${item.sourceLabel}</a></td>
    </tr>`).join('');

  // ── Detail rows ────────────────────────────────────────────────
  const detailExclude = new Set(['Subtotal comparável ao ACT', 'Retribuição mensal compensação', 'Retribuição mensal férias/subsídios']);
  const detailRows = (result.details || [])
    .filter((d) => !detailExclude.has(d.label))
    .map((d) => {
      const isTotal = d.label?.toLowerCase().includes('líquido') || d.label?.toLowerCase().includes('total') || d.label?.toLowerCase().includes('custo anual');
      return `<tr${isTotal ? ' class="total-row"' : ''}><td>${d.label}</td><td class="money">${fmt(d.value)}</td></tr>`;
    }).join('');

  // ── Contract fields ────────────────────────────────────────────
  const contractFields = actInput ? [
    ['Tipo de contrato', fmtContractType(actInput.contractType)],
    ['Data de início', fmtPtDate(actInput.startDate)],
    ['Data de cessação', fmtPtDate(actInput.endDate)],
    ['Cessado por', fmtEndedBy(actInput.endedBy)],
    ['Justa causa', actInput.justCause ? 'Sim' : 'Não'],
    ['Retribuição base', fmt(actInput.monthlyBaseSalary)],
    ['Diuturnidades', fmt(actInput.diuturnities || 0)],
    ['Complementos', fmt(actInput.complements || 0)],
    ['Férias devidas / gozadas', `${actInput.vacationDaysDue || 22} dias / ${actInput.vacationDaysTaken || 0} dias`],
    ['Horas de formação em falta', `${actInput.trainingHoursDue || 0} h`],
  ] : [];

  const warnings = (result.warnings || []).map((w) => `<p>${w}</p>`).join('');

  return `<!DOCTYPE html>
<html lang="pt">
<head>
<meta charset="UTF-8"/>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap');

  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'Inter', 'Helvetica Neue', Arial, sans-serif;
    font-size: 10.5px;
    color: #1a1a2e;
    background: #fff;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .page { padding: 22px 26px 18px; max-width: 210mm; margin: 0 auto; min-height: 277mm; display: flex; flex-direction: column; }

  /* ── HEADER ── */
  .header {
    display: flex; justify-content: space-between; align-items: center;
    margin-bottom: 18px;
    padding-bottom: 14px;
    border-bottom: 3px solid #16a34a;
  }
  .header-left { display: flex; align-items: center; gap: 12px; }
  .logo { height: 38px; object-fit: contain; }
  .app-name { font-size: 18px; font-weight: 900; color: #15803d; letter-spacing: -0.5px; }
  .app-sub { font-size: 9px; color: #6b7280; margin-top: 1px; letter-spacing: 0.3px; }
  .header-right { text-align: right; }
  .header-date { font-size: 11px; font-weight: 700; color: #374151; }
  .header-ver { font-size: 8.5px; color: #9ca3af; margin-top: 2px; }

  /* ── DOC TITLE ── */
  .doc-title-row { margin-bottom: 16px; }
  .doc-title { font-size: 17px; font-weight: 900; color: #111827; letter-spacing: -0.3px; }
  .doc-sub { font-size: 9px; color: #9ca3af; margin-top: 3px; }

  /* ── INFO BANNER ── */
  .info-banner {
    background: linear-gradient(135deg, #f0fdf4 0%, #ecfdf5 100%);
    border: 1px solid #bbf7d0;
    border-radius: 10px;
    padding: 14px 18px;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px 24px;
    margin-bottom: 18px;
  }
  .info-banner.with-contract { grid-template-columns: 1fr 1fr; }
  .info-field { display: flex; flex-direction: column; gap: 1px; }
  .info-field-label { font-size: 8px; font-weight: 700; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px; }
  .info-field-value { font-size: 11px; font-weight: 700; color: #111827; }
  .info-field-value.highlight { color: #15803d; font-size: 12px; }
  .info-sep { border-left: 1px solid #bbf7d0; }

  /* ── SUMMARY STRIP ── */
  .sum-strip {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 10px;
    margin-bottom: 20px;
  }
  .sum-strip.two { grid-template-columns: repeat(2, 1fr); }
  .sum-strip.three { grid-template-columns: repeat(3, 1fr); }
  .sum-card {
    border-radius: 10px;
    border: 1.5px solid #e5e7eb;
    padding: 14px 12px;
    text-align: center;
    background: #fafafa;
  }
  .sum-primary {
    background: linear-gradient(135deg, #15803d 0%, #16a34a 100%);
    border-color: #15803d;
  }
  .sum-label {
    font-size: 8px;
    font-weight: 700;
    color: #9ca3af;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    margin-bottom: 6px;
  }
  .sum-primary .sum-label { color: #bbf7d0; }
  .sum-value {
    font-size: 20px;
    font-weight: 900;
    color: #15803d;
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.5px;
  }
  .sum-primary .sum-value { color: #fff; font-size: 22px; }

  /* ── SECTION HEADER ── */
  .sec-title {
    font-size: 9px;
    font-weight: 800;
    color: #fff;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    padding: 5px 12px;
    border-radius: 6px 6px 0 0;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .sec-title span { font-weight: 400; opacity: 0.8; }
  .bg-green { background: #15803d; }
  .bg-slate { background: #334155; }
  .bg-blue { background: #1d4ed8; }
  .bg-amber { background: #b45309; }

  /* ── TABLES ── */
  .section { margin-bottom: 16px; }
  table.data {
    width: 100%;
    border-collapse: collapse;
    font-size: 10px;
    border: 1px solid #e5e7eb;
    border-top: none;
    border-radius: 0 0 6px 6px;
    overflow: hidden;
  }
  table.data th {
    background: #f8fafc;
    font-weight: 700;
    font-size: 8px;
    text-transform: uppercase;
    color: #6b7280;
    padding: 5px 12px;
    border-bottom: 1px solid #e5e7eb;
    text-align: left;
    letter-spacing: 0.3px;
  }
  table.data td {
    padding: 5px 12px;
    border-bottom: 1px solid #f1f5f9;
    color: #374151;
    vertical-align: middle;
  }
  table.data tr:last-child td { border-bottom: none; }
  table.data tr:hover td { background: #fafafa; }
  .money {
    text-align: right;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    color: #1a1a2e;
  }
  .applied { font-weight: 600; color: #374151; }
  .total-row td {
    background: #f0fdf4 !important;
    font-weight: 800;
    color: #15803d !important;
    border-top: 1.5px solid #86efac !important;
    font-size: 11px;
  }
  .total-row .money { color: #15803d !important; }
  a { color: #1d4ed8; text-decoration: none; }

  /* ── TWO COLS ── */
  .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 16px; }

  /* ── CONTRACT SECTION ── */
  .contract-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0;
    border: 1px solid #e5e7eb;
    border-top: none;
    border-radius: 0 0 6px 6px;
    overflow: hidden;
  }
  .contract-field {
    padding: 5px 12px;
    border-bottom: 1px solid #f1f5f9;
    border-right: 1px solid #f1f5f9;
  }
  .contract-field:nth-child(even) { border-right: none; }
  .cf-label { font-size: 8px; font-weight: 600; color: #9ca3af; text-transform: uppercase; letter-spacing: 0.3px; }
  .cf-value { font-size: 10.5px; font-weight: 700; color: #111827; margin-top: 1px; }

  /* ── DISCLAIMER ── */
  .disclaimer {
    background: #fffbeb;
    border-left: 3px solid #f59e0b;
    border-radius: 0 5px 5px 0;
    padding: 8px 12px;
    font-size: 8.5px;
    color: #92400e;
    margin-bottom: 14px;
    line-height: 1.5;
  }

  /* ── SPACER ── */
  .spacer { flex: 1; }

  /* ── FOOTER ── */
  .footer {
    border-top: 1px solid #e5e7eb;
    padding-top: 8px;
    font-size: 8px;
    color: #9ca3af;
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-top: 10px;
  }
  .footer-badge {
    background: #f0fdf4;
    border: 1px solid #bbf7d0;
    border-radius: 4px;
    padding: 2px 8px;
    font-size: 7.5px;
    font-weight: 700;
    color: #15803d;
  }
</style>
</head>
<body>
<div class="page">

  <!-- HEADER -->
  <div class="header">
    <div class="header-left">
      ${logo ? `<img src="${logo}" class="logo" alt="MPR"/>` : ''}
      <div>
        <div class="app-name">MPR Negócios</div>
        <div class="app-sub">Centro de Simulação</div>
      </div>
    </div>
    <div class="header-right">
      <div class="header-date">${dateStr}</div>
      <div class="header-ver">${result.version?.id || ''}</div>
    </div>
  </div>

  <!-- TÍTULO -->
  <div class="doc-title-row">
    <div class="doc-title">${result.title || 'Simulação'}</div>
    <div class="doc-sub">Simulação meramente indicativa. Deve ser confirmada com técnico laboral antes de ser comunicada ao cliente.</div>
  </div>

  <!-- INFO BANNER -->
  <div class="info-banner">
    <div class="info-field">
      <div class="info-field-label">Empresa</div>
      <div class="info-field-value highlight">${customer?.company || customer?.name || '—'}</div>
    </div>
    <div class="info-field">
      <div class="info-field-label">NIF</div>
      <div class="info-field-value">${customer?.nif || '—'}</div>
    </div>
    <div class="info-field">
      <div class="info-field-label">Funcionário</div>
      <div class="info-field-value">${employeeName || '—'}</div>
    </div>
    <div class="info-field">
      <div class="info-field-label">Email</div>
      <div class="info-field-value">${customer?.email || '—'}</div>
    </div>
  </div>

  <!-- SUMMARY STRIP -->
  <div class="sum-strip ${(result.summary || []).length === 2 ? 'two' : (result.summary || []).length === 3 ? 'three' : ''}">
    ${summaryCards}
  </div>

  ${actRows ? `
  <!-- ACT OFICIAL -->
  <div class="section">
    <div class="sec-title bg-blue">Resultado Oficial — Calculadora ACT
      <span>Lido em ${fmtDate(actValidation.computedAt)}</span>
    </div>
    <table class="data">
      <thead><tr><th style="width:70%">Rubrica</th><th style="text-align:right">Valor</th></tr></thead>
      <tbody>${actRows}</tbody>
    </table>
  </div>` : ''}

  ${contractFields.length ? `
  <!-- DADOS DO CONTRATO -->
  <div class="section">
    <div class="sec-title bg-slate">Dados do contrato de trabalho</div>
    <div class="contract-grid">
      ${contractFields.map(([l, v]) => `
        <div class="contract-field">
          <div class="cf-label">${l}</div>
          <div class="cf-value">${v}</div>
        </div>`).join('')}
    </div>
  </div>` : ''}

  <!-- DETALHE + PRESSUPOSTOS -->
  <div class="two-col">
    <div class="section" style="margin-bottom:0">
      <div class="sec-title bg-green">Detalhe do cálculo</div>
      <table class="data">
        <thead><tr><th>Rubrica</th><th style="text-align:right">Valor</th></tr></thead>
        <tbody>${detailRows}</tbody>
      </table>
    </div>
    <div class="section" style="margin-bottom:0">
      <div class="sec-title bg-slate">Pressupostos e fontes</div>
      <table class="data">
        <thead><tr><th>Regra</th><th>Valor aplicado</th><th>Fonte</th></tr></thead>
        <tbody>${basisRows}</tbody>
      </table>
    </div>
  </div>

  ${warnings ? `<div class="disclaimer">${warnings}</div>` : ''}

  <div class="spacer"></div>

  <!-- FOOTER -->
  <div class="footer">
    <span>MPR Negócios · Centro de Simulação · ${dateStr}</span>
    <div class="footer-badge">Versão ${result.version?.id || '—'} · válida desde ${result.version?.validFrom || '—'}</div>
  </div>

</div>
</body>
</html>`;
}

function buildCarBenefitHtml(data) {
  const { result, customer, employeeName, generatedAt } = data;
  const logo    = logoBase64();
  const dateStr = new Date(generatedAt || Date.now()).toLocaleString('pt-PT');
  const d       = result.details || [];

  function val(label) {
    const row = d.find(r => String(r.label).includes(label));
    return row != null ? (typeof row.value === 'number' ? fmt(row.value) : String(row.value)) : '—';
  }

  // ── Summary cards ──
  const summaryCards = (result.summary || []).map((line, i) => `
    <div class="sum-card ${i === 0 ? 'sum-primary' : ''}">
      <div class="sum-label">${line.label}</div>
      <div class="sum-value">${fmt(line.value)}</div>
    </div>`).join('');

  // ── Veículo info row ──
  const vehicleRow = d.find(r => r.label === 'Veículo');
  const vehicleDesc = vehicleRow ? String(vehicleRow.value) : '—';

  // ── Monthly + Annual table (2 colunas) ──
  const calcRows = [
    ['Benefício bruto',                'Benefício bruto mensal',      'Benefício tributável anual', true ],
    ['Contribuição trabalhador',       'Contribuição mensal trabalhador', null,                     false],
    ['Benefício tributável',           'Benefício tributável mensal', 'Benefício tributável anual', false],
    ['SS trabalhador',                 'SS trabalhador (mensal)',     'SS trabalhador anual',       false],
    ['SS entidade patronal',           null,                          'SS entidade patronal anual', false],
    ['Retenção IRS',                   'Retenção IRS adicional (mensal)', 'Retenção IRS anual',     false],
    ['Custo líquido trabalhador',      'Custo líquido mensal trabalhador', 'Custo líquido anual trabalhador', true],
  ];

  function getVal(labelHint) {
    if (!labelHint) return '—';
    const row = d.find(r => String(r.label).includes(labelHint));
    if (!row) return '—';
    return typeof row.value === 'number' ? fmt(row.value) : String(row.value);
  }

  const calcRowsHtml = calcRows.map(([label, mLabel, aLabel, bold]) => `
    <tr${bold ? ' class="total-row"' : ''}>
      <td>${label}</td>
      <td class="money">${mLabel ? getVal(mLabel) : '—'}</td>
      <td class="money">${aLabel ? getVal(aLabel) : '—'}</td>
    </tr>`).join('');

  // ── Sources ──
  const basisRows = (result.basis || []).map(b => `
    <tr>
      <td>${b.label}</td>
      <td>${b.value}</td>
      <td><a href="${b.sourceUrl}">${b.sourceLabel}</a></td>
    </tr>`).join('');

  const warnings = (result.warnings || []).map(w => `<p>${w}</p>`).join('');
  const months   = result.assumptions?.find(a => a.includes('Meses'))?.replace('Meses de atribuição considerados: ', '') || '12';

  return `<!DOCTYPE html>
<html lang="pt">
<head><meta charset="UTF-8"/>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 10.5px; color: #1a1a2e; background: #fff; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  /* altura exacta = A4 menos margens do Playwright (12mm topo + 12mm base) */
  .page { padding: 14px 20px; max-width: 210mm; margin: 0 auto; height: calc(297mm - 24mm); display: flex; flex-direction: column; overflow: hidden; }

  .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; padding-bottom: 9px; border-bottom: 3px solid #16a34a; flex-shrink: 0; }
  .header-left { display: flex; align-items: center; gap: 10px; }
  .logo { height: 32px; object-fit: contain; }
  .app-name { font-size: 17px; font-weight: 900; color: #15803d; letter-spacing: -.3px; }
  .app-sub { font-size: 8.5px; color: #6b7280; margin-top: 1px; }
  .header-date { font-size: 11px; font-weight: 700; color: #374151; text-align: right; }
  .header-ver { font-size: 8.5px; color: #9ca3af; text-align: right; margin-top: 2px; }

  .doc-title { font-size: 16px; font-weight: 900; color: #111827; margin-bottom: 2px; letter-spacing: -.3px; flex-shrink: 0; }
  .doc-sub { font-size: 8.5px; color: #9ca3af; margin-bottom: 11px; flex-shrink: 0; }

  .info-banner { background: linear-gradient(135deg, #f0fdf4, #ecfdf5); border: 1px solid #bbf7d0; border-radius: 8px; padding: 10px 14px; display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 5px 18px; margin-bottom: 11px; flex-shrink: 0; }
  .if-label { font-size: 8px; font-weight: 700; color: #6b7280; text-transform: uppercase; letter-spacing: .4px; }
  .if-value { font-size: 11px; font-weight: 700; color: #111827; margin-top: 1px; }
  .if-value.hi { color: #15803d; font-size: 12px; }

  .vehicle-row { background: #f8fafc; border: 1px solid #e5e7eb; border-radius: 7px; padding: 8px 12px; margin-bottom: 11px; display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
  .vehicle-label { color: #6b7280; font-size: 8.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .3px; }
  .vehicle-desc { font-weight: 700; color: #111827; font-size: 11px; }

  .sum-strip { display: grid; grid-template-columns: repeat(4, 1fr); gap: 9px; margin-bottom: 13px; flex-shrink: 0; }
  .sum-card { border-radius: 9px; border: 1.5px solid #e5e7eb; padding: 12px 8px; text-align: center; background: #fafafa; }
  .sum-primary { background: linear-gradient(135deg, #15803d, #16a34a); border-color: #15803d; }
  .sum-label { font-size: 8px; font-weight: 700; color: #9ca3af; text-transform: uppercase; letter-spacing: .3px; margin-bottom: 4px; }
  .sum-primary .sum-label { color: #bbf7d0; }
  .sum-value { font-size: 18px; font-weight: 900; color: #15803d; font-variant-numeric: tabular-nums; }
  .sum-primary .sum-value { color: #fff; font-size: 20px; }

  .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 10px; flex: 1; min-height: 0; }
  .two-col > div { display: flex; flex-direction: column; min-height: 0; }

  .sec-title { font-size: 9px; font-weight: 800; color: #fff; padding: 5px 10px; border-radius: 5px 5px 0 0; text-transform: uppercase; letter-spacing: .4px; -webkit-print-color-adjust: exact; print-color-adjust: exact; flex-shrink: 0; }
  .bg-green { background: #15803d; }
  .bg-slate { background: #334155; }

  table.data { width: 100%; border-collapse: collapse; font-size: 10px; border: 1px solid #e5e7eb; border-top: none; }
  table.data th { background: #f8fafc; font-weight: 700; font-size: 8px; text-transform: uppercase; color: #6b7280; padding: 5px 10px; border-bottom: 1px solid #e5e7eb; text-align: left; }
  table.data td { padding: 5px 10px; border-bottom: 1px solid #f3f4f6; color: #374151; }
  table.data tr:last-child td { border-bottom: none; }
  .money { text-align: right; font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .total-row td { background: #f0fdf4 !important; font-weight: 800; color: #15803d !important; border-top: 1.5px solid #86efac !important; font-size: 10.5px; }
  a { color: #1d4ed8; text-decoration: none; font-size: 9px; }

  .disclaimer { background: #fffbeb; border-left: 3px solid #f59e0b; border-radius: 0 5px 5px 0; padding: 7px 11px; font-size: 8.5px; color: #92400e; margin-bottom: 0; line-height: 1.5; flex-shrink: 0; }
  .footer { border-top: 1px solid #e5e7eb; padding-top: 7px; font-size: 8px; color: #9ca3af; display: flex; justify-content: space-between; align-items: center; margin-top: 8px; flex-shrink: 0; }
  .footer-badge { background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 4px; padding: 2px 8px; font-size: 7.5px; font-weight: 700; color: #15803d; }
</style>
</head>
<body>
<div class="page">

  <!-- HEADER -->
  <div class="header">
    <div class="header-left">
      ${logo ? `<img src="${logo}" class="logo" alt="MPR"/>` : ''}
      <div><div class="app-name">MPR Negócios</div><div class="app-sub">Centro de Simulação</div></div>
    </div>
    <div><div class="header-date">${dateStr}</div><div class="header-ver">${result.version?.id || ''}</div></div>
  </div>

  <!-- TÍTULO -->
  <div class="doc-title">${result.title || 'Viatura Empresa'}</div>
  <div class="doc-sub">Simulação meramente indicativa. Confirmar com técnico laboral antes de ser comunicada ao cliente.</div>

  <!-- INFO BANNER -->
  <div class="info-banner">
    <div><div class="if-label">Empresa</div><div class="if-value hi">${customer?.company || customer?.name || '—'}</div></div>
    <div><div class="if-label">NIF</div><div class="if-value">${customer?.nif || '—'}</div></div>
    <div><div class="if-label">Funcionário</div><div class="if-value">${employeeName || '—'}</div></div>
    <div><div class="if-label">Email</div><div class="if-value">${customer?.email || '—'}</div></div>
  </div>

  <!-- VIATURA -->
  <div class="vehicle-row">
    <span class="vehicle-label">Viatura:</span>
    <span class="vehicle-desc">${vehicleDesc}</span>
  </div>

  <!-- SUMMARY STRIP -->
  <div class="sum-strip">${summaryCards}</div>

  <!-- DETALHE + FONTES -->
  <div class="two-col">
    <div>
      <div class="sec-title bg-green">Detalhe do cálculo</div>
      <table class="data">
        <thead><tr><th>Rubrica</th><th style="text-align:right">Mensal</th><th style="text-align:right">Anual (${months}m)</th></tr></thead>
        <tbody>${calcRowsHtml}</tbody>
      </table>
    </div>
    <div>
      <div class="sec-title bg-slate">Pressupostos e fontes</div>
      <table class="data">
        <thead><tr><th>Regra</th><th>Valor aplicado</th><th>Fonte</th></tr></thead>
        <tbody>${basisRows}</tbody>
      </table>
    </div>
  </div>

  ${warnings ? `<div class="disclaimer">${warnings}</div>` : ''}
  <div class="spacer"></div>
  <div class="footer">
    <span>MPR Negócios · Centro de Simulação · ${dateStr}</span>
    <div class="footer-badge">Versão ${result.version?.id || '—'} · válida desde ${result.version?.validFrom || '—'}</div>
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
    const sid = data.result?.simulatorId;
    const html = sid === 'loan' ? buildLoanHtml(data) : sid === 'car-benefit' ? buildCarBenefitHtml(data) : buildHtml(data);
    await page.setContent(html, { waitUntil: 'load' });
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '12mm', bottom: '12mm', left: '12mm', right: '12mm' },
    });
    return pdfBuffer;
  } finally {
    await browser.close().catch(() => null);
  }
}

module.exports = { generateSimulatorPdf };
