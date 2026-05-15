import {
    dummyPaymentHandler,
    DefaultJobQueuePlugin,
    DefaultSchedulerPlugin,
    DefaultSearchPlugin,
    VendureConfig,
} from '@vendure/core';
import { defaultEmailHandlers, EmailPlugin, FileBasedTemplateLoader } from '@vendure/email-plugin';
import { AssetServerPlugin, configureS3AssetStorage } from '@vendure/asset-server-plugin';
import { AdminUiPlugin } from '@vendure/admin-ui-plugin';
import { GraphiqlPlugin } from '@vendure/graphiql-plugin';
import 'dotenv/config';
import path from 'path';
import { StripePlugin } from '@vendure/payments-plugin/package/stripe';
import { GoogleAuthPlugin } from './plugins/google-auth.plugin';
import { RateLimitPlugin } from './plugins/rate-limit.plugin';

function assertRequiredEnv(): void {
    if (process.env.APP_ENV === 'dev') {
        return;
    }

    const issues: string[] = [];

    const cookieSecret = process.env.COOKIE_SECRET;
    if (!cookieSecret) {
        issues.push('COOKIE_SECRET is missing or empty');
    } else if (cookieSecret.length < 32) {
        issues.push(`COOKIE_SECRET must be at least 32 characters (got ${cookieSecret.length})`);
    }

    if (!process.env.SUPERADMIN_USERNAME) {
        issues.push('SUPERADMIN_USERNAME is missing or empty');
    }

    const superadminPassword = process.env.SUPERADMIN_PASSWORD;
    if (!superadminPassword) {
        issues.push('SUPERADMIN_PASSWORD is missing or empty');
    } else if (superadminPassword.length < 16) {
        issues.push(`SUPERADMIN_PASSWORD must be at least 16 characters (got ${superadminPassword.length})`);
    }

    const simpleRequired = [
        'DB_HOST',
        'DB_PORT',
        'DB_NAME',
        'DB_USERNAME',
        'DB_PASSWORD',
        'SMTP_USER',
        'SMTP_PASS',
    ] as const;
    for (const name of simpleRequired) {
        if (!process.env[name]) {
            issues.push(`${name} is missing or empty`);
        }
    }

    const frontendUrl = process.env.FRONTEND_URL;
    if (!frontendUrl) {
        issues.push('FRONTEND_URL is missing or empty');
    } else {
        let parsed: URL | undefined;
        try {
            parsed = new URL(frontendUrl);
        } catch {
            issues.push(`FRONTEND_URL is not a valid URL: "${frontendUrl}"`);
        }
        if (parsed && parsed.protocol !== 'https:') {
            issues.push(`FRONTEND_URL must use https:// in production (got "${frontendUrl}")`);
        }
    }

    if (issues.length > 0) {
        throw new Error(
            [
                '[STARTUP] Refusing to boot: the following required environment variables are missing or invalid:',
                ...issues.map(issue => `  - ${issue}`),
            ].join('\n'),
        );
    }
}

assertRequiredEnv();

const IS_DEV = process.env.APP_ENV === 'dev';
const serverPort = +process.env.PORT || 3000;

// Validate R2 config at startup so failures are obvious immediately
if (process.env.R2_BUCKET_NAME) {
    const r2endpoint = process.env.R2_ENDPOINT?.trim();
    if (!r2endpoint) {
        throw new Error('[R2] R2_ENDPOINT env var is missing or empty');
    }
    try {
        new URL(r2endpoint);
    } catch {
        throw new Error(`[R2] R2_ENDPOINT is not a valid URL: "${r2endpoint}"`);
    }
    console.log(`[R2] Configured — bucket: ${process.env.R2_BUCKET_NAME}, endpoint: ${r2endpoint}`);
}

// In production, R2 is mandatory — fail loud at startup rather than silently
// falling back to ephemeral local disk (which loses uploads on redeploy).
if (!IS_DEV) {
    const requiredR2Vars = [
        'R2_BUCKET_NAME',
        'R2_ACCESS_KEY_ID',
        'R2_SECRET_ACCESS_KEY',
        'R2_ENDPOINT',
        'R2_PUBLIC_URL',
    ] as const;
    for (const varName of requiredR2Vars) {
        if (!process.env[varName]?.trim()) {
            throw new Error(`[R2] ${varName} env var is required in production (APP_ENV !== 'dev') but is missing or empty`);
        }
    }
}

const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:8002';

// Auto-detect Railway URL if BACKEND_URL is not set
// Railway provides RAILWAY_PUBLIC_DOMAIN automatically
const getBackendUrl = () => {
    if (IS_DEV) {
        return process.env.BACKEND_URL || 'http://localhost:3000';
    }

    // In production, try to get URL from environment
    if (process.env.BACKEND_URL) {
        return process.env.BACKEND_URL.replace(/:\d+$/, ''); // Remove port
    }

    // Railway automatically provides this
    if (process.env.RAILWAY_PUBLIC_DOMAIN) {
        return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
    }

    // Fallback: use relative URLs (Admin UI and API on same domain)
    return undefined;
};

const backendUrl = getBackendUrl();

export const config: VendureConfig = {
    apiOptions: {
        hostname: process.env.HOST || '0.0.0.0', // Bind to all interfaces for Railway
        port: serverPort,
        adminApiPath: 'admin-api',
        shopApiPath: 'shop-api',
        trustProxy: IS_DEV ? false : 1,
        cors: {
            origin: IS_DEV
                ? ['http://localhost:3000', 'http://localhost:8002']
                : [frontendUrl, backendUrl].filter((url): url is string => url !== undefined), // Filter out undefined values
            credentials: true,
        },
        // The following options are useful in development mode,
        // but are best turned off for production for security
        // reasons.
        ...(IS_DEV ? {
            adminApiDebug: true,
            shopApiDebug: true,
        } : {}),
    },
    authOptions: {
        tokenMethod: ['bearer', 'cookie'],
        requireVerification: true,
        superadminCredentials: {
            identifier: process.env.SUPERADMIN_USERNAME,
            password: process.env.SUPERADMIN_PASSWORD,
        },
        cookieOptions: {
            secret: process.env.COOKIE_SECRET,
        },
    },
    dbConnectionOptions: {
        type: 'postgres',
        // See the README.md "Migrations" section for an explanation of
        // the `synchronize` and `migrations` options.
        synchronize: false,
        migrations: [path.join(__dirname, './migrations/*.+(js|ts)')],
        logging: false,
        database: process.env.DB_NAME,
        schema: process.env.DB_SCHEMA,
        host: process.env.DB_HOST,
        port: +process.env.DB_PORT,
        username: process.env.DB_USERNAME,
        password: process.env.DB_PASSWORD,
    },
    paymentOptions: {
        paymentMethodHandlers: [dummyPaymentHandler],
    },
    // When adding or altering custom field definitions, the database will
    // need to be updated. See the "Migrations" section in README.md.
    customFields: {},
    plugins: [
        // GraphQL Playground - only enabled in development
        ...(IS_DEV ? [GraphiqlPlugin.init()] : []),
        AssetServerPlugin.init({
            route: 'assets',
            // In prod this is a transient buffer for multipart upload reassembly and
            // image-transform processing only — actual persistent storage is R2.
            assetUploadDir: IS_DEV
                ? path.join(__dirname, '../static/assets')
                : '/tmp/vendure-assets',
            assetUrlPrefix: process.env.R2_PUBLIC_URL?.trim(),
            storageStrategyFactory: process.env.R2_BUCKET_NAME
                ? configureS3AssetStorage({
                    bucket: process.env.R2_BUCKET_NAME,
                    credentials: {
                        accessKeyId: process.env.R2_ACCESS_KEY_ID!,
                        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
                    },
                    nativeS3Configuration: {
                        region: 'auto',
                        endpoint: process.env.R2_ENDPOINT?.trim(),
                        forcePathStyle: true,
                    },
                })
                : undefined,
        }),
        DefaultSchedulerPlugin.init(),
        DefaultJobQueuePlugin.init({ useDatabaseForBuffer: true }),
        DefaultSearchPlugin.init({ bufferUpdates: false, indexStockStatus: true }),
        EmailPlugin.init({

            transport: {
                type: 'smtp',
                host: 'smtp.hostinger.com',
                port: 465,
                secure: true,  // true for port 465
                auth: {
                    user: process.env.SMTP_USER,
                    pass: process.env.SMTP_PASS,
                },
            },
            handlers: defaultEmailHandlers,
            templateLoader: new FileBasedTemplateLoader(path.join(__dirname, '../static/email/templates')),
            globalTemplateVars: {
                fromAddress: `"Ever & Always" <${process.env.SMTP_USER}>`,
                verifyEmailAddressUrl: `${frontendUrl}/verify`,
                passwordResetUrl: `${frontendUrl}/account/password`,
                changeEmailAddressUrl: `${frontendUrl}/verify-email-change`
            },
        }),
        // Stripe payments configuration
        // Note: API key and webhook secret are configured in Admin UI → Settings → Payment Methods
        // The plugin itself only needs minimal configuration here
        StripePlugin.init({
            storeCustomersInStripe: true,
        }),
        AdminUiPlugin.init({
            route: 'admin',
            port: IS_DEV ? serverPort + 2 : serverPort, // In production, use same port as API
            adminUiConfig: {
                apiHost: IS_DEV ? undefined : backendUrl, // Use BACKEND_URL in production (without port)
                apiPort: IS_DEV ? serverPort : undefined, // Don't specify port in production (Railway handles it)
                brand: 'Ever & Always', // Replace with your client's brand name
                hideVendureBranding: true,   // This removes Vendure branding
                hideVersion: true,           // Hides version info
            },
            // app: {
            //     // We'll add custom CSS and branding here
            // }
        }),
        GoogleAuthPlugin,
        RateLimitPlugin,
    ],
};
