# Rate Limiting Architecture

## System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    CLIENT REQUESTS                              │
└────┬────────────────────────────────────────────────────────────┘
     │
     ├─ Request #1-100     → [CustomThrottlerGuard] → ✓ 200 OK
     ├─ Request #101-120   → [CustomThrottlerGuard] → ✗ 429 Too Many Requests
     │
     └─ Stripe Webhook     → [CustomThrottlerGuard] → [Skip Check] → ✓ 200 OK
                                                        (Always bypass)
```

## Request Flow Diagram

```
INCOMING REQUEST
        │
        ▼
┌───────────────────────────┐
│  CustomThrottlerGuard     │
│  (Rate Limit Middleware)  │
└───────────┬───────────────┘
            │
            ├─ Is Stripe webhook? ──Yes──┐
            │                              │
            ├─ Has skipThrottle flag? ──Yes──┤
            │                              │
            └─ Check rate limit          │
               (100 req/min per IP)      │
                   │                      │
                   ├─ Within limit    ──Yes──┤
                   │                      │
                   └─ Over limit         │
                       ▼                  │
                    ✗ 429                │
                                         ▼
                                    ✓ CONTINUE REQUEST
                                         │
                                         ▼
                                   Shop API / Admin API
                                         │
                                         ▼
                                      Response
```

## Module Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                     vendure-config.ts                         │
│  (Main Vendure Configuration)                                │
├──────────────────────────────────────────────────────────────┤
│                                                               │
│  plugins: [                                                  │
│    GraphiqlPlugin,                                           │
│    AssetServerPlugin,                                        │
│    EmailPlugin,                                              │
│    AdminUiPlugin,                                            │
│    StripePlugin,                                             │
│    GoogleAuthPlugin,                                         │
│    │                                                         │
│    └─ RateLimitPlugin  ◄──── Imports                        │
│                               │                             │
│  ]                            ▼                             │
│                        ┌────────────────────┐              │
│  apiOptions: {         │ RateLimitPlugin    │              │
│    graphQLPlayground: │ (src/plugins/)      │              │
│      IS_DEV,          ├────────────────────┤              │
│    graphQLIntrospection│                    │              │
│      IS_DEV           │ ├─ RateLimitModule │              │
│  }                    │ │  (NestJS Module)  │              │
│                       │ │                   │              │
└─────────────────────────│ ├─ Imports:       │──────────────┘
                        │ │  - ThrottlerModule
                        │ │  - CustomThrottlerGuard
                        │ │                   │
                        │ └─ Exports:        │
                        │    - RateLimitPlugin
                        └─────┬──────────────┘
                              │
                    ┌─────────┴──────────┐
                    │                    │
         ┌──────────▼──────────┐  ┌──────▼────────────┐
         │ throttler.config.ts │  │ rate-limit.       │
         │                     │  │ middleware.ts     │
         ├─────────────────────┤  ├───────────────────┤
         │ • getThrottlerConfig│  │ • Middleware      │
         │ • Environment aware │  │   helpers         │
         │ • Dev: 1000/min     │  │ • Stripe routes   │
         │ • Prod: 100/min     │  │ • Security config │
         └─────────────────────┘  └───────────────────┘
```

## Rate Limiting Flow Chart

```
REQUEST ARRIVES
      │
      ▼
╔═════════════════════════════════════╗
║ Check: Is Stripe Webhook?           ║
╚═════════════════════════════════════╝
      │                    │
    YES                   NO
      │                    │
      ▼                    ▼
  SKIP LIMIT          ╔════════════════════════════════╗
                      ║ Check: skipThrottle flag set?  ║
                      ╚════════════════════════════════╝
                           │                    │
                         YES                   NO
                           │                    │
                           ▼                    ▼
                       SKIP LIMIT           ╔═══════════════════╗
                                           ║ Check Rate Limit   ║
                                           ║ (100 req/min/IP)   ║
                                           ╚═══════════════════╝
                                                │          │
                                          PASS  │          │  FAIL
                                                ▼          ▼
                                            ✓ OK       ✗ 429
```

## Environment Configuration

```
┌─────────────────────────────────────────────────────────────┐
│                   ENVIRONMENT VARIABLES                      │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  DEVELOPMENT (APP_ENV=dev)                                 │
│  ├─ Rate Limit: 1000 requests/minute                       │
│  ├─ GraphQL Playground: ENABLED                            │
│  ├─ GraphQL Introspection: ENABLED                         │
│  ├─ Debug Mode: ENABLED                                    │
│  └─ Purpose: Testing & development                         │
│                                                              │
│  PRODUCTION (APP_ENV=prod)                                 │
│  ├─ Rate Limit: 100 requests/minute (configurable)        │
│  ├─ GraphQL Playground: DISABLED                           │
│  ├─ GraphQL Introspection: DISABLED                        │
│  ├─ Debug Mode: DISABLED                                   │
│  └─ Purpose: Safety & security                             │
│                                                              │
│  Override: THROTTLE_LIMIT_PER_MINUTE=<number>             │
│  Example: THROTTLE_LIMIT_PER_MINUTE=500 (custom limit)    │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## Route Protection Matrix

```
┌──────────────────────┬──────────────┬──────────────┐
│ Route                │ Rate Limited │ Reason       │
├──────────────────────┼──────────────┼──────────────┤
│ POST /shop-api/*     │ YES (100/min)│ API endpoint │
│ POST /admin-api/*    │ YES (100/min)│ API endpoint │
│ GET /assets/*        │ YES (100/min)│ Public files │
│ GET /graphql         │ YES (100/min)│ API endpoint │
│                      │              │              │
│ /payments/stripe/... │ NO           │ Critical     │
│ /stripe/webhook      │ NO           │ Webhook      │
│ /api/webhooks/stripe │ NO           │ Webhook      │
│                      │              │              │
│ /admin (UI)          │ YES (100/min)│ UI access    │
│ /graphql (dev)       │ YES (100/min)│ API endpoint │
│ /health              │ YES (100/min)│ Monitoring   │
└──────────────────────┴──────────────┴──────────────┘
```

## Security Layers

```
┌──────────────────────────────────────────────────────┐
│          PRODUCTION SECURITY STACK                    │
├──────────────────────────────────────────────────────┤
│                                                       │
│  Layer 1: Rate Limiting                             │
│  ├─ Prevents DDoS attacks                          │
│  ├─ Limits: 100 requests/minute per IP            │
│  ├─ Stripe webhooks: Exempt                        │
│  └─ Returns: HTTP 429 when exceeded                │
│                                                       │
│  Layer 2: GraphQL Security                         │
│  ├─ Introspection: DISABLED                        │
│  ├─ Playground: DISABLED                           │
│  ├─ Prevents: Schema discovery attacks            │
│  └─ Result: {errors: [{message: "..."}]}          │
│                                                       │
│  Layer 3: API Authentication                       │
│  ├─ Admin API: Requires token                      │
│  ├─ Shop API: Mostly public (auth optional)       │
│  └─ Webhooks: Require Stripe signature validation  │
│                                                       │
│  Layer 4: CORS Protection                          │
│  ├─ Configurable origins                          │
│  ├─ Credentials: Enabled                          │
│  └─ Methods: POST, GET, OPTIONS                    │
│                                                       │
└──────────────────────────────────────────────────────┘
```

## Deployment Architecture (Railway)

```
┌──────────────────────────────────────────────────────┐
│              RAILWAY DEPLOYMENT                       │
├──────────────────────────────────────────────────────┤
│                                                       │
│  ┌────────────────────────────────────────────┐    │
│  │         Railway Environment                │    │
│  ├────────────────────────────────────────────┤    │
│  │                                             │    │
│  │ ┌──────────────────────────────────────┐  │    │
│  │ │     NestJS/Vendure Application       │  │    │
│  │ │                                       │  │    │
│  │ │ ┌──────────────────────────────────┐ │  │    │
│  │ │ │  Rate Limiting Plugin            │ │  │    │
│  │ │ │  ├─ CustomThrottlerGuard         │ │  │    │
│  │ │ │  ├─ Stripe webhook bypass        │ │  │    │
│  │ │ │  └─ 100 req/min limit            │ │  │    │
│  │ │ └──────────────────────────────────┘ │  │    │
│  │ │                                       │  │    │
│  │ │ ┌──────────────────────────────────┐ │  │    │
│  │ │ │  GraphQL Security Settings       │ │  │    │
│  │ │ │  ├─ Introspection: false         │ │  │    │
│  │ │ │  └─ Playground: false            │ │  │    │
│  │ │ └──────────────────────────────────┘ │  │    │
│  │ │                                       │  │    │
│  │ │ ┌──────────────────────────────────┐ │  │    │
│  │ │ │  Shop API                        │ │  │    │
│  │ │ │  Admin API                       │ │  │    │
│  │ │ │  Stripe Webhooks (unthrottled)  │ │  │    │
│  │ │ └──────────────────────────────────┘ │  │    │
│  │ └──────────────────────────────────────┘ │  │    │
│  │                                             │    │
│  │ ┌──────────────────────────────────────┐  │    │
│  │ │     PostgreSQL Database              │  │    │
│  │ │     (No changes required)            │  │    │
│  │ └──────────────────────────────────────┘  │    │
│  └────────────────────────────────────────────┘    │
│                                                     │
│ Environment Variables:                           │
│ ├─ APP_ENV=prod                                │
│ ├─ THROTTLE_LIMIT_PER_MINUTE=100              │
│ ├─ DB_HOST, DB_PORT, DB_NAME, etc.            │
│ └─ STRIPE_SECRET_KEY, etc.                    │
│                                                     │
└──────────────────────────────────────────────────────┘
```

## Monitoring & Observability

```
┌──────────────────────────────────────────────────┐
│         MONITORING DASHBOARD                     │
├──────────────────────────────────────────────────┤
│                                                   │
│  1. Rate Limit Hits                            │
│     └─ Monitor 429 errors in logs              │
│                                                   │
│  2. Request Distribution                       │
│     └─ Requests per minute per IP             │
│                                                   │
│  3. Stripe Webhook Success                     │
│     └─ Check Stripe dashboard for 100% rate  │
│                                                   │
│  4. GraphQL Introspection Attempts             │
│     └─ Monitor denied introspection requests  │
│                                                   │
│  5. Performance Metrics                        │
│     ├─ Memory usage (should be stable)        │
│     ├─ CPU usage (should be <5%)              │
│     └─ Response time (should not change)      │
│                                                   │
└──────────────────────────────────────────────────┘
```

## Data Flow: Normal Request

```
Client Request
    │
    ├─ Method: POST /shop-api/query
    ├─ Headers: { 'Content-Type': 'application/json' }
    └─ Body: { query: "..." }
         │
         ▼
    CustomThrottlerGuard
         │
         ├─ Parse IP from request
         ├─ Check rate limit (in-memory store)
         │  └─ (100/min per IP)
         │
         ├─ If within limit:
         │  └─ Continue to API handler
         │
         └─ If exceeded:
            └─ Return HTTP 429
               └─ Headers: X-RateLimit-*
```

## Data Flow: Stripe Webhook

```
Stripe Event
    │
    ├─ Method: POST /payments/stripe/webhook
    ├─ Headers: { 'Stripe-Signature': '...' }
    └─ Body: { type: "charge.succeeded", ... }
         │
         ▼
    CustomThrottlerGuard
         │
         ├─ Check: Is Stripe webhook? ──YES──┐
         │                                    │
         └─ SKIP RATE LIMIT CHECK            │
                                             │
                                    ┌────────┘
                                    │
                                    ▼
                              Stripe Webhook Handler
                                    │
                                    ├─ Verify signature
                                    ├─ Process payment
                                    └─ Return 200 OK
```

---

This architecture ensures:
✅ **DDoS Protection** - Rate limits prevent floods  
✅ **API Security** - GraphQL hardened against introspection  
✅ **Webhook Reliability** - Stripe webhooks always process  
✅ **Performance** - Minimal overhead, in-memory caching  
✅ **Observability** - Clear monitoring points  
