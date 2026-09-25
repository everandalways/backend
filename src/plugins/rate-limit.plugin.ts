import { PluginCommonModule, VendurePlugin } from '@vendure/core';
import { Module } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerLimitDetail, ThrottlerModule } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { ExecutionContext } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import { GraphQLError } from 'graphql';
import { getThrottlerConfig, graphqlOperation } from '../config/throttler.config';

/**
 * RateLimitPlugin
 *
 * Rate limits the Shop and Admin APIs with @nestjs/throttler (in-memory store —
 * the backend runs as a single server process, so that store is authoritative).
 *
 * Two limits, both per client IP and per operation (see throttler.config.ts):
 * - global: THROTTLE_LIMIT_PER_MINUTE (default 1000)
 * - login:  THROTTLE_LOGIN_LIMIT_PER_MINUTE (default 100), auth mutations only
 *
 * Excluded: POST /payments/stripe, the Vendure StripePlugin webhook (verified
 * against node_modules/@vendure/payments-plugin/.../stripe.controller.js).
 */

/**
 * Header carrying the real client IP. Railway's edge overwrites X-Real-IP with
 * the connecting address, so clients cannot spoof it. Settable so it can be
 * changed from Railway without a deploy if the edge's behaviour ever changes.
 */
const CLIENT_IP_HEADER = (process.env.THROTTLE_CLIENT_IP_HEADER || 'x-real-ip').toLowerCase();

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
     * The client's IP.
     *
     * NOT req.ip: behind Railway that resolves to a proxy hop whose address
     * changes from request to request, so every request landed in a near-empty
     * bucket and nothing was ever throttled (1,500/min sailed through a
     * 1,000/min limit, with the remaining-count header jumping up and down).
     */
    protected async getTracker(req: Record<string, any>): Promise<string> {
        if (!req) {
            return 'unknown';
        }
        const header = req.headers?.[CLIENT_IP_HEADER];
        const fromHeader = (Array.isArray(header) ? header[0] : header)?.split(',')[0]?.trim();
        return fromHeader || req.ip || req.socket?.remoteAddress || 'unknown';
    }

    /**
     * GraphQL would otherwise report a throttled request as HTTP 200 with the
     * error in the body, invisible to monitoring and to the k6 probe. Apollo
     * turns `extensions.http.status` into the response status.
     */
    protected async throwThrottlingException(
        context: ExecutionContext,
        detail: ThrottlerLimitDetail,
    ): Promise<void> {
        if (graphqlOperation(context)) {
            throw new GraphQLError('Too many requests. Please wait a moment and try again.', {
                extensions: { code: 'TOO_MANY_REQUESTS', http: { status: 429 } },
            });
        }
        return super.throwThrottlingException(context, detail);
    }

    protected async shouldSkip(context: ExecutionContext): Promise<boolean> {
        const op = graphqlOperation(context);
        if (op) {
            // Vendure runs guards on field resolvers as well (fieldResolverEnhancers:
            // ['guards']). Counting those would charge one product listing dozens
            // of hits, so only top-level operations count.
            return op.parent !== 'Query' && op.parent !== 'Mutation';
        }

        const request = context.switchToHttp().getRequest();
        if (!request) {
            return super.shouldSkip(context);
        }

        // Skip throttling if explicitly marked (by middleware)
        if ((request as any).skipThrottle) {
            return true;
        }

        // Real Vendure StripePlugin webhook path: POST /payments/stripe
        // (Controller('payments') + Post('stripe') in
        // node_modules/@vendure/payments-plugin/package/stripe/stripe.controller.js).
        // Use === rather than includes() to avoid accidentally bypassing throttle
        // for unrelated sub-paths.
        if (request.method?.toUpperCase() === 'POST' && request.path?.toLowerCase() === '/payments/stripe') {
            return true;
        }

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
