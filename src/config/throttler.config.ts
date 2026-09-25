import { ExecutionContext } from '@nestjs/common';
import { GqlContextType, GqlExecutionContext } from '@nestjs/graphql';
import { ThrottlerModuleOptions } from '@nestjs/throttler';

/**
 * Mutations that guess or spend credentials, or send email. They get their own,
 * much tighter bucket so a password can't be brute-forced at the global rate.
 */
export const AUTH_MUTATIONS = new Set([
    'login',
    'authenticate',
    'registerCustomerAccount',
    'requestPasswordReset',
    'resetPassword',
]);

/** The top-level GraphQL field being executed, e.g. `Mutation.login`; undefined outside GraphQL. */
export function graphqlOperation(context: ExecutionContext): { parent?: string; field?: string } | undefined {
    if (context.getType<GqlContextType>() !== 'graphql') {
        return undefined;
    }
    const info = GqlExecutionContext.create(context).getInfo();
    return { parent: info?.parentType?.name, field: info?.fieldName };
}

function isAuthMutation(context: ExecutionContext): boolean {
    const op = graphqlOperation(context);
    return op?.parent === 'Mutation' && AUTH_MUTATIONS.has(op.field ?? '');
}

/**
 * Limits are per client IP and per operation (the guard keys on resolver + IP),
 * so one busy query cannot starve the others.
 *
 * Note that all server-rendered storefront traffic reaches the backend from a
 * few Vercel egress IPs, so for the storefront these are effectively site-wide
 * buckets. Measured normal traffic is ~10 req/s in total, so the global default
 * leaves ample headroom per operation.
 */
export const getThrottlerConfig = (): ThrottlerModuleOptions => [
    {
        name: 'global',
        ttl: 60_000,
        limit: parseInt(process.env.THROTTLE_LIMIT_PER_MINUTE || '1000', 10),
    },
    {
        name: 'login',
        ttl: 60_000,
        limit: parseInt(process.env.THROTTLE_LOGIN_LIMIT_PER_MINUTE || '100', 10),
        skipIf: context => !isAuthMutation(context),
    },
];
