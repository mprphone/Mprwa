'use strict';

/**
 * Search, Dashboard metrics, Alerts & Audit log routes.
 * Extracted from localDataRoutes.js for maintainability.
 */
function registerAnalyticsRoutes(context) {
    const {
        app, dbRunAsync, dbGetAsync, dbAllAsync,
        nowIso,
    } = context;

    app.get('/api/search/global', async (req, res) => {
        try {
            const term = String(req.query.q || '').trim();
            if (!term) {
                return res.json({ success: true, term, customers: [], messages: [], tasks: [] });
            }

            const likeTerm = `%${term.replace(/[%_]/g, '')}%`;
            const customers = await dbAllAsync(
                `SELECT id, name, company, phone, email, nif, niss
                 FROM customers
                 WHERE name LIKE ? OR company LIKE ? OR phone LIKE ? OR email LIKE ? OR nif LIKE ? OR niss LIKE ?
                 ORDER BY datetime(updated_at) DESC
                 LIMIT 30`,
                [likeTerm, likeTerm, likeTerm, likeTerm, likeTerm, likeTerm]
            );
            const messages = await dbAllAsync(
                `SELECT id, from_number, body, direction, timestamp
                 FROM messages
                 WHERE body LIKE ? OR from_number LIKE ?
                 ORDER BY id DESC
                 LIMIT 40`,
                [likeTerm, likeTerm]
            );
            const tasks = await dbAllAsync(
                `SELECT id, conversation_id, title, status, priority, due_date
                 FROM tasks
                 WHERE title LIKE ? OR notes LIKE ?
                 ORDER BY datetime(updated_at) DESC
                 LIMIT 30`,
                [likeTerm, likeTerm]
            );

            return res.json({
                success: true,
                term,
                customers,
                messages,
                tasks,
            });
        } catch (error) {
            const details = error?.message || error;
            console.error('[Search] Erro:', details);
            return res.status(500).json({ success: false, error: details });
        }
    });

    app.get('/api/dashboard/metrics', async (req, res) => {
        try {
            const [conversationStats] = await dbAllAsync(
                `SELECT
                    COUNT(*) as total,
                    SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) as open_count,
                    SUM(CASE WHEN status = 'waiting' THEN 1 ELSE 0 END) as waiting_count,
                    SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) as closed_count
                 FROM conversations`
            );

            const [tasksStats] = await dbAllAsync(
                `SELECT
                    SUM(CASE WHEN status != 'done' THEN 1 ELSE 0 END) as pending_tasks,
                    SUM(CASE WHEN status != 'done' AND datetime(due_date) < datetime('now') THEN 1 ELSE 0 END) as overdue_tasks
                 FROM tasks`
            );

            const [slaRow] = await dbAllAsync(
                `SELECT AVG(delta_minutes) as avg_response_minutes
                 FROM (
                    SELECT (
                        (julianday(o.timestamp) - julianday(i.timestamp)) * 24.0 * 60.0
                    ) as delta_minutes
                    FROM messages i
                    JOIN messages o ON o.from_number = i.from_number
                     AND o.direction = 'outbound'
                     AND o.id = (
                        SELECT MIN(o2.id)
                        FROM messages o2
                        WHERE o2.from_number = i.from_number
                          AND o2.direction = 'outbound'
                          AND o2.id > i.id
                     )
                    WHERE i.direction = 'inbound'
                 )`
            );

            const byAgent = await dbAllAsync(
                `SELECT
                    COALESCE(u.name, 'Não atribuído') as agent_name,
                    c.owner_id as owner_id,
                    COUNT(*) as total,
                    SUM(CASE WHEN c.status != 'closed' THEN 1 ELSE 0 END) as active
                 FROM conversations c
                 LEFT JOIN users u ON u.id = c.owner_id
                 GROUP BY c.owner_id, u.name
                 ORDER BY active DESC, total DESC`
            );

            return res.json({
                success: true,
                metrics: {
                    totalConversations: Number(conversationStats?.total || 0),
                    openConversations: Number(conversationStats?.open_count || 0),
                    waitingConversations: Number(conversationStats?.waiting_count || 0),
                    closedConversations: Number(conversationStats?.closed_count || 0),
                    pendingTasks: Number(tasksStats?.pending_tasks || 0),
                    overdueTasks: Number(tasksStats?.overdue_tasks || 0),
                    avgResponseMinutes: Number(slaRow?.avg_response_minutes || 0),
                },
                byAgent: byAgent.map((row) => ({
                    ownerId: row.owner_id || null,
                    agentName: row.agent_name || 'Não atribuído',
                    total: Number(row.total || 0),
                    active: Number(row.active || 0),
                })),
            });
        } catch (error) {
            const details = error?.message || error;
            console.error('[Dashboard] Erro métricas:', details);
            return res.status(500).json({ success: false, error: details });
        }
    });

    app.get('/api/alerts', async (req, res) => {
        try {
            const hoursParam = Number(req.query.unansweredHours || 6);
            const unansweredHours = Number.isFinite(hoursParam) && hoursParam > 0 ? hoursParam : 6;

            const overdueTasks = await dbAllAsync(
                `SELECT t.id, t.title, t.due_date, t.priority, t.status, c.name as customer_name
                 FROM tasks t
                 LEFT JOIN conversations cv ON cv.id = t.conversation_id
                 LEFT JOIN customers c ON c.id = cv.customer_id
                 WHERE t.status != 'done'
                   AND datetime(t.due_date) < datetime('now')
                 ORDER BY datetime(t.due_date) ASC
                 LIMIT 50`
            );

            const unansweredRows = await dbAllAsync(
                `SELECT
                    cv.id as conversation_id,
                    cv.status,
                    cu.id as customer_id,
                    cu.name as customer_name,
                    cu.phone as phone,
                    MAX(CASE WHEN m.direction = 'inbound' THEN m.timestamp END) as last_inbound_at,
                    MAX(CASE WHEN m.direction = 'outbound' THEN m.timestamp END) as last_outbound_at
                 FROM conversations cv
                 JOIN customers cu ON cu.id = cv.customer_id
                 LEFT JOIN messages m ON replace(replace(cu.phone, '+', ''), ' ', '') = m.from_number
                 GROUP BY cv.id, cv.status, cu.id, cu.name, cu.phone`
            );

            const unanswered = unansweredRows.filter((row) => {
                if (!row.last_inbound_at) return false;
                const lastInbound = new Date(row.last_inbound_at).getTime();
                if (!Number.isFinite(lastInbound)) return false;

                const threshold = Date.now() - unansweredHours * 60 * 60 * 1000;
                if (lastInbound > threshold) return false;

                const lastOutbound = row.last_outbound_at ? new Date(row.last_outbound_at).getTime() : 0;
                return !lastOutbound || lastOutbound < lastInbound;
            });

            return res.json({
                success: true,
                config: {
                    unansweredHours,
                },
                overdueTasks,
                unansweredConversations: unanswered,
            });
        } catch (error) {
            const details = error?.message || error;
            console.error('[Alerts] Erro:', details);
            return res.status(500).json({ success: false, error: details });
        }
    });

    app.get('/api/audit/logs', async (req, res) => {
        try {
            const requestedLimit = Number(req.query.limit || 100);
            const limit = Math.min(500, Math.max(1, Number.isFinite(requestedLimit) ? requestedLimit : 100));
            const rows = await dbAllAsync(
                `SELECT id, actor_user_id, entity_type, entity_id, action, details_json, created_at
                 FROM audit_logs
                 ORDER BY id DESC
                 LIMIT ?`,
                [limit]
            );
            const data = rows.map((row) => {
                let details = null;
                if (row.details_json) {
                    try {
                        details = JSON.parse(row.details_json);
                    } catch (error) {
                        details = row.details_json;
                    }
                }
                return {
                    id: row.id,
                    actorUserId: row.actor_user_id || null,
                    entityType: row.entity_type,
                    entityId: row.entity_id || null,
                    action: row.action,
                    details,
                    createdAt: row.created_at,
                };
            });
            return res.json({ success: true, data });
        } catch (error) {
            const details = error?.message || error;
            console.error('[Audit] Erro ao listar logs:', details);
            return res.status(500).json({ success: false, error: details });
        }
    });
}

module.exports = { registerAnalyticsRoutes };
