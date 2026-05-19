/* eslint-disable no-console */
/**
 * Verify the production Stripe webhook end-to-end.
 *
 * Usage:
 *   STRIPE_SECRET_KEY=sk_live_... BACKEND_URL=https://api.example.com \
 *     npm run verify:webhook
 *
 * Pass  -> exit 0
 * Fail  -> exit 1 with a clear console message describing what to fix.
 *
 * See backend/STRIPE_WEBHOOK_OPS.md for the recovery runbook.
 */

import Stripe from 'stripe';
import * as dotenv from 'dotenv';

dotenv.config();

const WEBHOOK_PATH = '/payments/stripe/webhook';
const REQUIRED_EVENTS = [
    'payment_intent.succeeded',
    'payment_intent.payment_failed',
    'charge.refunded',
] as const;

function fail(message: string): never {
    console.error(`\n[verify:webhook] FAIL — ${message}\n`);
    process.exit(1);
}

function pass(message: string): never {
    console.log(`\n[verify:webhook] PASS — ${message}\n`);
    process.exit(0);
}

async function main(): Promise<void> {
    const secretKey = process.env.STRIPE_SECRET_KEY;
    const backendUrl = process.env.BACKEND_URL;

    if (!secretKey) {
        fail('STRIPE_SECRET_KEY is not set in the environment.');
    }
    if (!backendUrl) {
        fail('BACKEND_URL is not set in the environment (e.g. https://<railway-domain>).');
    }

    const expectedUrl = backendUrl.replace(/\/+$/, '') + WEBHOOK_PATH;

    const stripe = new Stripe(secretKey, {
        apiVersion: '2023-10-16',
    });

    console.log(`[verify:webhook] Expecting endpoint: ${expectedUrl}`);
    console.log('[verify:webhook] Fetching webhook endpoints from Stripe...');

    const endpoints: Stripe.WebhookEndpoint[] = [];
    try {
        for await (const endpoint of stripe.webhookEndpoints.list({ limit: 100 })) {
            endpoints.push(endpoint);
        }
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        fail(`Stripe API call failed while listing webhook endpoints: ${msg}`);
    }

    if (endpoints.length === 0) {
        fail('No webhook endpoints are configured in this Stripe account.');
    }

    console.log(`[verify:webhook] Found ${endpoints.length} endpoint(s) in Stripe.`);
    for (const e of endpoints) {
        console.log(`  - ${e.url}  [status=${e.status}]`);
    }

    const match = endpoints.find(e => e.url === expectedUrl);
    if (!match) {
        fail(
            `No Stripe webhook endpoint matches ${expectedUrl}. ` +
                'Update the endpoint URL in Stripe Dashboard → Developers → Webhooks ' +
                '(see STRIPE_WEBHOOK_OPS.md §1 and §5.2).',
        );
    }

    if (match.status !== 'enabled') {
        fail(
            `Endpoint ${expectedUrl} exists but its status is "${match.status}". ` +
                'Enable it in Stripe Dashboard → Developers → Webhooks.',
        );
    }

    const subscribed = new Set<string>(match.enabled_events);
    const subscribesToAll = subscribed.has('*');
    const missing = REQUIRED_EVENTS.filter(ev => !subscribesToAll && !subscribed.has(ev));

    if (missing.length > 0) {
        fail(
            `Endpoint ${expectedUrl} is missing required event(s): ${missing.join(', ')}. ` +
                'Add them via Stripe Dashboard → Developers → Webhooks → (endpoint) → Update details ' +
                '(see STRIPE_WEBHOOK_OPS.md §3).',
        );
    }

    const eventSummary = subscribesToAll
        ? '* (all events)'
        : REQUIRED_EVENTS.join(', ');

    pass(
        `Stripe endpoint ${expectedUrl} is enabled and subscribed to: ${eventSummary}.`,
    );
}

main().catch(err => {
    const msg = err instanceof Error ? err.stack || err.message : String(err);
    fail(`Unexpected error: ${msg}`);
});
