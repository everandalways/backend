import {
    dummyPaymentHandler,
    DefaultJobQueuePlugin,
    DefaultSchedulerPlugin,
    DefaultSearchPlugin,
    VendureConfig,
} from '@vendure/core';
import { defaultEmailHandlers, EmailPlugin, FileBasedTemplateLoader } from '@vendure/email-plugin';
import { AssetServerPlugin } from '@vendure/asset-server-plugin';
import { AdminUiPlugin } from '@vendure/admin-ui-plugin';
import { GraphiqlPlugin } from '@vendure/graphiql-plugin';
import 'dotenv/config';
import path from 'path';
import { StripePlugin } from '@vendure/payments-plugin/package/stripe';
import { GoogleAuthPlugin } from './plugins/google-auth.plugin';
import { RateLimitPlugin } from './plugins/rate-limit.plugin';

const IS_DEV = process.env.APP_ENV === 'dev';
const serverPort = +process.env.PORT || 3000;
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
            assetUploadDir: path.join(__dirname, '../static/assets'),
            // For local dev, the correct value for assetUrlPrefix should
            // be guessed correctly, but for production it will usually need
            // to be set manually to match your production url.
            assetUrlPrefix: IS_DEV ? undefined : process.env.ASSET_URL_PREFIX || (backendUrl ? `${backendUrl}/assets/` : undefined),
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
                    user: 'orders@everandalways.store',
                    pass: 'Saif.110tmkfc',
                },
            },
            handlers: defaultEmailHandlers,
            templateLoader: new FileBasedTemplateLoader(path.join(__dirname, '../static/email/templates')),
            globalTemplateVars: {
                fromAddress: '"Ever & Always" <orders@everandalways.store>',
                verifyEmailAddressUrl: `${frontendUrl}/verify`,
                passwordResetUrl: `${frontendUrl}/account/password`,
                changeEmailAddressUrl: `${frontendUrl}/verify-email-change`
            },
        }),
        // Uncomment the following to enable Stripe payments.
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
