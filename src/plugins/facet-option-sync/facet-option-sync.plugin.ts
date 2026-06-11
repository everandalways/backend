import { OnApplicationBootstrap } from '@nestjs/common';
import { CreateProductInput, UpdateProductInput } from '@vendure/common/lib/generated-types';
import { Type } from '@vendure/common/lib/shared-types';
import {
    EventBus,
    LanguageCode,
    Logger,
    PluginCommonModule,
    ProcessContext,
    ProductEvent,
    TransactionalConnection,
    VendurePlugin,
} from '@vendure/core';
import { filter } from 'rxjs/operators';
import { adminApiExtensions } from './api-extensions';
import { FACET_OPTION_SYNC_PLUGIN_OPTIONS, loggerCtx, USED_FOR_VARIANT_OPTIONS_FIELD } from './constants';
import { FacetOptionSyncAdminResolver } from './facet-option-sync.resolver';
import { FacetOptionSyncService } from './facet-option-sync.service';
import { FacetOptionSyncPluginOptions } from './types';

/**
 * Bridges the gap between facets and product options in the Admin UI workflow.
 *
 * Adds a "Use for variant options" checkbox (custom field) to facets. When a product's
 * facet values are saved, this plugin ensures a matching product option group exists per
 * opted-in facet, with an option per selected facet value — so the stock "manage variants"
 * wizard can generate variants without re-typing the values.
 *
 * Behavior is strictly additive (never renames/deletes) and idempotent. The sync also
 * runs on demand via the `syncProductOptionsFromFacets` Admin API mutation, and in bulk
 * via `npm run sync:options` (see src/scripts/sync-options-from-facets.ts).
 */
@VendurePlugin({
    imports: [PluginCommonModule],
    providers: [
        FacetOptionSyncService,
        {
            provide: FACET_OPTION_SYNC_PLUGIN_OPTIONS,
            useFactory: () => FacetOptionSyncPlugin.options,
        },
    ],
    adminApiExtensions: {
        schema: adminApiExtensions,
        resolvers: [FacetOptionSyncAdminResolver],
    },
    configuration: config => {
        config.customFields.Facet = [
            ...(config.customFields.Facet ?? []),
            {
                name: USED_FOR_VARIANT_OPTIONS_FIELD,
                type: 'boolean',
                defaultValue: false,
                nullable: false,
                public: false,
                label: [{ languageCode: LanguageCode.en, value: 'Use for variant options' }],
                description: [
                    {
                        languageCode: LanguageCode.en,
                        value:
                            'When enabled, selecting values of this facet on a product automatically ' +
                            'creates matching product option groups/options for variant generation. ' +
                            'Additive only: options are never renamed or deleted automatically.',
                    },
                ],
            },
        ];
        return config;
    },
    compatibility: '^3.0.0',
})
export class FacetOptionSyncPlugin implements OnApplicationBootstrap {
    static options: FacetOptionSyncPluginOptions = { autoSync: true };

    static init(options?: Partial<FacetOptionSyncPluginOptions>): Type<FacetOptionSyncPlugin> {
        this.options = { ...this.options, ...options };
        return FacetOptionSyncPlugin;
    }

    /** Serializes concurrent sync runs per product (in-process). */
    private readonly pending = new Map<string, Promise<unknown>>();

    constructor(
        private eventBus: EventBus,
        private processContext: ProcessContext,
        private connection: TransactionalConnection,
        private facetOptionSyncService: FacetOptionSyncService,
    ) {}

    onApplicationBootstrap() {
        if (!this.processContext.isServer || !FacetOptionSyncPlugin.options.autoSync) {
            return;
        }
        // ofType() subscribers are invoked only after the publishing transaction has
        // committed, so this can never fail or slow down the admin's product save.
        this.eventBus
            .ofType(ProductEvent)
            .pipe(
                filter(event => event.type === 'created' || event.type === 'updated'),
                filter(event => this.inputHasFacetValueIds(event.input)),
            )
            .subscribe(event => this.enqueueSync(event));
    }

    private inputHasFacetValueIds(input: ProductEvent['input']): boolean {
        return (
            typeof input === 'object' &&
            input !== null &&
            (input as CreateProductInput | UpdateProductInput).facetValueIds != null
        );
    }

    private enqueueSync(event: ProductEvent): void {
        const key = String(event.entity.id);
        const run = () =>
            this.connection
                .withTransaction(event.ctx, ctx =>
                    this.facetOptionSyncService.ensureOptionsForProduct(ctx, event.entity.id),
                )
                .catch((err: unknown) => {
                    // Never throw from an event subscriber. The sync is idempotent, so a
                    // failed run self-heals on the next product save, via the
                    // syncProductOptionsFromFacets mutation, or via the backfill script.
                    const message = err instanceof Error ? err.message : String(err);
                    const stack = err instanceof Error ? err.stack : undefined;
                    Logger.error(
                        `Failed to sync product options from facets for product ${key}: ${message}`,
                        loggerCtx,
                        stack,
                    );
                });
        const next = (this.pending.get(key) ?? Promise.resolve()).then(run);
        this.pending.set(key, next);
        void next.finally(() => {
            if (this.pending.get(key) === next) {
                this.pending.delete(key);
            }
        });
    }
}
