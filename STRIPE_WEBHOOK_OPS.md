# Stripe Webhook — Operational Checklist

One-page runbook for verifying and recovering the production Stripe webhook
after each deploy. Pair this with `npm run verify:webhook` (see
`src/scripts/verify-stripe-webhook.ts`).

---

## 1. Production webhook URL

The prod webhook endpoint registered in Stripe must be exactly:

```
https://<RAILWAY_DOMAIN>/payments/stripe
```

Replace `<RAILWAY_DOMAIN>` with the live Railway domain serving the backend
(e.g. `api.everandalways.com` or the `*.up.railway.app` host). No trailing
slash. HTTPS only.

`BACKEND_URL` in the backend env must match the same origin so that
`verify:webhook` can confirm the match programmatically.

---

## 2. Enable email-on-failure alerts

Stripe Dashboard path:

```
Developers  →  Webhooks  →  (select the endpoint above)
            →  ⋯ (more)  →  Notifications / Email settings
            →  Enable "Email me when a webhook is failing"
```

Then under **Workbench → Notifications → Email preferences**, confirm the
team email (and any on-call address) is subscribed to **"Webhook endpoint
failures"**. Stripe begins sending these after ~3 consecutive failures.

---

## 3. Required subscribed events

The endpoint MUST be subscribed to (at minimum) these events:

- `payment_intent.succeeded`
- `payment_intent.payment_failed`
- `charge.refunded`

`verify:webhook` fails (exit 1) if any of these are missing or if the
endpoint is disabled.

---

## 4. Confirming 200 OK in "Recent deliveries"

After a deploy, push a real or test event through and check delivery health.

Stripe Dashboard path:

```
Developers → Webhooks → (select the endpoint) → Event deliveries tab
```

What to check:

1. **Status column** — expect `200` (green) for the latest attempts. Anything
   in the `4xx` / `5xx` range means the backend rejected or errored.
2. **Click any delivery** to expand:
   - **Response** body — should be empty or `{"received": true}` style;
     anything containing `"error"` is a failure even if the status is 200.
   - **Attempts** — Stripe retries failures with exponential backoff for up
     to 3 days. If you see >1 attempt on recent events, treat as a regression.
3. **Filter by failed** (top of the table) — should be empty for the last
   24h after a healthy deploy.

To force a fresh delivery without a real purchase, use **"Send test
webhook"** on the endpoint page and pick `payment_intent.succeeded`.

---

## 5. Manual recovery — webhook failing in prod

If `verify:webhook` fails or "Recent deliveries" shows non-200 responses:

1. **Check backend health first** — hit `https://<RAILWAY_DOMAIN>/health`
   (or the app root). If the backend is down, fix that before touching
   Stripe config; the webhook will recover automatically on Stripe's retry.

2. **Confirm the endpoint URL** in Stripe matches the current Railway
   domain. If the domain changed (custom domain swap, re-deploy on a new
   project), update the endpoint URL in
   `Developers → Webhooks → (endpoint) → Update details`.

3. **Rotate the signing secret** when responses are `400 invalid signature`
   or the secret may be compromised:

   a. In Stripe: `Developers → Webhooks → (endpoint) → Signing secret →
      Roll secret`. Copy the new `whsec_...` value.

   b. In **Vendure Admin → Settings → Payment Methods → Stripe** (the
      Stripe handler config), paste the new value into the
      `webhookSigningSecret` (a.k.a. `Webhook secret`) field and save.

   c. No backend restart is required — Vendure reads payment method config
      live. Re-run `npm run verify:webhook` and then "Send test webhook"
      from Stripe to confirm a `200`.

4. **If events are missing from the subscription list**, edit the endpoint
   in Stripe and re-add the three required events listed in §3, then
   re-run `npm run verify:webhook`.

5. **Replay failed events** once recovered: open each failed delivery in
   "Recent deliveries" and click **Resend**. Process the oldest first so
   downstream order state advances in order.

---

## Post-deploy quick check (copy/paste)

```bash
# from backend/
STRIPE_SECRET_KEY=sk_live_... BACKEND_URL=https://<RAILWAY_DOMAIN> \
  npm run verify:webhook
```

Exit 0 = pass. Exit 1 = read the printed reason and walk §5.
