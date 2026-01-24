import { PluginCommonModule, VendurePlugin } from '@vendure/core';
import { Module } from '@nestjs/common';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { ExecutionContext } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import { getThrottlerConfig } from '../config/throttler.config';

/**
 * RateLimitPlugin
 * 
 * Adds global rate limiting to the Vendure API using @nestjs/throttler.
 * Configuration:
 * - 100 requests per minute per IP in production
 * - 1000 requests per minute per IP in development
 * - Stripe webhook routes are excluded from rate limiting
 * 
 * Environment Variables:
 * - THROTTLE_LIMIT_PER_MINUTE: Override default request limit (default: 100 in prod, 1000 in dev)
 * 
 * Protected Routes:
 * - POST /admin-api/* (Admin API)
 * - POST /shop-api/* (Shop API)
 * 
 * Excluded Routes (no rate limiting):
 * - POST /payments/stripe/webhook (Stripe webhook processing)
 * - POST /stripe/webhook
 * - POST /api/webhooks/stripe
 */

/**
 * Custom ThrottlerGuard that skips rate limiting for Stripe webhooks
 * and properly handles IP extraction behind proxies (Railway)
 */
export class CustomThrottlerGuard extends ThrottlerGuard {
    /**
     * Override getRequestResponse to properly handle GraphQL context
     */
    getRequestResponse(context: ExecutionContext) {
        // Try GraphQL context first
        try {
            const gqlContext = GqlExecutionContext.create(context);
            const ctx = gqlContext.getContext();
            if (ctx?.req && ctx?.res) {
                return { req: ctx.req, res: ctx.res };
            }
        } catch {
            // Not a GraphQL context, continue to HTTP context
        }

        // Fall back to HTTP context
        return super.getRequestResponse(context);
    }

    /**
     * Override getTracker to properly extract IP from proxied requests
     */
    protected async getTracker(req: Record<string, any>): Promise<string> {
        // Handle undefined or null request
        if (!req) {
            return 'unknown';
        }

        // Try to get IP from various sources (handles Railway proxy)
        const ip =
            req.ip ||
            req.connection?.remoteAddress ||
            req.socket?.remoteAddress ||
            (req.headers?.['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
            req.headers?.['x-real-ip'] as string ||
            'unknown';

        return ip;
    }

    protected async shouldSkip(context: any): Promise<boolean> {
        // Try to get HTTP request, but handle cases where context is not HTTP (e.g., GraphQL)
        const httpContext = context.switchToHttp();
        if (!httpContext) {
            // Not an HTTP context, fall back to default behavior
            return super.shouldSkip(context);
        }

        const request = httpContext.getRequest();
        if (!request) {
            // No request object available, fall back to default behavior
            return super.shouldSkip(context);
        }

        // Skip throttling if explicitly marked (by middleware)
        if ((request as any).skipThrottle) {
            return true;
        }

        // Check if this is a Stripe webhook request
        const path = request.path?.toLowerCase();
        const method = request.method?.toUpperCase();

        if (method === 'POST' && path) {
            const stripeWebhookPatterns = [
                '/payments/stripe/webhook',
                '/stripe/webhook',
                '/api/webhooks/stripe',
            ];

            if (stripeWebhookPatterns.some(pattern => path.includes(pattern))) {
                return true;
            }
        }

        // Fall back to default behavior
        return super.shouldSkip(context);
    }
}

@Module({
    imports: [
        ThrottlerModule.forRoot(getThrottlerConfig()),
    ],
    providers: [
        {
            provide: APP_GUARD,
            useClass: CustomThrottlerGuard,
        },
    ],
})
export class RateLimitModule { }

@VendurePlugin({
    imports: [PluginCommonModule, RateLimitModule],
})
export class RateLimitPlugin { }
