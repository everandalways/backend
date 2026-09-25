/* eslint-disable no-console */
/**
 * Pre-deploy sanity check for configuration that only fails at boot, or under
 * concurrency — the kind TypeScript compiles quite happily.
 *
 *   npm run verify:config
 *
 * Both checks below exist because the corresponding mistake actually took the
 * production site down on 2026-09-23.
 *
 * Needs no database and makes no network calls.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { VendureConfig } from '@vendure/core';

// vendure-config refuses to load without the production secrets unless
// APP_ENV=dev. Nothing checked here depends on APP_ENV, so default to dev and
// let this run anywhere — including a laptop with no Railway env at all.
process.env.APP_ENV = process.env.APP_ENV || 'dev';
// Loaded after APP_ENV is set, hence require rather than a hoisted import.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { config } = require('../vendure-config') as { config: VendureConfig };

// These live outside the public entrypoint, but are what OrderStateMachine
// itself uses, so this check matches production behaviour exactly.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { mergeTransitionDefinitions } = require('@vendure/core/dist/common/finite-state-machine/merge-transition-definitions');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { validateTransitionDefinition } = require('@vendure/core/dist/common/finite-state-machine/validate-transition-definition');

const problems: string[] = [];
const notes: string[] = [];

/**
 * `orderOptions.process` REPLACES Vendure's default rather than extending it
 * (default-config.ts sets `process: [defaultOrderProcess]`, and
 * OrderStateMachine.initConfig reads the array verbatim). Omitting
 * defaultOrderProcess removes every order state and the server dies at boot
 * with 'The initial state "Created" is not defined'.
 */
function checkStateMachine(
    label: string,
    processes: Array<{ transitions?: any }> | undefined,
    initialState: string,
): void {
    if (processes === undefined) {
        console.log(`  --  ${label} — using Vendure default`);
        return;
    }
    if (processes.length === 0) {
        problems.push(`${label}: set to an empty array, which removes every state`);
        return;
    }
    const all = processes.reduce(
        (transitions: any, p: any) => mergeTransitionDefinitions(transitions, p.transitions),
        {},
    );
    const stateCount = Object.keys(all).length;
    const result = validateTransitionDefinition(all, initialState);

    if (!result.valid) {
        problems.push(`${label}: ${result.error}`);
        return;
    }
    if (result.error) {
        notes.push(`${label}: ${result.error}`);
    }
    console.log(`  ok  ${label} — ${stateCount} states, initial "${initialState}"`);
}

/**
 * `rawConnection` runs OUTSIDE the surrounding transaction and takes a SECOND
 * connection from the pool. Inside an order process that means every in-flight
 * checkout holds one connection while waiting for another; with the pool
 * default of 10, ten concurrent checkouts hang the server permanently.
 */
function checkNoRawConnection(): void {
    const dirs = [path.join(__dirname, '..', 'config'), path.join(__dirname, '..', 'strategies')];
    let found = false;

    for (const dir of dirs) {
        if (!fs.existsSync(dir)) {
            continue;
        }
        // Only *.process.ts / *.strategy.ts: those run inside the transaction
        // opened by the resolver. A *.task.ts scheduled job runs standalone, so
        // rawConnection is both correct and necessary there.
        const inTransaction = fs
            .readdirSync(dir)
            .filter(f => f.endsWith('.process.ts') || f.endsWith('.strategy.ts'));
        for (const file of inTransaction) {
            const src = fs.readFileSync(path.join(dir, file), 'utf8');
            src.split(/\r?\n/).forEach((raw, i) => {
                const line = raw.trim();
                const isComment =
                    line.startsWith('*') || line.startsWith('//') || line.startsWith('/*');
                if (line.includes('rawConnection') && !isComment) {
                    found = true;
                    problems.push(
                        `${file}:${i + 1} uses rawConnection inside a process/strategy. It escapes ` +
                            `the transaction and takes a second pool connection, which deadlocks ` +
                            `under concurrency. Use connection.getRepository(ctx, Entity).manager ` +
                            `instead.\n      ${line}`,
                    );
                }
            });
        }
    }

    if (!found) {
        console.log('  ok  no rawConnection use inside order processes / strategies');
    }
}

console.log('\n[verify:config] Checking configuration that only fails at boot...\n');

checkStateMachine('order process', config.orderOptions?.process, 'Created');
checkStateMachine('payment process', config.paymentOptions?.process, 'Created');
checkStateMachine('fulfillment process', config.shippingOptions?.customFulfillmentProcess, 'Pending');
checkNoRawConnection();

// Half of the oversell fix. If this is dropped, overselling silently returns
// with nothing anywhere to indicate it.
const allocation = config.orderOptions?.stockAllocationStrategy;
if (!allocation) {
    notes.push(
        'orderOptions.stockAllocationStrategy is unset — Vendure will allocate stock only ' +
            'after payment settles, which permits overselling stock-of-1 items.',
    );
} else {
    console.log(`  ok  stock allocation strategy — ${allocation.constructor.name}`);
}

// Vendure only releases stock for orders that are no longer `active`; an order
// in ArrangingPayment still is. Without this process every abandoned or expired
// checkout keeps its reservation forever.
const processes = (config.orderOptions?.process ?? []) as any[];
if (allocation && !processes.some(p => p?.constructor?.name === 'ReleaseReservationOrderProcess')) {
    problems.push(
        'Stock is reserved at checkout but ReleaseReservationOrderProcess is missing from ' +
            'orderOptions.process. Cancelled and abandoned checkouts would hold stock forever.',
    );
} else if (allocation) {
    console.log('  ok  reservations are released when a checkout is abandoned');
}

const scheduled = config.schedulerOptions?.tasks ?? [];
if (allocation && !scheduled.some((t: any) => t.id === 'expire-stale-checkouts')) {
    problems.push(
        'Stock is reserved at checkout but the expire-stale-checkouts task is missing. ' +
            'Abandoned checkouts would hold stock forever.',
    );
} else if (scheduled.length) {
    console.log(`  ok  scheduled tasks — ${scheduled.map((t: any) => t.id).join(', ')}`);
}

if (notes.length) {
    console.log('\nNotes:');
    for (const n of notes) {
        console.log(`  - ${n}`);
    }
}

if (problems.length) {
    console.error('\n[verify:config] FAIL\n');
    for (const p of problems) {
        console.error(`  - ${p}`);
    }
    console.error('');
    process.exit(1);
}

console.log('\n[verify:config] PASS — safe to deploy.\n');
