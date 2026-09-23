import {
    Order,
    OrderState,
    RequestContext,
    StockAllocationStrategy,
} from '@vendure/core';

/**
 * Reserves stock as soon as an Order enters `ArrangingPayment`, instead of
 * waiting until payment has settled.
 *
 * Vendure's DefaultStockAllocationStrategy allocates on the transition
 * `ArrangingPayment -> PaymentAuthorized | PaymentSettled`, i.e. only after the
 * customer's card has already been charged. Carts reserve nothing, so the whole
 * checkout window is unguarded and two customers can both pay for the same
 * stock-of-1 item. Reproduced in test/e2e/inventory.test.ts (C2, C3).
 *
 * Reserving at the start of checkout closes that window. It is paired with:
 *   - StockGuardOrderProcess, which locks the stock row and rejects the
 *     transition if the item has just gone, and
 *   - the `expire-stale-checkouts` scheduled task, which releases reservations
 *     left behind by abandoned checkouts.
 *
 * All three are needed. This strategy alone would still allow two concurrent
 * transitions to both allocate, because allocation itself performs no stock
 * check (see StockMovementService.createAllocationsForOrderLines).
 */
export class ReserveAtCheckoutStrategy implements StockAllocationStrategy {
    shouldAllocateStock(
        ctx: RequestContext,
        fromState: OrderState,
        toState: OrderState,
        order: Order,
    ): boolean {
        return fromState !== 'ArrangingPayment' && toState === 'ArrangingPayment';
    }
}
