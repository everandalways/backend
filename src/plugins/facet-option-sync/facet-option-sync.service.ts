import { Injectable } from '@nestjs/common';
import { normalizeString } from '@vendure/common/lib/normalize-string';
import { ID } from '@vendure/common/lib/shared-types';
import {
    assertFound,
    Facet,
    FacetValue,
    Logger,
    Product,
    ProductOptionGroupService,
    ProductOptionService,
    ProductService,
    RequestContext,
    TransactionalConnection,
    Translated,
} from '@vendure/core';
import { loggerCtx, USED_FOR_VARIANT_OPTIONS_FIELD } from './constants';

export interface FacetOptionSyncResult {
    createdGroups: number;
    createdOptions: number;
}

/**
 * Creates product option groups/options from the facet values assigned to a product,
 * for facets which have the `usedForVariantOptions` custom field enabled.
 *
 * The sync is strictly additive and idempotent:
 * - an option group is matched by `code === facet.code`; created (and assigned to the
 *   product) only if missing
 * - an option is matched by `code === facetValue.code` within its group; created only
 *   if missing
 * - nothing is ever renamed or deleted (product variants may reference the options)
 */
@Injectable()
export class FacetOptionSyncService {
    constructor(
        private connection: TransactionalConnection,
        private productService: ProductService,
        private productOptionGroupService: ProductOptionGroupService,
        private productOptionService: ProductOptionService,
    ) {}

    /**
     * Entry point for the `syncProductOptionsFromFacets` Admin API mutation.
     */
    async syncProductOptionsFromFacets(ctx: RequestContext, productId: ID): Promise<Translated<Product>> {
        await this.ensureOptionsForProduct(ctx, productId);
        return assertFound(this.productService.findOne(ctx, productId));
    }

    async ensureOptionsForProduct(ctx: RequestContext, productId: ID): Promise<FacetOptionSyncResult> {
        const result: FacetOptionSyncResult = { createdGroups: 0, createdOptions: 0 };

        const product = await this.connection.getEntityOrThrow(ctx, Product, productId, {
            relations: [
                'facetValues',
                'facetValues.translations',
                'facetValues.facet',
                'facetValues.facet.translations',
            ],
            channelId: ctx.channelId,
        });

        const byFacet = this.groupOptedInFacetValues(product.facetValues ?? []);
        if (byFacet.size === 0) {
            return result;
        }

        const existingGroups = await this.productOptionGroupService.getOptionGroupsByProductId(
            ctx,
            productId,
        );

        for (const { facet, values } of byFacet.values()) {
            const groupCode = normalizeString(facet.code, '-');
            let group = existingGroups.find(g => normalizeString(g.code, '-') === groupCode);
            if (!group) {
                group = await this.productOptionGroupService.create(ctx, {
                    code: groupCode,
                    translations: facet.translations.map(t => ({
                        languageCode: t.languageCode,
                        name: t.name,
                    })),
                });
                await this.productService.addOptionGroupToProduct(ctx, productId, group.id);
                existingGroups.push(group);
                result.createdGroups++;
            }

            // getOptionGroupsByProductId includes soft-deleted options in group.options,
            // so they must be filtered out before matching by code.
            const existingOptionCodes = new Set(
                (group.options ?? [])
                    .filter(option => option.deletedAt == null)
                    .map(option => normalizeString(option.code, '-')),
            );
            for (const facetValue of values) {
                const optionCode = normalizeString(facetValue.code, '-');
                if (existingOptionCodes.has(optionCode)) {
                    continue;
                }
                await this.productOptionService.create(ctx, group.id, {
                    code: optionCode,
                    translations: facetValue.translations.map(t => ({
                        languageCode: t.languageCode,
                        name: t.name,
                    })),
                });
                existingOptionCodes.add(optionCode);
                result.createdOptions++;
            }
        }

        if (result.createdGroups > 0 || result.createdOptions > 0) {
            Logger.info(
                `Product ${String(productId)}: created ${result.createdGroups} option group(s) and ` +
                    `${result.createdOptions} option(s) from facet values`,
                loggerCtx,
            );
        }
        return result;
    }

    private groupOptedInFacetValues(
        facetValues: FacetValue[],
    ): Map<string, { facet: Facet; values: FacetValue[] }> {
        const byFacet = new Map<string, { facet: Facet; values: FacetValue[] }>();
        for (const facetValue of facetValues) {
            const facet = facetValue.facet;
            if (facet?.customFields?.[USED_FOR_VARIANT_OPTIONS_FIELD] !== true) {
                continue;
            }
            const key = String(facet.id);
            const entry = byFacet.get(key) ?? { facet, values: [] };
            entry.values.push(facetValue);
            byFacet.set(key, entry);
        }
        return byFacet;
    }
}
