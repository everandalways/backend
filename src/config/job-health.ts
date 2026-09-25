/**
 * Shared job-queue health checks.
 *
 * Used by both `npm run check:jobs` (ad hoc / CI) and the
 * `job-health-alert` scheduled task, so the two can never disagree about what
 * "unhealthy" means.
 *
 * Takes a plain query function so the caller decides how to reach the database —
 * a standalone DataSource for the script, the in-process connection for the task.
 */

export type QueryFn = <T = any>(sql: string, params?: unknown[]) => Promise<T[]>;

/** A job still RUNNING this long after starting is almost certainly orphaned. */
export const STUCK_AFTER_MINUTES = Number(process.env.JOB_STUCK_AFTER_MINUTES ?? 15);
/** Window for the failure-rate checks. */
export const WINDOW_HOURS = Number(process.env.JOB_WINDOW_HOURS ?? 24);
/** Alert if no email has succeeded in this long. */
export const EMAIL_SILENCE_DAYS = Number(process.env.EMAIL_SILENCE_DAYS ?? 7);

export interface QueueStats {
    queueName: string;
    failed: number;
    completed: number;
    pending: number;
    failureRate: number;
}

export interface HealthReport {
    queues: QueueStats[];
    lastSuccessfulEmail: string | null;
    problems: string[];
    warnings: string[];
    healthy: boolean;
}

export async function checkJobHealth(query: QueryFn): Promise<HealthReport> {
    const problems: string[] = [];
    const warnings: string[] = [];

    // 1. Jobs wedged in RUNNING — the signature of the 2026-07/09 email outage.
    const stuck = await query<{ queueName: string; count: string; oldest: string }>(
        `SELECT "queueName", count(*)::text AS count, min("createdAt")::text AS oldest
           FROM job_record
          WHERE state = 'RUNNING' AND "startedAt" < now() - ($1 || ' minutes')::interval
          GROUP BY "queueName"`,
        [STUCK_AFTER_MINUTES],
    );
    for (const r of stuck) {
        problems.push(
            `${r.count} job(s) wedged in RUNNING on "${r.queueName}" for over ${STUCK_AFTER_MINUTES}m ` +
                `(oldest ${r.oldest}). They can never finish and make the queue look busy.`,
        );
    }

    // 2. Failure rates per queue in the recent window.
    const rows = await query<{ queueName: string; state: string; count: string }>(
        `SELECT "queueName", state, count(*)::text AS count
           FROM job_record
          WHERE "createdAt" > now() - ($1 || ' hours')::interval
          GROUP BY "queueName", state`,
        [WINDOW_HOURS],
    );
    const map = new Map<string, QueueStats>();
    for (const r of rows) {
        const e =
            map.get(r.queueName) ??
            { queueName: r.queueName, failed: 0, completed: 0, pending: 0, failureRate: 0 };
        if (r.state === 'FAILED') e.failed += Number(r.count);
        if (r.state === 'COMPLETED') e.completed += Number(r.count);
        if (r.state === 'PENDING' || r.state === 'RETRYING') e.pending += Number(r.count);
        map.set(r.queueName, e);
    }
    const queues = [...map.values()].sort((a, b) => a.queueName.localeCompare(b.queueName));
    for (const q of queues) {
        const total = q.failed + q.completed;
        q.failureRate = total ? Math.round((q.failed / total) * 100) : 0;

        if (q.queueName === 'send-email' && q.failed > 0 && q.completed === 0) {
            problems.push(
                `send-email: ${q.failed} failed and NONE succeeded in ${WINDOW_HOURS}h — email is down.`,
            );
        } else if (q.failureRate >= 50 && total >= 4) {
            problems.push(`${q.queueName}: ${q.failureRate}% of jobs failed in ${WINDOW_HOURS}h.`);
        } else if (q.failureRate >= 20 && total >= 4) {
            warnings.push(`${q.queueName}: ${q.failureRate}% of jobs failed in ${WINDOW_HOURS}h.`);
        }
        if (q.pending > 50) {
            warnings.push(`${q.queueName}: ${q.pending} jobs waiting — may not be keeping up.`);
        }
    }

    // 3. Total email silence. This alone would have caught the outage on day 8
    //    rather than day 60.
    const lastRows = await query<{ last: string | null }>(
        `SELECT max("settledAt")::text AS last FROM job_record
          WHERE "queueName" = 'send-email' AND state = 'COMPLETED'`,
    );
    const lastSuccessfulEmail = lastRows[0]?.last ?? null;
    if (lastSuccessfulEmail) {
        const days = (Date.now() - new Date(lastSuccessfulEmail).getTime()) / 86_400_000;
        if (days > EMAIL_SILENCE_DAYS) {
            problems.push(
                `No email has sent successfully for ${Math.floor(days)} days ` +
                    `(last ${lastSuccessfulEmail}).`,
            );
        }
    }

    return { queues, lastSuccessfulEmail, problems, warnings, healthy: problems.length === 0 };
}

export function formatReport(r: HealthReport): string {
    const lines = [`Job queue health — last ${WINDOW_HOURS}h`, ''];
    if (!r.queues.length) {
        lines.push('  (no job activity in the window)');
    }
    for (const q of r.queues) {
        lines.push(
            `  ${q.queueName.padEnd(26)} completed=${String(q.completed).padStart(4)} ` +
                `failed=${String(q.failed).padStart(4)} pending=${String(q.pending).padStart(4)} ` +
                `failure rate=${q.failureRate}%`,
        );
    }
    lines.push('', `  last successful email: ${r.lastSuccessfulEmail ?? 'never'}`);
    if (r.warnings.length) {
        lines.push('', 'Warnings:', ...r.warnings.map(w => `  - ${w}`));
    }
    if (r.problems.length) {
        lines.push('', 'Problems:', ...r.problems.map(p => `  - ${p}`));
    }
    return lines.join('\n');
}
