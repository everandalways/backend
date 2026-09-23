import { Logger, Order, OrderService, RequestContext, ScheduledTask, TransactionalConnection } from '@vendure/core';
import { IsNull, LessThan, Not } from 'typeorm';

const loggerCtx = 'ExpireStaleCheckouts';

/**
 * Minutes an order may sit in `ArrangingPayment` before its reserved stock is
 * released. Stripe PaymentIntents stay valid well beyond this, and a customer
 * who comes back can simply start checkout again.
 */
const STALE_AFTER_MINUTES = Number(process.env.CHECKOUT_EXPIRY_MINUTES ?? 30);

/**
 * Releases stock held by abandoned checkouts.
 *
 * Necessary because ReserveAtCheckoutStrategy reserves stock the moment a
 * customer reaches the payment step. Without this task, one abandoned checkout
 * would make a stock-of-1 diamond permanently unbuyable — the exact failure
 * already visible in production data, where variants 277 and 280 carried
 * stranded `stockAllocated` from old test orders.
 *
 * Orders that have taken a payment are never touched: those need a human, not a
 * cron job.
 */
export const expireStaleCheckoutsTask = new ScheduledTask({
    id: 'expire-stale-checkouts',
    description:
        'Cancels orders abandoned in ArrangingPayment so their reserved stock returns to sale.',
    schedule: cronTime => cronTime.every(10).minutes(),
    timeout: '2m',
    async execute({ injector, scheduledContext }) {
        const connection = injector.get(TransactionalConnection);
        const orderService = injector.get(OrderService);

        const cutoff = new Date(Date.now() - STALE_AFTER_MINUTES * 60_000);

        const stale = await connection.rawConnection.getRepository(Order).find({
            where: {
                state: 'ArrangingPayment',
                updatedAt: LessThan(cutoff),
            },
            relations: ['payments'],
            take: 100,
        });

        if (!stale.length) {
            return { cancelled: 0, skipped: 0 };
        }

        let cancelled = 0;
        let skipped = 0;

        for (const order of stale) {
            // Anything with money attached is left alone deliberately.
            const hasPayment = (order.payments ?? []).some(p =>
                ['Settled', 'Authorized'].includes(p.state),
            );
            if (hasPayment) {
                skipped++;
                Logger.warn(
                    `Order ${order.code} is stale in ArrangingPayment but has a ${
                        order.payments.find(p => ['Settled', 'Authorized'].includes(p.state))?.state
                    } payment — needs manual review.`,
                    loggerCtx,
                );
                continue;
            }

            const result = await orderService.cancelOrder(scheduledContext as RequestContext, {
                orderId: order.id,
                reason: 'Checkout abandoned — stock released automatically',
                cancelShipping: true,
            });

            if ((result as any).id) {
                cancelled++;
                Logger.info(`Released stock from abandoned checkout ${order.code}`, loggerCtx);
            } else {
                skipped++;
                Logger.warn(
                    `Could not cancel ${order.code}: ${(result as any).message ?? 'unknown error'}`,
                    loggerCtx,
                );
            }
        }

        return { cancelled, skipped, staleAfterMinutes: STALE_AFTER_MINUTES };
    },
});
