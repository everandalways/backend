import { Logger, ScheduledTask, TransactionalConnection } from '@vendure/core';
import { checkJobHealth, formatReport } from './job-health';

const loggerCtx = 'JobHealthAlert';

/**
 * Where to shout. A Slack or Discord incoming-webhook URL; both accept
 * `{"text": "..."}`. Free, and — importantly — NOT email, because email failing
 * is the main thing this watches for.
 *
 * With no webhook configured it still logs at error level, so a Railway log
 * alert or a manual glance will show it.
 */
const WEBHOOK = process.env.ALERT_WEBHOOK_URL?.trim();
/** Don't re-send the same alert more often than this. */
const REALERT_HOURS = Number(process.env.ALERT_REALERT_HOURS ?? 6);

/** In-memory, so a restart re-alerts. That is the safer direction to fail. */
let lastAlertAt = 0;
let lastWasHealthy = true;

async function notify(text: string): Promise<void> {
    if (!WEBHOOK) {
        Logger.error(
            `${text}\n(Set ALERT_WEBHOOK_URL to a Slack/Discord webhook to be notified automatically.)`,
            loggerCtx,
        );
        return;
    }
    try {
        const res = await fetch(WEBHOOK, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text }),
        });
        if (!res.ok) {
            Logger.error(`Alert webhook returned ${res.status}. Alert text follows:\n${text}`, loggerCtx);
        }
    } catch (e: any) {
        Logger.error(`Alert webhook failed (${e.message}). Alert text follows:\n${text}`, loggerCtx);
    }
}

/**
 * Watches the job queues and shouts when something is wrong.
 *
 * Runs inside the existing worker on the scheduler that is already configured,
 * so it costs nothing extra — no Redis, no additional Railway service.
 *
 * It exists because the technical faults found during the pre-production review
 * were ordinary, but one of them (email) ran for two months without anyone
 * noticing. Absence of monitoring was the actual defect.
 */
export const jobHealthAlertTask = new ScheduledTask({
    id: 'job-health-alert',
    description: 'Checks the job queues and sends an alert when they are unhealthy.',
    schedule: cronTime => cronTime.every(30).minutes(),
    timeout: '2m',
    async execute({ injector }) {
        const connection = injector.get(TransactionalConnection);
        const report = await checkJobHealth((sql, params) =>
            connection.rawConnection.query(sql, params as any[]),
        );

        if (report.healthy) {
            if (!lastWasHealthy) {
                await notify(`✅ Vendure health check has recovered.\n\n${formatReport(report)}`);
                Logger.info('Job queues recovered.', loggerCtx);
            }
            lastWasHealthy = true;
            return { healthy: true, queues: report.queues.length };
        }

        const sinceLast = (Date.now() - lastAlertAt) / 3_600_000;
        const shouldAlert = lastWasHealthy || sinceLast >= REALERT_HOURS;
        lastWasHealthy = false;

        if (shouldAlert) {
            lastAlertAt = Date.now();
            await notify(`🔴 Vendure health check is UNHEALTHY.\n\n${formatReport(report)}`);
        }
        Logger.warn(`Job queues unhealthy: ${report.problems.join(' | ')}`, loggerCtx);

        return { healthy: false, problems: report.problems, alerted: shouldAlert };
    },
});
