/**
 * Rate Limiting Middleware Configuration
 * 
 * This module provides middleware configuration for the Vendure API to handle:
 * 1. Stripe webhook exclusion from rate limiting
 * 2. Production security settings for GraphQL
 * 
 * Stripe webhooks are critical for payment processing and must not be
 * rate limited to avoid missing or delaying webhook events.
 */

import { Request, Response } from 'express';
import { Injectable, NestMiddleware } from '@nestjs/common';
import { ThrottlerStorageService } from '@nestjs/throttler';

/**
 * Middleware to skip rate limiting for the Stripe webhook route.
 *
 * Real Vendure StripePlugin webhook path: POST /payments/stripe
 * (Controller('payments') + Post('stripe') in
 * node_modules/@vendure/payments-plugin/package/stripe/stripe.controller.js).
 */
@Injectable()
export class StripeWebhookThrottleBypassMiddleware implements NestMiddleware {
    use(req: Request, res: Response, next: () => void) {
        // Mark Stripe webhook requests to skip throttling
        const isStripeWebhook = this.isStripeWebhookRequest(req);

        if (isStripeWebhook) {
            // Bypass rate limiting for Stripe webhooks
            res.setHeader('X-Throttle-Bypass', 'true');
            (req as any).skipThrottle = true;
        }

        next();
    }

    private isStripeWebhookRequest(req: Request): boolean {
        const path = req.path.toLowerCase();
        const method = req.method.toUpperCase();
        return method === 'POST' && path === '/payments/stripe';
    }
}
