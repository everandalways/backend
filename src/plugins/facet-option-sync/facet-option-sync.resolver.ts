import { Args, Mutation, Resolver } from '@nestjs/graphql';
import { ID } from '@vendure/common/lib/shared-types';
import {
    Allow,
    Ctx,
    Permission,
    Product,
    RequestContext,
    Transaction,
    Translated,
} from '@vendure/core';
import { FacetOptionSyncService } from './facet-option-sync.service';

@Resolver()
export class FacetOptionSyncAdminResolver {
    constructor(private facetOptionSyncService: FacetOptionSyncService) {}

    @Transaction()
    @Mutation()
    @Allow(Permission.UpdateCatalog, Permission.UpdateProduct)
    syncProductOptionsFromFacets(
        @Ctx() ctx: RequestContext,
        @Args() args: { productId: ID },
    ): Promise<Translated<Product>> {
        return this.facetOptionSyncService.syncProductOptionsFromFacets(ctx, args.productId);
    }
}
