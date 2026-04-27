# Stripe Payment Integration Setup Guide

This guide will help you set up Stripe payments with your Vendure e-commerce store using a Stripe testing account.

## Prerequisites

1. A Stripe account (sign up at https://stripe.com)
2. Access to your Stripe Dashboard
3. Your backend and frontend environment variables

## Step 1: Get Your Stripe API Keys

1. Log in to your [Stripe Dashboard](https://dashboard.stripe.com)
2. Make sure you're in **Test mode** (toggle in the top right)
3. Navigate to **Developers** → **API keys**
4. Copy your **Publishable key** (starts with `pk_test_`)
5. Copy your **Secret key** (starts with `sk_test_`)

## Step 2: Set Up Webhook Endpoint

1. In Stripe Dashboard, go to **Developers** → **Webhooks**
2. Click **Add endpoint**
3. Enter your webhook URL:
   - **Local development**: Use Stripe CLI (see below)
   - **Production**: `https://your-domain.com/payments/stripe/webhook`
4. Select events to listen to:
   - `payment_intent.succeeded`
   - `payment_intent.payment_failed`
   - `charge.succeeded`
   - `charge.failed`
5. Copy the **Signing secret** (starts with `whsec_`)

### Local Development with Stripe CLI

For local testing, use Stripe CLI to forward webhooks:

```bash
# Install Stripe CLI
# Windows: Download from https://github.com/stripe/stripe-cli/releases
# Mac: brew install stripe/stripe-cli/stripe
# Linux: See https://stripe.com/docs/stripe-cli

# Login to Stripe
stripe login

# Forward webhooks to your local server
stripe listen --forward-to localhost:3000/payments/stripe/webhook
```

The CLI will display a webhook signing secret. Use this for `STRIPE_WEBHOOK_SECRET` in local development.

## Step 3: Configure Backend Environment Variables

**Note**: The Stripe API key and webhook secret are NOT set as environment variables. Instead, they are configured directly in the Vendure Admin UI when creating the Payment Method (see Step 5).

However, you may want to keep them in your `.env` file for reference, but they won't be used by the plugin automatically:

```env
# Stripe Configuration (for reference only - not used by plugin)
# These are configured in Admin UI → Payment Methods instead
STRIPE_SECRET_KEY=sk_test_your_secret_key_here
STRIPE_WEBHOOK_SECRET=whsec_your_webhook_secret_here
```

**Important**: 
- Use test keys (`sk_test_` and `pk_test_`) for development
- Use live keys (`sk_live_` and `pk_live_`) for production
- Never commit these keys to version control

## Step 4: Configure Frontend Environment Variables

Add this to your frontend `.env.local` file or Vercel environment variables:

```env
# Stripe Configuration
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_your_publishable_key_here
```

**Note**: The `NEXT_PUBLIC_` prefix makes this variable available in the browser.

## Step 5: Create Payment Method in Vendure Admin

1. Start your Vendure backend
2. Log in to the Admin UI (usually at `http://localhost:3000/admin`)
3. Navigate to **Settings** → **Payment Methods**
4. Click **Create new Payment Method**
5. Fill in:
   - **Name**: "Stripe Payments" (or your preferred name)
   - **Code**: "stripe-payments" (must match what's used in frontend)
   - **Handler**: Select "Stripe payments"
   - **Enabled**: ✓
6. In the handler configuration:
   - **API Key**: Your Stripe secret key (`sk_test_...` from Step 1)
     - This is where you enter your Stripe secret key
   - **Webhook Secret**: Your Stripe webhook secret (`whsec_...` from Step 2)
     - This is where you enter your webhook signing secret
7. Save the payment method

**Important**: The API key and webhook secret are configured HERE in the Admin UI, not in environment variables. The StripePlugin gets these values from the Payment Method configuration.

## Step 6: Test the Integration

### Test Cards

Use these test card numbers in Stripe test mode:

- **Success**: `4242 4242 4242 4242`
- **Decline**: `4000 0000 0000 0002`
- **Requires Authentication**: `4000 0025 0000 3155`

Use any:
- Future expiry date (e.g., `12/34`)
- Any 3-digit CVC
- Any postal code

### Testing Flow

1. Add items to cart
2. Go to checkout
3. Complete shipping and delivery steps
4. Select "Stripe Payments" as payment method
5. Enter test card details
6. Complete payment
7. Verify order is created in Vendure Admin
8. Check Stripe Dashboard for payment intent

## Troubleshooting

### Payment Intent Creation Fails

- Check that `STRIPE_SECRET_KEY` is set correctly in backend
- Verify the key starts with `sk_test_` (test mode) or `sk_live_` (production)
- Check backend logs for error messages

### Webhook Not Receiving Events

- Verify `STRIPE_WEBHOOK_SECRET` matches the signing secret from Stripe
- Check webhook URL is correct
- For local dev, ensure Stripe CLI is running and forwarding to correct port
- Check backend logs for webhook processing errors

### Frontend Stripe Elements Not Loading

- Verify `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` is set
- Check browser console for errors
- Ensure the key starts with `pk_test_` (test) or `pk_live_` (production)

### Payment Succeeds but Order Not Created

- Check webhook is configured correctly
- Verify webhook events are being received (check Stripe Dashboard → Webhooks)
- Check backend logs for webhook processing errors
- Ensure payment method code matches between Admin UI and frontend

## Production Checklist

Before going live:

- [ ] Switch to Stripe live mode
- [ ] Update `STRIPE_SECRET_KEY` to live key (`sk_live_...`)
- [ ] Update `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` to live key (`pk_live_...`)
- [ ] Set up production webhook endpoint
- [ ] Update `STRIPE_WEBHOOK_SECRET` with production webhook secret
- [ ] Test with real card (use small amount)
- [ ] Verify webhook events are being received
- [ ] Set up webhook event monitoring/alerts

## Additional Resources

- [Vendure Stripe Plugin Documentation](https://docs.vendure.io/reference/core-plugins/payments-plugin/stripe-plugin)
- [Stripe Testing Guide](https://stripe.com/docs/testing)
- [Stripe Webhooks Guide](https://stripe.com/docs/webhooks)
