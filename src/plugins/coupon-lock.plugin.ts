import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { GqlExecutionContext } from '@nestjs/graphql';
import {
    ACTIVE_ORDER_INPUT_FIELD_NAME,
    ActiveOrderService,
    internal_getRequestContext,
    Logger,
    PluginCommonModule,
    VendurePlugin,
} from '@vendure/core';
import { GraphQLError } from 'graphql';
import { Observable } from 'rxjs';

const loggerCtx = 'CouponLock';

/**
 * Safety valve. Set COUPON_LOCK_AFTER_CHECKOUT=false to allow coupon changes
 * in any state again (the pre-fix behaviour), from Railway, with no deploy.
 */
const ENABLED = process.env.COUPON_LOCK_AFTER_CHECKOUT !== 'false';

const LOCKED_MUTATIONS = new Set(['applyCouponCode', 'removeCouponCode']);

/**
 * Refuses coupon changes once checkout has started (BUG-T1/T2).
 *
 * The Stripe PaymentIntent is created for the order total at the payment step.
 * Vendure blocks addItemToOrder outside AddingItems, but applyCouponCode and
 * removeCouponCode have no state check and no strategy hook. Removing a coupon
 * after the intent existed made the order worth more than the intent: the
 * customer's money was captured, Vendure (correctly) refused to settle an
 * under-covered order, and the order sat in ArrangingPayment forever showing
 * "Payment Processing". Two browser tabs were enough to do it by accident.
 *
 * Implemented as an interceptor rather than a guard because interceptors run
 * after Vendure's AuthGuard, so the RequestContext (and session) exist.
 */
@Injectable()
export class CouponLockInterceptor implements NestInterceptor {
    constructor(private activeOrderService: ActiveOrderService) {}

    async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<any>> {
        if (!ENABLED || context.getType<string>() !== 'graphql') {
            return next.handle();
        }
        const gqlContext = GqlExecutionContext.create(context);
        const info = gqlContext.getInfo();
        if (info?.parentType?.name !== 'Mutation' || !LOCKED_MUTATIONS.has(info.fieldName)) {
            return next.handle();
        }
        const ctx = internal_getRequestContext(gqlContext.getContext().req, context);
        if (!ctx?.apiType || ctx.apiType !== 'shop') {
            return next.handle();
        }

        const order = await this.activeOrderService.getActiveOrder(
            ctx,
            gqlContext.getArgs()?.[ACTIVE_ORDER_INPUT_FIELD_NAME],
        );
        if (order && order.state !== 'AddingItems') {
            Logger.info(
                `Refused ${info.fieldName} on order ${order.code} in state ${order.state}.`,
                loggerCtx,
            );
            throw new GraphQLError(
                'Promotion codes cannot be changed once checkout has started.',
                { extensions: { code: 'ORDER_MODIFICATION_ERROR', orderState: order.state } },
            );
        }
        return next.handle();
    }
}

@VendurePlugin({
    imports: [PluginCommonModule],
    providers: [{ provide: APP_INTERCEPTOR, useClass: CouponLockInterceptor }],
})
export class CouponLockPlugin {}
