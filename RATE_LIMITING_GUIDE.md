# Rate Limiting Configuration Guide

## Overview

This document describes the production-safe rate limiting implementation for the Vendure backend using `@nestjs/throttler`.

## Features Implemented

✅ **Global Rate Limiting**

- 100 requests per minute per IP in production
- 1000 requests per minute per IP in development
- Configurable via `THROTTLE_LIMIT_PER_MINUTE` environment variable

✅ **Protected Endpoints**

- All Shop API routes (`/shop-api/*`)
- All Admin API routes (`/admin-api/*`)

✅ **Excluded Routes (Webhook Processing)**

- `POST /payments/stripe/webhook`
- `POST /stripe/webhook`
- `POST /api/webhooks/stripe`

✅ **Production Security**

- GraphQL Playground disabled in production
- GraphQL introspection disabled in production
- Debug mode disabled in production

## Installation

### Package Installation

```bash
npm install @nestjs/throttler
```

The package has already been installed. Version information can be found in `package.json`.

## Configuration Files

### 1. Environment Variables (`.env`)

```env
# Rate Limiting Configuration
# Number of requests allowed per minute per IP address
# Development: 1000 requests/min (high limit for testing)
# Production: 100 requests/min (strict limit for safety)
THROTTLE_LIMIT_PER_MINUTE=1000

# For production deployment on Railway, set this to:
# APP_ENV=prod
# THROTTLE_LIMIT_PER_MINUTE=100
```

### 2. Throttler Configuration (`src/config/throttler.config.ts`)

Defines the throttle limits based on environment:

```typescript
// Development: 1000 requests/minute
// Production: 100 requests/minute (overridable via THROTTLE_LIMIT_PER_MINUTE env var)
```

### 3. Rate Limit Plugin (`src/plugins/rate-limit.plugin.ts`)

**Key Features:**

- Implements global `CustomThrottlerGuard` that extends NestJS `ThrottlerGuard`
- Skips rate limiting for Stripe webhook routes
- Applies to all API endpoints automatically

**Stripe Webhook Bypass Logic:**

```typescript
// Routes that bypass rate limiting:
-/payments/eiprst / webhook - /stripe/behkoow - /api/behkoosw / stripe;
```

### 4. Middleware Configuration (`src/middleware/rate-limit.middleware.ts`)

Provides:

- Helper functions for middleware setup
- Production security configuration
- Documentation on Stripe webhook exclusion

### 5. Vendure Config Updates (`src/vendure-config.ts`)

**Changes Made:**

```typescript
// 1. Import the RateLimitPlugin
import { RateLimitPlugin } from './plugins/rate-limit.plugin';

// 2. Added plugin to the plugins array
plugins: [
    // ... other plugins ...
    RateLimitPlugin,
]

// 3. Disabled GraphQL introspection and playground in production
apiOptions: {
    graphQLPlayground: IS_DEV,      // false in production
    graphQLIntrospection: IS_DEV,   // false in production
    // ... other config ...
}
```

## Environment-Specific Behavior

### Development Mode (`APP_ENV=dev`)

```
Rate Limit: 1000 requests/minute per IP
GraphQL Playground: ENABLED
GraphQL Introspection: ENABLED
Admin API Debug: ENABLED
Shop API Debug: ENABLED
```

### Production Mode (`APP_ENV=prod`)

```
Rate Limit: 100 requests/minute per IP
GraphQL Playground: DISABLED
GraphQL Introspection: DISABLED
Admin API Debug: DISABLED
Shop API Debug: DISABLED
TrustProxy: ENABLED (for Railway deployment)
```

## Railway Deployment Configuration

For Railway deployment, set these environment variables:

```env
APP_ENV=prod
PORT=3000
THROTTLE_LIMIT_PER_MINUTE=100

# ... other required variables ...
DB_HOST=<railway-postgres-host>
DB_NAME=<database-name>
DB_USERNAME=<username>
DB_PASSWORD=<password>
# ... etc
```

## How Rate Limiting Works

### Request Flow

1. **Incoming Request**
   ↓
2. **CustomThrottlerGuard checks:**
   - Is this a Stripe webhook? → Skip throttling
   - Has skipThrottle flag? → Skip throttling
     ↓
3. **Rate Limit Check**
   - If within limit → Process request
   - If limit exceeded → Return 429 (Too Many Requests)

### Response Headers

When rate limited, responses include:

```
HTTP/1.1 429 Too Many Requests
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1234567890
```

### Error Response

```json
{
  "message": "ThrottlerException: Too Many Requests",
  "error": "Too Many Requests",
  "statusCode": 429
}
```

## Stripe Webhook Protection

**Why webhooks are excluded:**

- Webhooks are critical for payment processing
- Missing webhooks can cause order processing failures
- Webhooks have built-in Stripe signature verification
- Rate limiting should not impact webhook reliability

**Webhook Signature Verification:**
Even though Stripe webhooks bypass rate limiting, they are still protected by:

1. Stripe signature verification (must be implemented in webhook handler)
2. CORS policy restrictions
3. IP whitelisting (can be configured separately)

## Client-Side Handling

### Recommended Client Behavior

```javascript
// Example: Handle rate limiting in frontend
async function makeApiRequest(url, options = {}) {
  const response = await fetch(url, options);

  if (response.status === 429) {
    // Too Many Requests
    const retryAfter = response.headers.get("X-RateLimit-Reset");
    console.warn(`Rate limited. Retry after: ${retryAfter}`);

    // Implement exponential backoff
    await delay(5000); // Wait 5 seconds before retrying
    return makeApiRequest(url, options);
  }

  return response;
}
```

### Rate Limit Awareness

Client applications should:

1. Respect HTTP 429 responses
2. Implement exponential backoff retry logic
3. Cache frequently requested data
4. Batch requests when possible

## Testing

### Development Testing

In development mode, you can safely make many requests:

```bash
# This will work fine in development (limit: 1000/min)
for i in {1..500}; do
  curl http://localhost:3000/shop-api/
done
```

### Production Testing

Use load testing tools to verify limits:

```bash
# Using Apache Bench
ab -n 150 -c 10 http://production-url/shop-api/

# Expected result: ~50 requests succeed, ~100 fail with 429
```

### Stripe Webhook Testing

```bash
# Stripe webhooks should always succeed
curl -X POST http://localhost:3000/payments/stripe/webhook \
  -H "Content-Type: application/json" \
  -d '{"type": "charge.succeeded", "data": {...}}'

# Should succeed even after hitting rate limit on other endpoints
```

## Monitoring and Observability

### Logging Rate Limit Events

To add logging, extend the CustomThrottlerGuard:

```typescript
// In src/plugins/rate-limit.plugin.ts
protected async shouldSkip(context: any): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const skip = await super.shouldSkip(context);

    if (!skip) {
        console.warn(`Rate limit hit for IP: ${request.ip}, Path: ${request.path}`);
    }

    return skip;
}
```

### Metrics Collection

Consider adding Prometheus metrics for:

- Request rate per IP
- 429 error rate
- Webhook success rate
- Rate limit bypass count

## Troubleshooting

### Issue: Legitimate requests getting rate limited

**Solution:**

- Increase `THROTTLE_LIMIT_PER_MINUTE` if legitimate traffic is high
- Implement client-side request batching
- Use caching to reduce request frequency

### Issue: Stripe webhooks failing

**Solution:**

- Verify webhook URL is one of the excluded routes
- Check Stripe signature verification is properly implemented
- Ensure webhook handler returns 200 OK quickly
- Monitor Stripe webhook delivery logs

### Issue: GraphQL introspection blocked in production

**This is intentional** for security. If needed for development tools:

- Use a separate development environment with `APP_ENV=dev`
- Query the schema locally and cache it
- Use static schema files for IDE support

## Performance Considerations

### Memory Usage

- `@nestjs/throttler` stores request tracking in memory by default
- For distributed deployments, consider using Redis store:

```bash
npm install @nestjs/throttler-storage-redis
```

Then update the config:

```typescript
import { ThrottlerStorageRedisService } from "@nestjs/throttler-storage-redis";
import Redis from "ioredis";

const redis = new Redis();

ThrottlerModule.forRoot({
  store: new ThrottlerStorageRedisService(redis),
  // ... other config
});
```

### Scaling Considerations

**Current Setup (Single Server):**

- Uses in-memory storage
- Works fine for Railway single instance
- ~500MB per 1M tracked IPs

**For Multiple Instances:**

- Configure Redis-based throttle storage
- Ensures consistent rate limiting across servers
- Recommended for production with load balancing

## Security Best Practices

✅ **Implemented:**

- Rate limiting on all API endpoints
- Stripe webhook exclusion (no rate limiting)
- GraphQL introspection disabled in production
- GraphQL playground disabled in production
- Debug mode disabled in production

✅ **Consider Adding:**

- IP whitelisting for admin API
- API key-based rate limits (higher for trusted clients)
- Gradual rate limit escalation (3 strikes = 1 hour ban)
- Geographic rate limiting (different limits by region)

## Maintenance

### Regular Review

- Monitor rate limit hit rates in logs
- Adjust `THROTTLE_LIMIT_PER_MINUTE` based on traffic patterns
- Review Stripe webhook success rates
- Update client libraries to handle 429 responses

### Updating

```bash
# Keep the package updated
npm update @nestjs/throttler

# Check for breaking changes in release notes
npm view @nestjs/throttler versions
```

## References

- [@nestjs/throttler Documentation](https://docs.nestjs.com/security/rate-limiting)
- [Stripe Webhook Documentation](https://stripe.com/docs/webhooks)
- [HTTP 429 Status Code](https://httpwg.org/specs/rfc6585.html#status.429)
- [NestJS Guard Documentation](https://docs.nestjs.com/guards)

## Support

For issues or questions:

1. Check the logs: `npm run dev:server` and monitor console
2. Verify environment variables are set correctly
3. Test rate limiting in development before production deployment
4. Check Stripe webhook logs if webhooks are failing
