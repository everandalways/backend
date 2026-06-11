/**
 * Bulk product import (create-only) for the Ever & Always catalog.
 *
 * Usage:
 *   npm run import:validate -- <path-to-csv>    Validate only — touches nothing.
 *   npm run import:run -- <path-to-csv>         Validate, then import.
 *
 * The CSV must follow Vendure's native product import format (see
 * BULK_IMPORT_GUIDE.md). IMPORTANT: prices are in DOLLARS (e.g. 1499.00),
 * not cents — Vendure multiplies by 100 internally.
 *
 * The script connects to whatever database the .env file points to.
 * Run `import:validate` first; it reports exactly what would be created
 * and refuses to continue if any SKU or slug already exists (create-only).
 */
import { AdminUiPlugin } from '@vendure/admin-ui-plugin';
import {
    bootstrap,
    DefaultJobQueuePlugin,
    DefaultSchedulerPlugin,
    ImportParser,
    LanguageCode,
    Product,
    ProductVariant,
    TaxCategory,
    TransactionalConnection,
} from '@vendure/core';
import { importProductsFromCsv } from '@vendure/core/cli';
import { EmailPlugin } from '@vendure/email-plugin';
import fs from 'fs';
import http from 'http';
import https from 'https';
import path from 'path';
import { In, IsNull } from 'typeorm';
import { config } from '../vendure-config';

const HELP = `
Usage:
  npm run import:validate -- <path-to-csv>
  npm run import:run -- <path-to-csv>

The path is relative to the backend/ directory (or absolute).
`;

interface ValidationReport {
    errors: string[];
    warnings: string[];
    productCount: number;
    variantCount: number;
    slugs: string[];
    skus: string[];
}

function parseArgs(): { csvPath: string; dryRun: boolean } {
    const args = process.argv.slice(2);
    const dryRun = args.includes('--dry-run');
    const positional = args.filter(a => !a.startsWith('--'));
    if (positional.length !== 1) {
        console.error(HELP);
        process.exit(1);
    }
    const csvPath = path.resolve(process.cwd(), positional[0]);
    if (!fs.existsSync(csvPath)) {
        console.error(`File not found: ${csvPath}`);
        process.exit(1);
    }
    return { csvPath, dryRun };
}

/**
 * Check a URL is reachable; resolves ok=true if status < 400. Never throws.
 * Tries HEAD first (cheap); some hosts reject HEAD with 405/501, so it falls
 * back to GET and aborts as soon as response headers arrive (no full download).
 */
function checkUrlReachable(urlString: string, method: 'HEAD' | 'GET' = 'HEAD'): Promise<{ ok: boolean; detail: string }> {
    return new Promise(resolve => {
        let settled = false;
        const done = (ok: boolean, detail: string) => {
            if (!settled) {
                settled = true;
                resolve({ ok, detail });
            }
        };
        try {
            const url = new URL(urlString);
            const request = url.protocol === 'https:' ? https.request : http.request;
            const req = request(url, { method, timeout: 8000 }, res => {
                const status = res.statusCode ?? 0;
                if (method === 'HEAD' && (status === 405 || status === 501)) {
                    // Host doesn't allow HEAD — retry once with GET
                    res.resume();
                    settled = true;
                    resolve(checkUrlReachable(urlString, 'GET'));
                    return;
                }
                done(status < 400, `status ${status}`);
                res.destroy(); // headers are enough — don't download the body
            });
            req.on('timeout', () => {
                req.destroy();
                done(false, 'timed out after 8s');
            });
            req.on('error', err => done(false, err.message));
            req.end();
        } catch (e) {
            done(false, e instanceof Error ? e.message : 'invalid URL');
        }
    });
}

async function validate(
    app: Awaited<ReturnType<typeof bootstrap>>,
    csvContent: string,
): Promise<ValidationReport> {
    const report: ValidationReport = {
        errors: [],
        warnings: [],
        productCount: 0,
        variantCount: 0,
        slugs: [],
        skus: [],
    };

    // Phase 1 — parse with Vendure's own parser (identical code path to the real import)
    const parser = app.get(ImportParser);
    const parsed = await parser.parseProducts(csvContent, LanguageCode.en);
    if (parsed.errors.length > 0) {
        report.errors.push(...parsed.errors.map(e => `CSV parse error: ${e}`));
        return report; // structural errors — no point checking further
    }

    report.productCount = parsed.results.length;
    report.variantCount = parsed.results.reduce((sum, r) => sum + r.variants.length, 0);

    // Phase 2 — intra-file duplicate detection + price sanity
    const seenSlugs = new Map<string, number>();
    const seenSkus = new Map<string, number>();
    for (const row of parsed.results) {
        const en = row.product.translations.find(t => t.languageCode === LanguageCode.en)
            ?? row.product.translations[0];
        if (!en?.slug) {
            report.errors.push(`Product "${en?.name ?? '(unnamed)'}" has an empty slug`);
            continue;
        }
        seenSlugs.set(en.slug, (seenSlugs.get(en.slug) ?? 0) + 1);
        for (const variant of row.variants) {
            if (!variant.sku) {
                report.errors.push(`Product "${en.name}" has a variant with an empty SKU`);
                continue;
            }
            seenSkus.set(variant.sku, (seenSkus.get(variant.sku) ?? 0) + 1);

            if (variant.price <= 0 || Number.isNaN(variant.price)) {
                report.errors.push(`SKU ${variant.sku}: price must be a positive number (got ${variant.price})`);
            } else if (variant.price >= 25000) {
                report.warnings.push(
                    `SKU ${variant.sku}: price is $${variant.price.toLocaleString()} — prices are in DOLLARS, ` +
                    `not cents. If you meant $${(variant.price / 100).toFixed(2)}, fix the CSV.`,
                );
            }
        }
    }
    for (const [slug, count] of seenSlugs) {
        if (count > 1) report.errors.push(`Slug "${slug}" appears ${count} times in the CSV`);
    }
    for (const [sku, count] of seenSkus) {
        if (count > 1) report.errors.push(`SKU "${sku}" appears ${count} times in the CSV`);
    }
    report.slugs = [...seenSlugs.keys()];
    report.skus = [...seenSkus.keys()];

    // Phase 3 — DB collision checks (create-only: any existing slug/SKU is a hard error)
    const conn = app.get(TransactionalConnection).rawConnection;

    if (report.skus.length > 0) {
        const existingVariants = await conn.getRepository(ProductVariant).find({
            where: { sku: In(report.skus), deletedAt: IsNull() },
            select: ['sku'],
        });
        for (const v of existingVariants) {
            report.errors.push(`SKU "${v.sku}" already exists in the database (create-only import)`);
        }
    }

    if (report.slugs.length > 0) {
        const rows: Array<{ slug: string }> = await conn
            .getRepository(Product)
            .createQueryBuilder('product')
            .innerJoin('product.translations', 'translation')
            .where('translation.slug IN (:...slugs)', { slugs: report.slugs })
            .andWhere('product.deletedAt IS NULL')
            .select('translation.slug', 'slug')
            .getRawMany();
        for (const row of rows) {
            report.errors.push(`Slug "${row.slug}" already exists in the database (create-only import)`);
        }
    }

    // Phase 4 — tax category sanity. The importer silently falls back to the FIRST
    // tax category when the name doesn't match, so a typo would mis-categorize
    // every variant without any error.
    const taxCategoryNames = new Set<string>();
    for (const row of parsed.results) {
        for (const variant of row.variants) {
            if (variant.taxCategory) taxCategoryNames.add(variant.taxCategory);
        }
    }
    if (taxCategoryNames.size > 0) {
        const existing = await conn.getRepository(TaxCategory).find({ select: ['name'] });
        const existingNames = existing.map(t => t.name);
        for (const name of taxCategoryNames) {
            const matches = existingNames.some(n => n.match(new RegExp(name, 'i')));
            if (!matches) {
                report.warnings.push(
                    `Tax category "${name}" does not match any existing tax category ` +
                    `(${existingNames.join(', ') || 'none found'}). Vendure will silently use ` +
                    `"${existingNames[0] ?? '?'}" instead.`,
                );
            }
        }
    }

    // Phase 5 — asset URL reachability (warnings only; the importer retries 3x itself)
    const urls = new Set<string>();
    const collectAssetPath = (p: string, label: string) => {
        if (/^https?:\/\//.test(p)) {
            urls.add(p);
        } else if (p) {
            report.warnings.push(
                `${label} "${p}" is a local path — it resolves relative to importAssetsDir, not the CSV location`,
            );
        }
    };
    for (const row of parsed.results) {
        for (const p of row.product.assetPaths) collectAssetPath(p, 'Asset');
        for (const variant of row.variants) {
            for (const p of variant.assetPaths) collectAssetPath(p, 'Variant asset');
        }
    }
    for (const url of urls) {
        const { ok, detail } = await checkUrlReachable(url);
        if (!ok) {
            report.warnings.push(`Asset URL may be unreachable (${detail}): ${url}`);
        }
    }

    return report;
}

function printReport(report: ValidationReport, dryRun: boolean): void {
    console.log('\n========== VALIDATION REPORT ==========');
    console.log(`Products to create:  ${report.productCount}`);
    console.log(`Variants to create:  ${report.variantCount}`);

    if (report.warnings.length > 0) {
        console.log(`\nWarnings (${report.warnings.length}):`);
        for (const w of report.warnings) console.log(`  - ${w}`);
    }
    if (report.errors.length > 0) {
        console.log(`\nErrors (${report.errors.length}):`);
        for (const e of report.errors) console.log(`  - ${e}`);
        console.log('\nFix the errors above and re-run validation. Nothing was imported.');
    } else if (dryRun) {
        console.log('\nValidation passed. Run `npm run import:run -- <file>` to import for real.');
    } else {
        console.log('\nValidation passed. Proceeding with import...');
    }
    console.log('=======================================\n');
}

async function main() {
    const { csvPath, dryRun } = parseArgs();
    // Strip the UTF-8 BOM that Excel prepends — it corrupts the first header column name
    const csvContent = fs.readFileSync(csvPath, 'utf-8').replace(/^FEFF/, '');

    console.log(`Bootstrapping Vendure (DB: ${process.env.DB_HOST}/${process.env.DB_NAME})...`);
    const importConfig = {
        ...config,
        apiOptions: {
            ...config.apiOptions,
            port: 0,
        },
        // Job queue, scheduler, admin UI and email are not needed for imports.
        // AssetServerPlugin MUST stay — it configures the R2 storage strategy.
        plugins: (config.plugins || []).filter(
            plugin =>
                plugin !== DefaultJobQueuePlugin &&
                plugin !== DefaultSchedulerPlugin &&
                plugin !== AdminUiPlugin &&
                plugin !== EmailPlugin,
        ),
    };
    const app = await bootstrap(importConfig);

    try {
        const report = await validate(app, csvContent);
        printReport(report, dryRun);

        if (report.errors.length > 0) {
            await app.close();
            process.exit(1);
        }
        if (dryRun) {
            await app.close();
            process.exit(0);
        }

        const result = await importProductsFromCsv(app, csvPath, LanguageCode.en);
        console.log(`\nImported ${result.imported} of ${result.processed} products.`);
        if (result.errors && result.errors.length > 0) {
            console.log('\nImport completed with errors:');
            for (const e of result.errors) console.log(`  - ${e}`);
        }
        console.log(
            '\nNEXT STEP: the search index does not know about the new products yet.\n' +
            'Log into the Admin UI -> Products -> click "Rebuild search index".\n' +
            'New products will not appear in storefront search until then.\n',
        );
        await app.close();
        process.exit(result.errors && result.errors.length > 0 ? 1 : 0);
    } catch (err) {
        console.error('\nImport failed:', err instanceof Error ? err.message : err);
        await app.close();
        process.exit(1);
    }
}

main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
});
