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
/**
 * Alert when an unfinished order has held stock on a live product this long.
 * Stripe card authorisations lapse after 7 days, so a day is ample warning.
 */
export const RESERVATION_ALERT_HOURS = Number(process.env.RESERVATION_ALERT_HOURS ?? 24);

export interface QueueStats {
    queueName: string;
    failed: number;
    completed: number;
    pending: number;
    failureRate: number;
}

export interface HeldReservation {
    code: string;
    state: string;
    since: string;
    units: string;
}

export interface HealthReport {
    queues: QueueStats[];
    reservations: HeldReservation[];
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

    // 4. Stock held by orders that will not complete on their own. With stock-of-1
    //    diamonds, each of these is a stone nobody can buy, and nothing on the
    //    storefront says why. Deliberately report-only: PaymentAuthorized means
    //    money is authorised, so a human decides whether to capture or cancel.
    //
    //    Net holding comes from the stock-movement ledger (allocations + sales −
    //    releases). PaymentSettled and later are excluded: a paid order rightly
    //    holds its stock until it ships. Deleted variants are excluded: nobody
    //    can buy those anyway.
    const reservations = await query<HeldReservation>(
        `SELECT o.code, o.state, o."updatedAt"::text AS since, sum(h.units)::text AS units
           FROM (SELECT ol."orderId", sm."productVariantId",
                        sum(CASE sm.type WHEN 'RELEASE' THEN -sm.quantity ELSE sm.quantity END) AS units
                   FROM stock_movement sm
                   JOIN order_line ol ON ol.id = sm."orderLineId"
                  WHERE sm.type IN ('ALLOCATION', 'SALE', 'RELEASE')
                  GROUP BY 1, 2) h
           JOIN "order" o ON o.id = h."orderId"
           JOIN product_variant pv ON pv.id = h."productVariantId" AND pv."deletedAt" IS NULL
          WHERE h.units > 0
            AND (o.state IN ('Cancelled', 'AddingItems')
                 OR (o.state IN ('ArrangingPayment', 'PaymentAuthorized', 'ArrangingAdditionalPayment')
                     AND o."updatedAt" < now() - ($1 || ' hours')::interval))
          GROUP BY o.code, o.state, o."updatedAt"
          ORDER BY o."updatedAt"`,
        [RESERVATION_ALERT_HOURS],
    );
    if (reservations.length) {
        const units = reservations.reduce((n, r) => n + Number(r.units), 0);
        problems.push(
            `${reservations.length} order(s) are holding ${units} unit(s) of live stock and will not ` +
                `release it on their own: ${reservations
                    .slice(0, 10)
                    .map(r => `${r.code} (${r.state}, ${r.units})`)
                    .join(', ')}${reservations.length > 10 ? ', …' : ''}. ` +
                `Cancelled/AddingItems means a release was missed; otherwise review the order in the ` +
                `Admin UI and capture or cancel it.`,
        );
    }

    return {
        queues,
        reservations,
        lastSuccessfulEmail,
        problems,
        warnings,
        healthy: problems.length === 0,
    };
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
    lines.push(`  orders stuck holding stock: ${r.reservations.length}`);
    if (r.warnings.length) {
        lines.push('', 'Warnings:', ...r.warnings.map(w => `  - ${w}`));
    }
    if (r.problems.length) {
        lines.push('', 'Problems:', ...r.problems.map(p => `  - ${p}`));
    }
    return lines.join('\n');
}
