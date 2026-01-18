import { ThrottlerModuleOptions } from '@nestjs/throttler';

const IS_PROD = process.env.APP_ENV === 'prod';

export const throttlerConfig: ThrottlerModuleOptions = [
    {
        name: 'global',
        ttl: 60000, // 60 seconds in milliseconds
        limit: 100, // 100 requests per minute per IP
    },
];

export const getThrottlerConfig = (): ThrottlerModuleOptions => {
    if (IS_PROD) {
        return [
            {
                name: 'global',
                ttl: 60000, // 60 seconds
                limit: parseInt(process.env.THROTTLE_LIMIT_PER_MINUTE || '100', 10),
            },
        ];
    }
    
    // In development, use a higher limit
    return [
        {
            name: 'global',
            ttl: 60000,
            limit: parseInt(process.env.THROTTLE_LIMIT_PER_MINUTE || '1000', 10),
        },
    ];
};
