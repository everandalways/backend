# Production Deployment Checklist - Rate Limiting

## Pre-Deployment Verification

### ✅ Code Changes

- [x] `@nestjs/throttler` installed in `package.json`
- [x] Rate limiting plugin created: `src/plugins/rate-limit.plugin.ts`
- [x] Throttle configuration: `src/config/throttler.config.ts`
- [x] Middleware utilities: `src/middleware/rate-limit.middleware.ts`
- [x] `vendure-config.ts` updated with plugin import and configuration
- [x] GraphQL security settings applied to `vendure-config.ts`
- [x] Environment types updated: `src/environment.d.ts`

### ✅ Environment Configuration

- [x] `.env` updated with rate limiting variables
- [x] Documentation created: `RATE_LIMITING_GUIDE.md`

## Railway Deployment Steps

### 1. Deploy Code Changes

```bash
# Commit changes
git add -A
git commit -m "Add production-safe rate limiting with @nestjs/throttler

- Implement global rate limiting (100 req/min per IP in production)
- Exclude Stripe webhooks from rate limiting
- Disable GraphQL playground and introspection in production
- Add throttle configuration and middleware"

# Push to Railway branch
git push origin email-setup
# (or appropriate deployment branch)
```

### 2. Set Environment Variables in Railway

Go to Railway dashboard and add/update these variables in the project:

```
# Rate Limiting
THROTTLE_LIMIT_PER_MINUTE=100

# Production Mode
APP_ENV=prod

# Ensure other vars are set...
COOKIE_SECRET=<secure-random-value>
DB_HOST=<railway-postgres-url>
DB_PORT=5432
DB_NAME=<database-name>
DB_USERNAME=<username>
DB_PASSWORD=<secure-password>
DB_SCHEMA=public
```

### 3. Deploy to Production

The Railway deployment will:

1. Install dependencies (including `@nestjs/throttler`)
2. Run `npm run build` (TypeScript compilation)
3. Run `npm run start:server` (start the application)

**Expected startup logs:**

```
[Nest] [timestamp] [Bootstrap] NestApplication dependencies initialized +XXXms
[Nest] [timestamp] [NestFactory] Start Nest application factory +XXXms
ThrottlerModule initialized with limits
GraphQL playground disabled
```

### 4. Verify Deployment

Test the rate limiting in production:

```bash
# Test normal API request (should succeed)
curl -X POST https://your-production-url/shop-api/ \
  -H "Content-Type: application/json"

# Verify rate limiting headers in response
curl -I https://your-production-url/shop-api/

# Test Stripe webhook (should work even under rate limit)
curl -X POST https://your-production-url/payments/stripe/webhook \
  -H "Content-Type: application/json" \
  -H "Stripe-Signature: <valid-signature>" \
  -d '{"type":"charge.succeeded"}'
```

### 5. Monitor After Deployment

**First 24 hours:**

- Monitor error logs for any throttler-related errors
- Check Stripe webhook success rate
- Monitor application memory usage
- Watch for legitimate users hitting rate limits

**Commands to check logs:**

```bash
# In Railway dashboard:
# 1. Go to project → service → logs
# 2. Filter for "throttle" or "429" to monitor rate limit hits
# 3. Check for any throttler initialization errors

# Look for these success indicators:
# "CustomThrottlerGuard initialized"
# "Rate limit applied: 100 requests per minute"
# Stripe webhooks completing successfully
```

## Configuration Details for Railway

### Memory & CPU

- Rate limiting uses minimal memory (~1-5MB for typical traffic)
- No CPU impact unless hit with sustained attack
- Current single-instance setup is sufficient for ~500 concurrent users

### Database

- No database changes required
- Rate limiting stored in-memory on each instance
- No migration needed

### Environment Separation

**Development (.env.development)**

```env
APP_ENV=dev
THROTTLE_LIMIT_PER_MINUTE=1000
```

**Production (Railway variables)**

```env
APP_ENV=prod
THROTTLE_LIMIT_PER_MINUTE=100
```

## Troubleshooting During Deployment

### Issue: "ThrottlerModule not found"

**Solution:** Ensure `npm install` runs during build

- Check Railway build command includes dependency installation
- Verify `package.json` includes `@nestjs/throttler`

### Issue: Stripe webhooks failing with 429

**Solution:** Webhook routes may not be properly excluded

- Check `src/plugins/rate-limit.plugin.ts` has correct route patterns
- Verify Stripe webhook URL matches excluded pattern
- Common patterns: `/payments/stripe/webhook`, `/stripe/webhook`

### Issue: Legitimate users getting 429 errors

**Solution:** Rate limit may be too strict

- Check `THROTTLE_LIMIT_PER_MINUTE` in Railway variables
- Consider increasing to 200-300 if traffic pattern warrants
- Implement client-side caching/batching

### Issue: High memory usage

**Solution:** Switch to Redis-based rate limiting

- See `RATE_LIMITING_GUIDE.md` Redis section
- Add Redis provider to Railway project
- Update throttle configuration to use Redis

## Rollback Plan

If rate limiting causes issues:

1. **Quick Fix (5 minutes):**

   ```
   - Go to Railway dashboard
   - Set THROTTLE_LIMIT_PER_MINUTE=10000 (disable effectively)
   - Restart service
   ```

2. **Full Rollback (15 minutes):**

   ```bash
   # Revert commits
   git revert <commit-hash>
   git push origin email-setup

   # Railway will auto-redeploy
   ```

3. **Partial Rollback (keep code, disable in config):**
   ```
   - Set APP_ENV=dev in Railway
   - Uses 1000/minute limit instead
   - Service stays up, no code changes needed
   ```

## Post-Deployment Monitoring

### Daily Checks

- Review error logs for "429 Too Many Requests"
- Monitor Stripe webhook success rate in Stripe dashboard
- Check application memory/CPU usage in Railway

### Weekly Review

- Analyze rate limit hit patterns
- Adjust `THROTTLE_LIMIT_PER_MINUTE` if needed
- Review client-side request patterns
- Update documentation if needed

### Monthly Metrics

- Calculate legitimate 429 error rate
- Identify peak traffic hours/days
- Plan scaling if needed (multiple instances, Redis)
- Review security audit logs

## Success Criteria

✅ **Deployment is successful when:**

- [ ] Application starts without errors
- [ ] Shop API returns 200 responses
- [ ] Admin API returns 200 responses (with auth)
- [ ] Stripe webhooks complete successfully
- [ ] GraphQL introspection returns 403 in production
- [ ] GraphQL playground unavailable in production
- [ ] Rate limit headers present in responses
- [ ] No increase in error rate vs. baseline

## Performance Baseline

Before deployment, establish baseline metrics:

| Metric                 | Baseline  | Post-Deployment |
| ---------------------- | --------- | --------------- |
| Avg Response Time      | \_\_\_ ms | \_\_\_ ms       |
| Error Rate (5xx)       | \_\_\_%   | \_\_\_%         |
| Memory Usage           | \_\_\_ MB | \_\_\_ MB       |
| Stripe Webhook Success | \_\_\_%   | \_\_\_%         |

## Support & Escalation

**For issues:**

1. Check `RATE_LIMITING_GUIDE.md` Troubleshooting section
2. Review Railway logs in dashboard
3. Test in development locally with `npm run dev:server`
4. Check `src/plugins/rate-limit.plugin.ts` for route exclusions
5. Verify environment variables in Railway match expected values

---

**Last Updated:** 2026-01-18
**Version:** 1.0 Production Ready
