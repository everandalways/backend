# Next Steps After Creating Stripe Webhook

Great! You've created the webhook in Stripe. Here's what you received and what to do next:

## What You Received

1. **Webhook Snapshot** - This is your webhook endpoint configuration
2. **Webhook Signing Secret** (the "thin type webhook") - This starts with `whsec_` and is used to verify webhook authenticity

## Step-by-Step Next Actions

### Step 1: Copy Your Webhook Signing Secret

1. In Stripe Dashboard, go to **Developers** → **Webhooks**
2. Click on your webhook endpoint
3. Find the **Signing secret** section
4. Click **Reveal** or **Click to reveal** to see the secret
5. Copy the secret (it starts with `whsec_`)

**Example format**: `whsec_1234567890abcdefghijklmnopqrstuvwxyz`

### Step 2: Add Webhook Secret to Frontend (if needed)

**Note**: The Stripe API key and webhook secret are NOT set as backend environment variables. They are configured in the Vendure Admin UI (see Step 4 below).

However, you DO need to set the publishable key in your frontend:

#### Frontend Environment Variable (`.env.local` or Vercel)

1. Open or create `.env.local` file in your `ever-and-always-prod-fe-1/` directory
2. Add this line:

```env
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_your_publishable_key_here
```

**Important**: Replace `pk_test_your_publishable_key_here` with your actual Stripe publishable key from Step 1 of the main setup guide.

### Step 3: Verify Frontend Key is Set

Make sure your frontend has the publishable key:

```env
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_your_publishable_key_here
```

**Note**: The secret key and webhook secret are configured in Vendure Admin UI, not as environment variables.

### Step 4: Create Payment Method in Vendure Admin (This is where you enter the keys!)

1. **Start your backend server** (if not already running):
   ```bash
   cd backend
   npm run dev
   ```

2. **Log in to Vendure Admin UI**:
   - Open `http://localhost:3000/admin` (or your production admin URL)
   - Log in with your superadmin credentials

3. **Navigate to Payment Methods**:
   - Go to **Settings** → **Payment Methods**
   - Click **Create new Payment Method**

4. **Configure the Payment Method**:
   - **Name**: `Stripe Payments` (or your preferred name)
   - **Code**: `stripe-payments` (important: must contain "stripe" in the code)
   - **Handler**: Select **"Stripe payments"** from the dropdown
   - **Enabled**: ✓ (check the box)

5. **Enter Handler Configuration** (This is where you configure Stripe!):
   - **API Key**: Your Stripe secret key (`sk_test_...`)
     - Copy this from Stripe Dashboard → Developers → API keys → Secret key
     - This is where the plugin gets the API key from (NOT from environment variables)
   - **Webhook Secret**: Your webhook signing secret (`whsec_...`)
     - This is the secret you copied from Stripe Dashboard → Webhooks
     - This is where the plugin gets the webhook secret from (NOT from environment variables)
   
6. **Save** the payment method

**Important**: The Stripe plugin gets its API key and webhook secret from this Payment Method configuration, not from environment variables. This is how Vendure's Stripe plugin works.

### Step 5: Restart Your Backend

Restart your backend server to ensure everything is loaded:

```bash
# Stop the server (Ctrl+C)
# Then start it again
npm run dev
```

This ensures the new environment variables are loaded.

### Step 6: Test the Webhook

#### Option A: Test with Stripe CLI (Recommended for Local)

1. **Install Stripe CLI** (if not already installed):
   - Windows: Download from https://github.com/stripe/stripe-cli/releases
   - Mac: `brew install stripe/stripe-cli/stripe`
   - Linux: See https://stripe.com/docs/stripe-cli

2. **Login to Stripe**:
   ```bash
   stripe login
   ```

3. **Forward webhooks to your local server**:
   ```bash
   stripe listen --forward-to localhost:3000/payments/stripe
   ```
   
   This will display a webhook signing secret. **Use this secret** for local testing instead of the one from Stripe Dashboard.

4. **Trigger a test event**:
   ```bash
   stripe trigger payment_intent.succeeded
   ```

#### Option B: Test with Real Payment Flow

1. Go to your frontend checkout page
2. Add items to cart
3. Complete checkout steps:
   - Shipping address
   - Delivery method
   - **Payment method** (select "Stripe Payments")
4. Enter test card: `4242 4242 4242 4242`
   - Expiry: Any future date (e.g., `12/34`)
   - CVC: Any 3 digits (e.g., `123`)
   - ZIP: Any postal code
5. Complete the payment
6. Check:
   - Order should be created in Vendure Admin
   - Payment should appear in Stripe Dashboard
   - Webhook should show as successful in Stripe Dashboard → Webhooks

### Step 7: Verify Webhook is Working

1. **Check Stripe Dashboard**:
   - Go to **Developers** → **Webhooks**
   - Click on your webhook endpoint
   - Check the **Recent events** section
   - You should see successful webhook deliveries (green checkmarks)

2. **Check Backend Logs**:
   - Look for webhook processing messages
   - Should not see any webhook-related errors

3. **Check Vendure Admin**:
   - Go to **Orders**
   - Verify orders are being created with payments

## Troubleshooting

### Webhook Shows as Failed in Stripe Dashboard

**Possible causes:**
1. **Wrong webhook URL**: Make sure it's `https://your-domain.com/payments/stripe`
2. **Backend not running**: Ensure your backend server is running
3. **Wrong webhook secret**: Verify `STRIPE_WEBHOOK_SECRET` matches the one in Stripe
4. **CORS issues**: Check backend CORS configuration

**Solution:**
- Check backend logs for error messages
- Verify webhook URL is accessible
- Test webhook endpoint manually (see below)

### Test Webhook Endpoint Manually

You can test if your webhook endpoint is reachable:

```bash
# Test if endpoint exists (should return 400 or 405, not 404)
curl -X POST https://your-domain.com/payments/stripe
```

### Webhook Secret Mismatch

If you see errors about webhook signature verification:

1. Double-check the webhook secret in:
   - **Vendure Admin payment method configuration** (Settings → Payment Methods → Your Stripe payment method → Handler configuration)
   - This should match the secret from Stripe Dashboard

2. For local testing with Stripe CLI, use the secret displayed by `stripe listen`, not the one from Stripe Dashboard. Update the webhook secret in the Admin UI to match the CLI secret.

## Quick Checklist

- [ ] Copied webhook signing secret from Stripe Dashboard
- [ ] Copied Stripe secret key from Stripe Dashboard
- [ ] Verified `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` is set in frontend
- [ ] Created payment method in Vendure Admin with correct handler
- [ ] Entered **API Key** in payment method handler configuration
- [ ] Entered **Webhook Secret** in payment method handler configuration
- [ ] Restarted backend server
- [ ] Tested webhook with test payment
- [ ] Verified webhook events in Stripe Dashboard

## Need Help?

If you encounter issues:

1. Check backend logs for error messages
2. Check Stripe Dashboard → Webhooks → Recent events for error details
3. Verify all environment variables are set correctly
4. Ensure payment method code contains "stripe" (case-insensitive)
5. Make sure backend server is running and accessible

## Next Steps After Webhook is Working

Once your webhook is successfully receiving events:

1. ✅ Test with different payment scenarios (success, decline, 3D Secure)
2. ✅ Monitor webhook success rate in Stripe Dashboard
3. ✅ Set up webhook event monitoring/alerts
4. ✅ Test in production environment
5. ✅ Switch to live keys when ready for production

---

**Remember**: 
- Use test keys (`sk_test_`, `pk_test_`, `whsec_`) for development
- Use live keys (`sk_live_`, `pk_live_`) for production
- Never commit secrets to version control
