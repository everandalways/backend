/* eslint-disable no-console */
/**
 * Pre-deploy sanity check for configuration that only fails at boot.
 *
 * Run before every deploy:
 *   npm run verify:config
 *
 * Exists because a config change shipped on 2026-09-23 took the whole site
 * down: `orderOptions.process` REPLACES Vendure's default process array rather
 * than extending it, so omitting `defaultOrderProcess` removed every order
 * state and the server died with
 *   'The order process has an invalid configuration: The initial state
 *    "Created" is not defined'
 * TypeScript compiled it happily — the failure only surfaces when the state
 * machine is constructed at runtime.
 *
 * Needs no database and makes no network calls.
 */

import { config } from '../vendure-config';

// These live outside the public entrypoint, but are what OrderStateMachine
// itself uses, so this check matches production behaviour exactly.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { mergeTransitionDefinitions } = require('@vendure/core/dist/common/finite-state-machine/merge-transition-definitions');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { validateTransitionDefinition } = require('@vendure/core/dist/common/finite-state-machine/validate-transition-definition');

const problems: string[] = [];
const notes: string[] = [];

function checkStateMachine(
    label: string,
    processes: Array<{ transitions?: any }> | undefined,
    initialState: string,
): void {
    if (processes === undefined) {
        // Not overridden, so Vendure supplies its own default. Nothing to check.
        console.log(`  --  ${label} — using Vendure default`);
        return;
    }
    if (processes.length === 0) {
        problems.push(
            `${label}: set to an empty array, which REPLACES Vendure's default and removes every state`,
        );
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

console.log('\n[verify:config] Checking configuration that only fails at boot...\n');

checkStateMachine('order process', config.orderOptions?.process, 'Created');
checkStateMachine('payment process', config.paymentOptions?.process, 'Created');
checkStateMachine('fulfillment process', config.shippingOptions?.customFulfillmentProcess, 'Pending');

// A custom stockAllocationStrategy is the other half of the oversell fix; if it
// is dropped, overselling silently returns with no error anywhere.
const allocation = config.orderOptions?.stockAllocationStrategy;
if (!allocation) {
    notes.push(
        'orderOptions.stockAllocationStrategy is unset — Vendure will allocate stock only ' +
            'after payment settles, which permits overselling stock-of-1 items.',
    );
} else {
    console.log(`  ok  stock allocation strategy — ${allocation.constructor.name}`);
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
    for (const n of notes) console.log(`  - ${n}`);
}

if (problems.length) {
    console.error('\n[verify:config] FAIL\n');
    for (const p of problems) console.error(`  - ${p}`);
    console.error('');
    process.exit(1);
}

console.log('\n[verify:config] PASS — safe to deploy.\n');
