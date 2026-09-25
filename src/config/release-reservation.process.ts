import {
    Allocation,
    ID,
    Injector,
    Logger,
    Order,
    OrderProcess,
    Release,
    RequestContext,
    Sale,
    StockMovementService,
    TransactionalConnection,
} from '@vendure/core';
import { In } from 'typeorm';

const loggerCtx = 'ReleaseReservation';

/**
 * Safety valve. Set RELEASE_RESERVATION_ON_EXIT=false to stop releasing stock
 * when a checkout is abandoned — the transition itself is never blocked either
 * way, so turning this off cannot break checkout; it only brings back the leak.
 */
const ENABLED = process.env.RELEASE_RESERVATION_ON_EXIT !== 'false';

/**
 * Returns stock reserved by ReserveAtCheckoutStrategy when a checkout is left
 * without paying: `ArrangingPayment -> Cancelled` or `-> AddingItems`.
 *
 * Vendure does not do this itself. Its `cancelOrder` only creates Releases for
 * orders that are no longer `active`, because under the default strategy an
 * active order has nothing allocated. An order in ArrangingPayment is still
 * active, so cancelling it just flips the state and the reservation stays on
 * `stockAllocated` forever. That is how the expire-stale-checkouts task — whose
 * whole purpose is to free that stock — was leaking it instead: every stale
 * checkout it cancelled kept its units (≈150 found in production on 2026-09-25).
 *
 * Going back to AddingItems has the same hole, and worse: re-entering checkout
 * allocates a second time, so on a stock-of-1 diamond StockGuardOrderProcess
 * would tell the same customer it had "just sold out".
 *
 * The amount released is read from the stock-movement ledger (allocations +
 * sales − releases, the same sum Vendure's own OrderModifier uses), so it is
 * idempotent: if anything has already released the stock, this releases nothing.
 */
export class ReleaseReservationOrderProcess implements OrderProcess<string> {
    private connection: TransactionalConnection;
    private stockMovementService: StockMovementService;

    init(injector: Injector): void {
        this.connection = injector.get(TransactionalConnection);
        this.stockMovementService = injector.get(StockMovementService);
    }

    async onTransitionEnd(
        fromState: string,
        toState: string,
        data: { ctx: RequestContext; order: Order },
    ): Promise<void> {
        if (!ENABLED || fromState !== 'ArrangingPayment') {
            return;
        }
        if (toState !== 'Cancelled' && toState !== 'AddingItems') {
            return;
        }
        const { ctx, order } = data;
        const lineIds = (order.lines ?? []).map(l => l.id);
        if (!lineIds.length) {
            return;
        }

        const held = await this.heldPerLine(ctx, lineIds);
        const toRelease = [...held.entries()]
            .filter(([, quantity]) => quantity > 0)
            .map(([orderLineId, quantity]) => ({ orderLineId, quantity }));
        if (!toRelease.length) {
            return;
        }

        await this.stockMovementService.createReleasesForOrderLines(ctx, toRelease);
        Logger.info(
            `Order ${order.code} left checkout (${fromState} -> ${toState}); released ` +
                `${toRelease.reduce((n, l) => n + l.quantity, 0)} reserved unit(s).`,
            loggerCtx,
        );
    }

    /** Net units still allocated per order line. Bound to the current transaction. */
    private async heldPerLine(ctx: RequestContext, lineIds: ID[]): Promise<Map<ID, number>> {
        const where = { orderLine: { id: In(lineIds) } };
        const relations = ['orderLine'];
        // Sequential on purpose: all three share the transaction's one connection.
        const allocations = await this.connection.getRepository(ctx, Allocation).find({ where, relations });
        const sales = await this.connection.getRepository(ctx, Sale).find({ where, relations });
        const releases = await this.connection.getRepository(ctx, Release).find({ where, relations });

        const held = new Map<ID, number>();
        const add = (id: ID, qty: number) => held.set(id, (held.get(id) ?? 0) + qty);
        // Sale quantities are stored negative; Allocation and Release positive.
        allocations.forEach(a => add(a.orderLine.id, a.quantity));
        sales.forEach(s => add(s.orderLine.id, s.quantity));
        releases.forEach(r => add(r.orderLine.id, -r.quantity));
        return held;
    }
}
