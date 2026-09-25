/* eslint-disable no-console */
/**
 * Job queue health check. Exits non-zero when something needs attention, so it
 * can be wired to CI, a cron job, or run ad hoc.
 *
 *   npm run check:jobs
 *
 * The same checks run automatically every 30 minutes inside the worker via the
 * `job-health-alert` scheduled task, which is what actually notifies you. This
 * script is for looking on demand.
 *
 * Exists because the real failure in the 2026-07-20 -> 2026-09-23 email outage
 * was not the SMTP timeout — it was that order confirmations and password
 * resets stopped for two months and nothing anywhere said so.
 */

import { DataSource } from 'typeorm';
import 'dotenv/config';
import { config } from '../vendure-config';
import { checkJobHealth, formatReport } from '../config/job-health';

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

    const report = await checkJobHealth((sql, params) => dataSource.query(sql, params as any[]));
    await dataSource.destroy();

    console.log('\n' + formatReport(report) + '\n');

    if (!report.healthy) {
        console.error('[check:jobs] UNHEALTHY\n');
        process.exit(1);
    }
    console.log('[check:jobs] healthy\n');
}

main().catch(err => {
    console.error(`[check:jobs] could not run: ${err.message}`);
    process.exit(2);
});
