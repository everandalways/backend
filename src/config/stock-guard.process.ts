import {
    Injector,
    Order,
    OrderProcess,
    RequestContext,
    TransactionalConnection,
} from '@vendure/core';

/**
 * Refuses entry to `ArrangingPayment` when any line's item is no longer
 * available, and serialises concurrent checkouts so two customers cannot both
 * be told "yes" for the last one.
 *
 * Why a raw locking query rather than a service call: allocation in Vendure
 * performs no stock check at all, and a plain read of saleable stock is not
 * enough — under Postgres' default READ COMMITTED isolation, two concurrent
 * transactions can both read `saleable = 1` before either writes. `SELECT ...
 * FOR UPDATE` makes the second transition block until the first has committed
 * its allocation, at which point it sees `saleable = 0` and is rejected.
 *
 * `transitionOrderToState` is wrapped in `@Transaction()` by Vendure's shop
 * resolver, so the lock is held for the rest of the transition, including the
 * allocation performed in onTransitionEnd.
 *
 * Variants that do not track inventory are skipped entirely.
 */
export class StockGuardOrderProcess implements OrderProcess<string> {
    private connection: TransactionalConnection;

    init(injector: Injector): void {
        this.connection = injector.get(TransactionalConnection);
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

        for (const line of order.lines) {
            const variantId = line.productVariantId;

            // Lock every stock row for this variant, then total them up. The
            // lock is what serialises competing checkouts; the sum is what we
            // actually test against.
            const rows: Array<{ stockOnHand: string; stockAllocated: string }> =
                await this.connection.rawConnection.query(
                    `SELECT sl."stockOnHand", sl."stockAllocated"
                       FROM stock_level sl
                      WHERE sl."productVariantId" = $1
                        FOR UPDATE`,
                    [variantId],
                );

            if (!rows.length) {
                // No stock records means stock is not being tracked here.
                continue;
            }

            const [variant]: Array<{ trackInventory: string }> =
                await this.connection.rawConnection.query(
                    `SELECT "trackInventory" FROM product_variant WHERE id = $1`,
                    [variantId],
                );
            const [settings]: Array<{ trackInventory: boolean }> =
                await this.connection.rawConnection.query(
                    `SELECT "trackInventory" FROM global_settings LIMIT 1`,
                );

            const tracked =
                variant?.trackInventory === 'TRUE' ||
                (variant?.trackInventory === 'INHERIT' && settings?.trackInventory === true);
            if (!tracked) {
                continue;
            }

            const onHand = rows.reduce((sum, r) => sum + Number(r.stockOnHand), 0);
            const allocated = rows.reduce((sum, r) => sum + Number(r.stockAllocated), 0);
            const saleable = onHand - allocated;

            if (saleable < line.quantity) {
                const name = line.productVariant?.name ?? 'This item';
                return saleable <= 0
                    ? `${name} has just sold out. Please remove it from your order to continue.`
                    : `Only ${saleable} of ${name} remain. Please reduce the quantity to continue.`;
            }
        }
    }
}
