/* eslint-disable no-console */
/**
 * Job queue health check. Exits non-zero when something needs attention, so it
 * can be wired to a cron job, an uptime monitor, or a CI step.
 *
 *   npm run check:jobs
 *
 * Exists because the real failure in the 2026-07-20 → 2026-09-23 email outage
 * was not the SMTP timeout — it was that order confirmations and password
 * resets stopped for two months and nothing anywhere said so.
 *
 * Reads DB_* from the environment, exactly like the server does.
 */

import { DataSource } from 'typeorm';
import 'dotenv/config';
import { config } from '../vendure-config';

/** A job still RUNNING after this long is almost certainly orphaned. */
const STUCK_AFTER_MINUTES = Number(process.env.JOB_STUCK_AFTER_MINUTES ?? 15);
/** Window used for the recent failure-rate check. */
const WINDOW_HOURS = Number(process.env.JOB_WINDOW_HOURS ?? 24);

interface Row {
    queueName: string;
    state: string;
    count: string;
}

async function main(): Promise<void> {
    // Reuse the server's own connection settings so this never drifts from it.
    const db = config.dbConnectionOptions as any;
    const dataSource = new DataSource({
        type: 'postgres',
        host: db.host,
        port: db.port,
        database: db.database,
        username: db.username,
        password: db.password,
        schema: db.schema,
        synchronize: false,
        logging: false,
        entities: [],
    });
    await dataSource.initialize();

    const client = {
        query: async <T>(text: string, params?: unknown[]): Promise<{ rows: T[] }> => ({
            rows: (await dataSource.query(text, params)) as T[],
        }),
        end: () => dataSource.destroy(),
    };

    const problems: string[] = [];
    const warnings: string[] = [];

    // 1. Jobs wedged in RUNNING. This is the signature of the email outage.
    const stuck = await client.query<{ queueName: string; count: string; oldest: string }>(
        `SELECT "queueName", count(*)::text AS count, min("createdAt")::text AS oldest
           FROM job_record
          WHERE state = 'RUNNING'
            AND "startedAt" < now() - ($1 || ' minutes')::interval
          GROUP BY "queueName"`,
        [STUCK_AFTER_MINUTES],
    );
    for (const r of stuck.rows) {
        problems.push(
            `${r.count} job(s) stuck RUNNING in "${r.queueName}" for over ${STUCK_AFTER_MINUTES}m (oldest ${r.oldest}). ` +
                `These can never complete and make the queue look busy.`,
        );
    }

    // 2. Failures in the recent window, per queue.
    const recent = await client.query<Row>(
        `SELECT "queueName", state, count(*)::text AS count
           FROM job_record
          WHERE "createdAt" > now() - ($1 || ' hours')::interval
          GROUP BY "queueName", state`,
        [WINDOW_HOURS],
    );
    const byQueue = new Map<string, { failed: number; completed: number; pending: number }>();
    for (const r of recent.rows) {
        const e = byQueue.get(r.queueName) ?? { failed: 0, completed: 0, pending: 0 };
        if (r.state === 'FAILED') e.failed += Number(r.count);
        if (r.state === 'COMPLETED') e.completed += Number(r.count);
        if (r.state === 'PENDING' || r.state === 'RETRYING') e.pending += Number(r.count);
        byQueue.set(r.queueName, e);
    }

    console.log(`\nJob queue health — last ${WINDOW_HOURS}h\n`);
    if (byQueue.size === 0) {
        console.log('  (no job activity in the window)');
    }
    for (const [queue, e] of [...byQueue.entries()].sort()) {
        const total = e.failed + e.completed;
        const rate = total ? Math.round((e.failed / total) * 100) : 0;
        console.log(
            `  ${queue.padEnd(26)} completed=${String(e.completed).padStart(4)} ` +
                `failed=${String(e.failed).padStart(4)} pending=${String(e.pending).padStart(4)} ` +
                `failure rate=${rate}%`,
        );

        // Email is the one where silent failure is most costly: a customer who
        // never gets a verification link can never log in.
        if (queue === 'send-email' && e.failed > 0 && e.completed === 0) {
            problems.push(`send-email: ${e.failed} failed and NONE succeeded in ${WINDOW_HOURS}h — email is down.`);
        } else if (rate >= 50 && total >= 4) {
            problems.push(`${queue}: ${rate}% of jobs failed in ${WINDOW_HOURS}h.`);
        } else if (rate >= 20 && total >= 4) {
            warnings.push(`${queue}: ${rate}% of jobs failed in ${WINDOW_HOURS}h.`);
        }

        if (e.pending > 50) {
            warnings.push(`${queue}: ${e.pending} jobs waiting — the queue may not be keeping up.`);
        }
    }

    // 3. Has anything been sent at all, ever recently? Catches a silent stall
    //    where nothing is even being enqueued.
    const lastEmail = await client.query<{ last: string | null }>(
        `SELECT max("settledAt")::text AS last FROM job_record
          WHERE "queueName" = 'send-email' AND state = 'COMPLETED'`,
    );
    const last = lastEmail.rows[0]?.last;
    console.log(`\n  last successful email: ${last ?? 'never'}`);
    if (last) {
        const days = (Date.now() - new Date(last).getTime()) / 86_400_000;
        if (days > 7) {
            problems.push(
                `No email has been sent successfully for ${Math.floor(days)} days (last ${last}).`,
            );
        }
    }

    await client.end();

    if (warnings.length) {
        console.log('\nWarnings:');
        for (const w of warnings) console.log(`  - ${w}`);
    }
    if (problems.length) {
        console.error('\n[check:jobs] UNHEALTHY\n');
        for (const p of problems) console.error(`  - ${p}`);
        console.error('');
        process.exit(1);
    }
    console.log('\n[check:jobs] healthy\n');
}

main().catch(err => {
    console.error(`[check:jobs] could not run: ${err.message}`);
    process.exit(2);
});
