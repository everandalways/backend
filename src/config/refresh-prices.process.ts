import {
    Injector,
    Order,
    OrderProcess,
    OrderService,
    ProductVariantService,
    RequestContext,
    TransactionalConnection,
    OrderLine,
    ConfigService,
    Logger,
} from '@vendure/core';

const loggerCtx = 'RefreshPrices';

/**
 * Safety valve. Set REPRICE_BLOCK_ON_CHANGE=false to keep refreshing prices but
 * stop refusing the transition.
 *
 * The blast radius if the comparison below is ever wrong — if calculateUnitPrice
 * returns something different from the stored listPrice for an UNCHANGED variant
 * — is that every checkout is refused. This flag lets that be switched off from
 * Railway in seconds, with no deploy. Prices still get refreshed either way, so
 * the merchant is never underpaid; only the "please confirm" step is skipped.
 */
const BLOCK_ON_CHANGE = process.env.REPRICE_BLOCK_ON_CHANGE !== 'false';

/**
 * Stops a customer being charged a price they never saw.
 *
 * Vendure snapshots a variant's price onto the OrderLine when the item is added
 * and only refreshes it when the line is *touched*. A cart that is merely
 * re-read keeps the old price, and that stale price is what the Stripe
 * PaymentIntent gets created for. Measured: a cart held at $255.00 while the
 * variant was listed at $1000.00 (see test/e2e/money.test.ts A5).
 *
 * On entry to ArrangingPayment this re-prices every line from the current
 * variant price. If anything changed it then REFUSES the transition with a
 * readable message, rather than silently charging the new amount.
 *
 * That refusal is deliberate. Silently re-pricing would fix the merchant's
 * exposure by moving it onto the customer — someone who reviewed a $500 ring
 * would be charged $600 without being told. Refusing means the storefront
 * re-reads the order, the customer sees the new total, and confirms again. The
 * second attempt finds nothing stale and proceeds.
 *
 * The price-refresh logic mirrors what Vendure's own OrderModifier does when a
 * line is adjusted, so behaviour stays consistent with the rest of the system.
 */
export class RefreshPricesOrderProcess implements OrderProcess<string> {
    private injector: Injector;
    private connection: TransactionalConnection;
    private productVariantService: ProductVariantService;
    private configService: ConfigService;

    init(injector: Injector): void {
        // OrderService is resolved lazily in the hook: resolving it here risks a
        // circular dependency, because OrderService itself constructs the state
        // machine that owns this process.
        this.injector = injector;
        this.connection = injector.get(TransactionalConnection);
        this.productVariantService = injector.get(ProductVariantService);
        this.configService = injector.get(ConfigService);
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
        if (!order.lines?.length) {
            return;
        }

        const { orderItemPriceCalculationStrategy } = this.configService.orderOptions;
        const changed: Array<{ name: string; from: number; to: number }> = [];

        for (const line of order.lines) {
            const variant = await this.productVariantService.applyChannelPriceAndTax(
                line.productVariant,
                ctx,
                order,
            );
            const priceResult = await orderItemPriceCalculationStrategy.calculateUnitPrice(
                ctx,
                variant,
                line.customFields || {},
                order,
                line.quantity,
            );
            if (priceResult.price !== line.listPrice) {
                changed.push({
                    name: line.productVariant?.name ?? `line ${line.id}`,
                    from: line.listPrice,
                    to: priceResult.price,
                });
                line.listPrice = priceResult.price;
                line.listPriceIncludesTax = priceResult.priceIncludesTax;
            }
        }

        if (!changed.length) {
            return;
        }

        // Persist the refreshed prices and recalculate totals, so the very next
        // read of the order shows the customer what it now actually costs.
        await this.connection.getRepository(ctx, OrderLine).save(order.lines, { reload: false });
        const orderService = this.injector.get(OrderService);
        await orderService.applyPriceAdjustments(ctx, order);

        for (const c of changed) {
            Logger.info(
                `Order ${order.code}: "${c.name}" re-priced ${c.from} -> ${c.to} at checkout; asking the customer to confirm.`,
                loggerCtx,
            );
        }

        if (!BLOCK_ON_CHANGE) {
            Logger.warn(
                `REPRICE_BLOCK_ON_CHANGE=false — order ${order.code} re-priced silently and allowed to proceed.`,
                loggerCtx,
            );
            return;
        }

        const names = changed.map(c => c.name).join(', ');
        return changed.length === 1
            ? `The price of ${names} has changed since you added it. Please review your updated total and confirm.`
            : `Prices have changed for: ${names}. Please review your updated total and confirm.`;
    }
}
