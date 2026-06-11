export interface FacetOptionSyncPluginOptions {
    /**
     * When `true` (the default), saving a product whose facet values changed
     * automatically creates matching product option groups/options for any
     * facet marked "Use for variant options".
     *
     * Set to `false` to disable the automatic sync while keeping the facet
     * custom field and the `syncProductOptionsFromFacets` mutation available.
     */
    autoSync: boolean;
}

declare module '@vendure/core/dist/entity/custom-entity-fields' {
    interface CustomFacetFields {
        usedForVariantOptions: boolean;
    }
}
