export interface FacetOptionSyncPluginOptions {
    /**
     * When `true` (the default), saving a product whose facet values changed
     * (or creating its variants, which covers the product-creation flow)
     * automatically creates matching product option groups/options for any
     * facet marked "Use for variant options".
     *
     * Set to `false` to disable the automatic sync while keeping the facet
     * custom field and the `syncProductOptionsFromFacets` mutation available.
     */
    autoSync: boolean;
    /**
     * When `true`, after options are synced for a product which has no
     * option-bearing variants yet (i.e. a freshly created product carrying only
     * the Admin UI's default option-less placeholder variant), one variant is
     * created per combination of the product's options.
     *
     * Safety properties:
     * - auto-created variants are DISABLED (invisible to the storefront) until
     *   the admin reviews prices in the variant list and enables them
     * - price, tax category and inventory tracking are copied from the
     *   placeholder variant; SKUs are deterministic (`<slug>-<option-codes>`)
     * - products which already have variants with options are never touched,
     *   and the option-less placeholder is disabled (not deleted)
     *
     * Applies to the automatic (event-driven) sync only - the
     * `syncProductOptionsFromFacets` mutation and the backfill script create
     * options, never variants.
     *
     * Default: `false`.
     */
    autoCreateVariants: boolean;
    /**
     * Safety cap: if a product's option combinations exceed this number, variant
     * auto-creation is skipped (with a warning logged). Default: `100`.
     */
    maxAutoVariants: number;
}

declare module '@vendure/core/dist/entity/custom-entity-fields' {
    interface CustomFacetFields {
        usedForVariantOptions: boolean;
    }
}
