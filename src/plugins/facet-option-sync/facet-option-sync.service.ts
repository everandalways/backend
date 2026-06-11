import { Injectable } from '@nestjs/common';
import { CreateProductVariantInput } from '@vendure/common/lib/generated-types';
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
    ProductVariantService,
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
        private productVariantService: ProductVariantService,
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

    /**
     * Creates one DISABLED variant per combination of the product's option groups,
     * for products which do not yet have any option-bearing variant (i.e. freshly
     * created products carrying only the Admin UI's default option-less placeholder
     * variant). Returns the number of variants created.
     *
     * - price / tax category / inventory tracking are copied from the placeholder
     *   variant, so nothing can go live with an unreviewed price
     * - SKUs are deterministic (`<product-slug>-<option-codes>`) and editable
     * - each variant is assigned the facet values matching its options
     *   (variant-level facets, same pattern as the CSV import's variantFacets)
     * - products which already have variants with options are never touched
     * - only runs for products using the facet->option workflow (at least one
     *   opted-in facet value assigned)
     */
    async ensureVariantsForProduct(
        ctx: RequestContext,
        productId: ID,
        maxVariants: number,
    ): Promise<number> {
        const product = await this.productService.findOne(ctx, productId, [
            'facetValues',
            'facetValues.facet',
        ]);
        if (!product || this.groupOptedInFacetValues(product.facetValues ?? []).size === 0) {
            return 0;
        }

        const groups = await this.productOptionGroupService.getOptionGroupsByProductId(ctx, productId);
        const groupOptions = groups
            .map(group => (group.options ?? []).filter(option => option.deletedAt == null))
            .filter(options => options.length > 0);
        if (groupOptions.length === 0) {
            return 0;
        }

        const comboCount = groupOptions.reduce((count, options) => count * options.length, 1);
        if (comboCount > maxVariants) {
            Logger.warn(
                `Product ${String(productId)}: skipping variant auto-creation - ${comboCount} option ` +
                    `combinations exceed the maxAutoVariants limit of ${maxVariants}`,
                loggerCtx,
            );
            return 0;
        }

        // getVariantsByProductId excludes soft-deleted variants and hydrates prices.
        const { items: variants } = await this.productVariantService.getVariantsByProductId(
            ctx,
            productId,
            { take: maxVariants + 100 },
        );
        if (variants.some(variant => (variant.options ?? []).length > 0)) {
            // The product already has a real variant matrix - never touch it.
            return 0;
        }

        const placeholder = variants[0];
        const facetValueIdByCode = new Map<string, ID>(
            (product.facetValues ?? []).map(fv => [normalizeString(fv.code, '-'), fv.id]),
        );

        const inputs: CreateProductVariantInput[] = this.cartesian(groupOptions).map(combo => ({
            productId,
            // Disabled until the admin reviews price/stock in the variant list.
            enabled: false,
            sku: [product.slug, ...combo.map(option => option.code)].join('-'),
            price: placeholder?.price,
            taxCategoryId: placeholder?.taxCategoryId,
            trackInventory: placeholder?.trackInventory,
            optionIds: combo.map(option => option.id),
            facetValueIds: combo
                .map(option => facetValueIdByCode.get(normalizeString(option.code, '-')))
                .filter((id): id is ID => id != null),
            translations: [
                {
                    languageCode: ctx.languageCode,
                    name: [product.name, ...combo.map(option => option.name)].join(' '),
                },
            ],
        }));

        const created = await this.productVariantService.create(ctx, inputs);

        // The option-less placeholder is now redundant and would be sellable
        // without options - disable it (reversible; admin can delete it in the UI).
        const placeholdersToDisable = variants.filter(variant => variant.enabled);
        if (placeholdersToDisable.length > 0) {
            await this.productVariantService.update(
                ctx,
                placeholdersToDisable.map(variant => ({ id: variant.id, enabled: false })),
            );
        }

        Logger.info(
            `Product ${String(productId)}: auto-created ${created.length} disabled variant(s) from ` +
                `option combinations` +
                (placeholdersToDisable.length > 0
                    ? `; disabled ${placeholdersToDisable.length} option-less placeholder variant(s)`
                    : ''),
            loggerCtx,
        );
        return created.length;
    }

    private cartesian<T>(lists: T[][]): T[][] {
        return lists.reduce<T[][]>(
            (combos, list) => combos.flatMap(combo => list.map(item => [...combo, item])),
            [[]],
        );
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
