import { SortOrder } from '@vendure/common/lib/generated-types';
import {
    bootstrapWorker,
    Logger,
    ProductService,
    RequestContextService,
    TransactionalConnection,
} from '@vendure/core';
import { FacetOptionSyncService } from '../plugins/facet-option-sync/facet-option-sync.service';
import { config } from '../vendure-config';

/**
 * Backfill: runs the facet -> product option sync over ALL existing products.
 *
 * Use this once after enabling "Use for variant options" on facets, so that
 * products which already carry those facet values get their option groups
 * created without having to re-save each product in the Admin UI.
 *
 * Additive and idempotent - safe to run multiple times.
 *
 * Usage: npm run sync:options
 */
const BATCH_SIZE = 50;

bootstrapWorker(config)
    .then(async worker => {
        const app = worker.app;
        const ctx = await app.get(RequestContextService).create({ apiType: 'admin' });
        const productService = app.get(ProductService);
        const connection = app.get(TransactionalConnection);
        const syncService = app.get(FacetOptionSyncService);

        let skip = 0;
        let processed = 0;
        let totalCreatedGroups = 0;
        let totalCreatedOptions = 0;

        for (;;) {
            const { items, totalItems } = await productService.findAll(ctx, {
                skip,
                take: BATCH_SIZE,
                sort: { id: SortOrder.ASC },
            });
            for (const product of items) {
                const { createdGroups, createdOptions } = await connection.withTransaction(ctx, txCtx =>
                    syncService.ensureOptionsForProduct(txCtx, product.id),
                );
                processed++;
                totalCreatedGroups += createdGroups;
                totalCreatedOptions += createdOptions;
                if (createdGroups > 0 || createdOptions > 0) {
                    Logger.info(
                        `[backfill] "${product.name}" (id ${String(product.id)}): ` +
                            `+${createdGroups} option group(s), +${createdOptions} option(s)`,
                    );
                }
            }
            skip += BATCH_SIZE;
            if (items.length === 0 || skip >= totalItems) {
                break;
            }
        }

        Logger.info(
            `[backfill] Done. Processed ${processed} product(s): ` +
                `created ${totalCreatedGroups} option group(s) and ${totalCreatedOptions} option(s).`,
        );
        await app.close();
        process.exit(0);
    })
    .catch(err => {
        console.error(err);
        process.exit(1);
    });
