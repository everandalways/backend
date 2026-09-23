import {
    Injector,
    Order,
    OrderProcess,
    ProductVariantService,
    RequestContext,
    StockLevel,
    TransactionalConnection,
} from '@vendure/core';

/**
 * Serialises concurrent checkouts on the same variant, so two customers cannot
 * both be told "yes" for the last one.
 *
 * Vendure's default order process already refuses this transition when saleable
 * stock is short (`arrangingPaymentRequiresStock`, default-order-process.ts).
 * That check is a plain read, though: under READ COMMITTED two concurrent
 * transitions can both read `saleable = 1` before either allocates, and both
 * then allocate. This closes that window by taking a row lock on the variant's
 * stock BEFORE the saleable level is read, so the second transaction blocks
 * until the first has committed and then sees the reduced figure.
 *
 * IMPORTANT: the lock must be taken on the EntityManager bound to the current
 * transaction. `connection.rawConnection` is a different pooled connection —
 * using it here both fails to hold the lock and deadlocks the pool, because
 * every in-flight transition would hold one connection while waiting for a
 * second. The pool default is 10, so ten concurrent checkouts hang forever.
 * That regression took the site down on 2026-09-23; hence this comment.
 *
 * `transitionOrderToState` is wrapped in `@Transaction()` by Vendure's shop
 * resolver, so the lock is held until the allocation in onTransitionEnd commits.
 */
export class StockGuardOrderProcess implements OrderProcess<string> {
    private connection: TransactionalConnection;
    private productVariantService: ProductVariantService;

    init(injector: Injector): void {
        this.connection = injector.get(TransactionalConnection);
        this.productVariantService = injector.get(ProductVariantService);
    }

    async onTransitionStart(
        fromState: string,
        toState: string,
        data: { ctx: RequestContext; order: Order },
    ): Promise<string | void> {
        if (toState !== 'ArrangingPayment' || fromState === 'ArrangingPayment') {
            return;
        }
        const { ctx, order } = data;

        // Bound to the current transaction, so the lock lives until commit and
        // no extra pool connection is taken.
        const manager = this.connection.getRepository(ctx, StockLevel).manager;

        // Never let a wedged lock hang a checkout indefinitely; surfacing an
        // error is far better than holding the request open.
        await manager.query(`SET LOCAL lock_timeout = '5s'`);

        for (const line of order.lines) {
            const variantId = line.productVariantId;

            await manager.query(
                `SELECT 1 FROM stock_level WHERE "productVariantId" = $1 FOR UPDATE`,
                [variantId],
            );

            // Read AFTER the lock, using Vendure's own logic so trackInventory
            // and outOfStockThreshold are honoured exactly as elsewhere.
            const saleable = await this.productVariantService.getSaleableStockLevel(
                ctx,
                line.productVariant,
            );

            if (saleable < line.quantity) {
                const name = line.productVariant?.name ?? 'This item';
                return saleable <= 0
                    ? `${name} has just sold out. Please remove it from your order to continue.`
                    : `Only ${saleable} of ${name} remain. Please reduce the quantity to continue.`;
            }
        }
    }
}
