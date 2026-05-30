'use strict';

const {
  validateActCompensationWithOfficialSimulator,
} = require('../services/actCompensationOfficialService');
const { validateSalaryWithDoutorFinancas } = require('../services/salaryOfficialService');
const { generateSimulatorPdf } = require('../services/simulatorPdfService');

const crypto = require('crypto');

function registerSimulatorRoutes(context) {
  const { app, dbRunAsync, dbAllAsync, hasEmailProvider, sendEmailWithAttachment } = context;

  // pixel de rastreio de leitura
  app.get('/api/simulators/email-track/:token', async (req, res) => {
    const { token } = req.params;
    try {
      await dbRunAsync(
        `UPDATE simulator_history SET email_read_at = datetime('now') WHERE email_token = ? AND email_read_at IS NULL`,
        [token]
      );
    } catch (_) {}
    // devolver um pixel 1x1 transparente
    const pixel = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
    res.setHeader('Content-Type', 'image/gif');
    res.setHeader('Cache-Control', 'no-store');
    res.send(pixel);
  });

  // enviar simulação por email ao cliente
  app.post('/api/simulators/send-email', async (req, res) => {
    try {
      const { simId, toEmail, toName, pdfData, employeeName } = req.body || {};
      if (!simId || !toEmail) return res.status(400).json({ success: false, error: 'simId e toEmail obrigatórios' });

      if (!hasEmailProvider || !hasEmailProvider()) {
        return res.status(503).json({ success: false, error: 'Email não configurado no servidor.' });
      }

      const token = crypto.randomBytes(16).toString('hex');
      const trackUrl = `${process.env.APP_BASE_URL || 'https://wa.mpr.pt'}/api/simulators/email-track/${token}`;

      // gerar PDF (pdfData vem em base64 do frontend)
      const pdfBuffer = pdfData ? Buffer.from(pdfData, 'base64') : null;

      const htmlBody = `
        <div style="font-family:Arial,sans-serif;font-size:14px;color:#1a1a1a;max-width:600px">
          <img src="https://wa.mpr.pt/Logo.png" alt="MPR Negócios" style="height:36px;margin-bottom:16px"/>
          <h2 style="color:#15803d;margin:0 0 8px">Simulação de Compensações</h2>
          <p>Exmo(a) Sr(a) ${toName || ''},</p>
          <p>Segue em anexo a simulação de compensações por cessação de contrato elaborada pela <strong>MPR Negócios</strong>.</p>
          <p style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;padding:12px;font-size:13px;color:#166534">
            Este documento é meramente indicativo e deve ser confirmado com um técnico laboral antes de qualquer comunicação formal.
          </p>
          <p>Para qualquer esclarecimento, não hesite em contactar-nos.</p>
          <p>Com os melhores cumprimentos,<br/><strong>MPR Negócios</strong></p>
          <img src="${trackUrl}" width="1" height="1" style="display:none" alt=""/>
        </div>`;

      await sendEmailWithAttachment({
        to: toEmail,
        subject: `MPR Negócios — Simulação de Compensações ACT`,
        html: htmlBody,
        fromName: 'MPR Negócios, Lda',
        attachments: pdfBuffer ? [{ filename: 'simulacao-act.pdf', content: pdfBuffer, contentType: 'application/pdf' }] : [],
      });

      await dbRunAsync(
        `UPDATE simulator_history SET email_sent_to = ?, email_sent_at = datetime('now'), email_token = ?, email_read_at = NULL WHERE id = ?`,
        [toEmail, token, simId]
      );

      // reflectir no histórico devolvido
      const row = await dbAllAsync('SELECT * FROM simulator_history WHERE id = ?', [simId]);
      return res.json({ success: true, sentAt: row[0]?.email_sent_at });
    } catch (error) {
      console.error('[Simuladores] Email send failed:', error.message);
      return res.status(502).json({ success: false, error: String(error.message) });
    }
  });

  // estado de email de uma simulação
  app.get('/api/simulators/history/:id/email-status', async (req, res) => {
    try {
      const rows = await dbAllAsync(
        'SELECT email_sent_to, email_sent_at, email_read_at FROM simulator_history WHERE id = ?',
        [req.params.id]
      );
      if (!rows.length) return res.status(404).json({ success: false });
      return res.json({ success: true, ...rows[0] });
    } catch (error) {
      return res.status(500).json({ success: false, error: String(error.message) });
    }
  });

  // histórico de simulações — partilhado entre todos os utilizadores
  app.get('/api/simulators/history', async (req, res) => {
    try {
      const rows = await dbAllAsync(
        'SELECT id, customer_name, customer_id, customer_nif, employee_name, simulator_id, result_json, saved_at, email_sent_to, email_sent_at, email_read_at FROM simulator_history ORDER BY saved_at DESC LIMIT 50'
      );
      const items = rows.map((r) => {
        const parsed = JSON.parse(r.result_json);
        const { _actInput, ...result } = parsed;
        return {
          id: r.id,
          customerName: r.customer_name,
          customerId: r.customer_id || undefined,
          customerNif: r.customer_nif || undefined,
          employeeName: r.employee_name || undefined,
          savedAt: r.saved_at,
          emailSentTo: r.email_sent_to || undefined,
          emailSentAt: r.email_sent_at || undefined,
          emailReadAt: r.email_read_at || undefined,
          result,
          actInput: _actInput || undefined,
        };
      });
      return res.json({ success: true, items });
    } catch (error) {
      return res.status(500).json({ success: false, error: String(error.message) });
    }
  });

  app.post('/api/simulators/history', async (req, res) => {
    try {
      const { id, customerName, customerId, customerNif, employeeName, result, actInput } = req.body || {};
      if (!id || !result) return res.status(400).json({ success: false, error: 'id e result são obrigatórios' });
      // Guardar actInput dentro do result_json para não precisar de migração da BD
      const resultToStore = actInput ? { ...result, _actInput: actInput } : result;
      await dbRunAsync(
        `INSERT INTO simulator_history (id, customer_name, customer_id, customer_nif, employee_name, simulator_id, result_json, saved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(id) DO UPDATE SET result_json=excluded.result_json, employee_name=excluded.employee_name, saved_at=excluded.saved_at`,
        [id, customerName || '', customerId || null, customerNif || null, employeeName || null, result.simulatorId || '', JSON.stringify(resultToStore)]
      );
      return res.json({ success: true });
    } catch (error) {
      return res.status(500).json({ success: false, error: String(error.message) });
    }
  });

  app.delete('/api/simulators/history/:id', async (req, res) => {
    try {
      await dbRunAsync('DELETE FROM simulator_history WHERE id = ?', [req.params.id]);
      return res.json({ success: true });
    } catch (error) {
      return res.status(500).json({ success: false, error: String(error.message) });
    }
  });

  app.post('/api/simulators/export-pdf', async (req, res) => {
    try {
      const pdfBuffer = await generateSimulatorPdf(req.body || {});
      const filename = `simulacao-${Date.now()}.pdf`;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.send(pdfBuffer);
    } catch (error) {
      console.error('[Simuladores] PDF generation failed:', error.message);
      return res.status(502).json({ success: false, error: String(error.message) });
    }
  });

  app.post('/api/simulators/salary/validate-official', async (req, res) => {
    try {
      const input = req.body?.input || req.body || {};
      const result = await validateSalaryWithDoutorFinancas(input);
      return res.json(result);
    } catch (error) {
      const details = String(error?.message || error || 'Falha ao validar no Doutor Finanças.');
      console.error('[Simuladores] Salary validation failed:', details);
      return res.status(502).json({ success: false, error: details });
    }
  });

  app.post('/api/simulators/act-compensation/validate-official', async (req, res) => {
    try {
      const input = req.body?.input || req.body || {};
      const result = await validateActCompensationWithOfficialSimulator(input, {
        headless: req.body?.headless !== false,
      });
      return res.json(result);
    } catch (error) {
      const details = String(error?.message || error || 'Falha ao validar no simulador ACT.');
      console.error('[Simuladores] ACT validation failed:', details);
      return res.status(502).json({
        success: false,
        error: details,
      });
    }
  });
}

module.exports = { registerSimulatorRoutes };
