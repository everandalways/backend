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

// Real Vendure StripePlugin webhook path: POST /payments/stripe
// (Controller('payments') + Post('stripe') in
// node_modules/@vendure/payments-plugin/package/stripe/stripe.controller.js).
const WEBHOOK_PATH = '/payments/stripe';
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

/** Reads the apiKey off the enabled Stripe payment method via the Admin API. */
async function getBackendStripeKey(backendUrl: string): Promise<string> {
    const username = process.env.SUPERADMIN_USERNAME;
    const password = process.env.SUPERADMIN_PASSWORD;
    if (!username || !password) {
        fail('SUPERADMIN_USERNAME and SUPERADMIN_PASSWORD must be set so the real Stripe key can be read from the payment method.');
    }
    const endpoint = backendUrl.replace(/\/+$/, '') + '/admin-api';

    const post = async (body: unknown, token?: string) => {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (token) headers.Authorization = `Bearer ${token}`;
        const res = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body) });
        return { json: (await res.json()) as any, token: res.headers.get('vendure-auth-token') };
    };

    const login = await post({
        query: `mutation($u:String!,$p:String!){login(username:$u,password:$p){__typename ...on CurrentUser{id}}}`,
        variables: { u: username, p: password },
    });
    if (login.json?.data?.login?.__typename !== 'CurrentUser') {
        fail('Admin login failed — cannot read the Stripe key from the payment method.');
    }

    const methods = await post(
        { query: `{paymentMethods(options:{take:50}){items{code enabled handler{code args{name value}}}}}` },
        login.token ?? undefined,
    );
    const items = methods.json?.data?.paymentMethods?.items ?? [];
    const stripeMethod = items.find((m: any) => m.handler?.code === 'stripe' && m.enabled);
    if (!stripeMethod) {
        fail('No ENABLED Stripe payment method found in the backend.');
    }
    const key = stripeMethod.handler.args.find((a: any) => a.name === 'apiKey')?.value;
    if (!key) {
        fail(`Payment method "${stripeMethod.code}" has no apiKey configured.`);
    }
    console.log(`[verify:webhook] Using the key from payment method "${stripeMethod.code}" (${key.slice(0, 7)}...).`);
    return key;
}

async function main(): Promise<void> {
    const backendUrl = process.env.BACKEND_URL;
    if (!backendUrl) {
        fail('BACKEND_URL is not set in the environment (e.g. https://<railway-domain>).');
    }
    const secretKey = await getBackendStripeKey(backendUrl);

    const expectedUrl = backendUrl.replace(/\/+$/, '') + WEBHOOK_PATH;

    const stripe = new Stripe(secretKey, {
        apiVersion: '2023-08-16',
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
