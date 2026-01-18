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
 * Middleware to skip rate limiting for Stripe webhook routes
 * 
 * Routes excluded from throttling:
 * - /payments/stripe/webhook
 * - Any other Stripe-related webhook paths
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
        
        // Stripe webhooks use POST method
        if (method !== 'POST') {
            return false;
        }

        // Check for common Stripe webhook paths
        const stripeWebhookPatterns = [
            '/payments/stripe/webhook',
            '/stripe/webhook',
            '/api/webhooks/stripe',
        ];

        return stripeWebhookPatterns.some(pattern => path.includes(pattern));
    }
}

/**
 * Configuration constants for production security
 */
export const PRODUCTION_SECURITY_CONFIG = {
    // Disable GraphQL Playground in production
    graphQLPlayground: false,
    
    // Disable GraphQL introspection queries in production
    // This prevents attackers from discovering the schema
    graphQLIntrospection: false,
    
    // Enable detailed error messages only in development
    graphQLDebug: false,
    
    // Rate limiting settings (per minute per IP)
    rateLimiting: {
        development: 1000,
        production: 100,
    },
};

/**
 * Helper function to get security configuration based on environment
 */
export const getProductionSecurityConfig = (isDev: boolean) => ({
    ...PRODUCTION_SECURITY_CONFIG,
    graphQLPlayground: isDev,
    graphQLIntrospection: isDev,
    graphQLDebug: isDev,
});
