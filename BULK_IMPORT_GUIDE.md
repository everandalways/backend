# Bulk Product Import Guide

Create new products and variants in bulk from a CSV file. Built on Vendure's
native importer (the same machinery that seeded the original catalog), wrapped
with a validation layer that catches every common mistake **before** anything
is written to the database.

**This import is create-only.** Existing products are never modified. If any
SKU or slug in your CSV already exists in the database, validation fails and
nothing is imported. To change existing products, use the Admin UI.

---

## Quick start

```powershell
# 1. ALWAYS validate first — read-only, touches nothing:
cd backend
npm run import:validate -- data/sample-bulk-upload.csv

# 2. If validation passes, import for real:
npm run import:run -- data/my-products.csv
```

The script connects to whatever database your `backend/.env` points to.
**Check your `.env` before running** — if it points at production, you are
importing into production.

After a successful import: **log into Admin UI → Products → "Rebuild search
index"**. New products will not appear in storefront search until you do.

---

## CSV format

Use `data/sample-bulk-upload.csv` as your starting template. The header row
must contain ALL of these columns (in any order):

| Column | Required value | Notes |
|---|---|---|
| `name` | Product name | Only on the FIRST row of each product |
| `slug` | URL slug, e.g. `radiant-cut-diamond-ring` | Lowercase, hyphens, must be unique store-wide |
| `description` | Product description | Wrap in `"..."` if it contains commas |
| `assets` | Image URL(s) | `https://...` URLs are downloaded automatically and stored in R2. Separate multiple with `\|` |
| `facets` | `category:Rings\|type:Engagement Ring\|shape:Round` | Pipe-separated `facet:value` pairs. New facets/values are auto-created |
| `optionGroups` | `Metal\|Ring Size` | Pipe-separated group names. Empty for single-variant products |
| `optionValues` | `White Gold\|6` | One value per group, per variant row |
| `sku` | Unique SKU | Every variant row needs one |
| `price` | **DOLLARS** e.g. `1899.00` | ⚠️ NOT cents. `1899.00` = $1,899.00. Writing `189900` would import as $189,900! |
| `taxCategory` | `standard` | Must match an existing tax category name |
| `stockOnHand` | e.g. `5` | Units in stock |
| `trackInventory` | `true` / `false` | Empty = inherit global setting |
| `variantAssets` | Variant-specific image URLs | Usually empty |
| `variantFacets` | `metal:White Gold` | Facets on the variant (used for filtering) |

### Multi-variant products

The FIRST row carries the product info (name, slug, description, assets,
facets, optionGroups) plus the first variant. Each ADDITIONAL variant is a row
with the product columns left EMPTY and only the variant columns filled:

```csv
name,slug,description,assets,facets,optionGroups,optionValues,sku,price,...
Radiant Ring,radiant-ring,"Desc...",https://img.url,category:Rings,Metal|Ring Size,White Gold|6,SKU-WG-6,1899.00,...
,,,,,,White Gold|7,SKU-WG-7,1899.00,...
,,,,,,Rose Gold|6,SKU-RG-6,1899.00,...
```

### Single-variant products

One row, leave `optionGroups` and `optionValues` empty:

```csv
Pendant,pendant-slug,"Desc...",https://img.url,category:Necklaces,,,SKU-PEND-1,749.00,...
```

### Existing facet vocabulary (use these for consistency)

- `category:` Rings, Earrings, Necklaces
- `type:` Engagement Ring, Wedding Band, Stud Earrings, Tennis Necklace, Pendant
- `shape:` Round, Oval, Princess, Cushion, Pear, Emerald, Radiant
- `style:` Solitaire, Halo, Pave
- `diamond-type:` Lab Grown
- `gender:` Men, Women
- Variant: `metal:` White Gold, Yellow Gold, Rose Gold

Typos create NEW facet values (e.g. `categry:Rings` makes a new facet called
"categry") — they don't error. Double-check spelling.

---

## What validation checks

`npm run import:validate` runs these checks and reports everything at once:

1. **CSV structure** — parsed by Vendure's own parser; any malformed row is reported with its line number
2. **Duplicate slugs/SKUs within the file**
3. **Collisions with the database** — any SKU or slug that already exists (hard error, create-only)
4. **Price sanity** — zero/negative prices are errors; prices ≥ $25,000 get a "did you mean cents?" warning
5. **Tax category** — warns if the name doesn't match any existing category (Vendure would silently fall back to the first one)
6. **Image URLs** — HEAD-requests each unique URL and warns about unreachable ones

Errors block the import. Warnings don't — read them and decide.

---

## Common mistakes

| Mistake | What happens | Caught by validation? |
|---|---|---|
| Price in cents (`149900` for $1,499) | Imports as $149,900 | ⚠️ Warning if ≥ $25k |
| Reusing an existing SKU | — | ✅ Hard error |
| Excel saved with BOM/wrong encoding | First column unreadable | ✅ BOM stripped automatically; save as "CSV UTF-8" |
| Comma in description without quotes | Row misaligned | ✅ Parse error with row number |
| Typo in facet name | Creates junk facet | ❌ Not catchable — review facets in Admin UI after import |
| Forgot to rebuild search index | Products invisible in storefront search | Reminder printed after import |

---

## Recovery: "I imported something wrong"

There is no built-in undo. Options:

1. **A few products:** delete them in Admin UI (Products → select → Delete). Deleting the product removes its variants.
2. **Wrong prices/details on many:** fix by hand in Admin UI, or delete all imported products and re-import the corrected CSV (delete first — otherwise SKU collisions block the re-import).
3. **Junk facets created by typos:** Admin UI → Catalog → Facets → delete the bogus facet values.

Tip: prefix experimental SKUs (like the sample's `SAMPLE-`) so test imports are
easy to find and delete.

---

## Technical notes

- Script: `src/scripts/bulk-import.ts`
- Uses `ImportParser` + `importProductsFromCsv` from `@vendure/core` — the same code path as Vendure's own `populate()`
- Images: `DefaultAssetImportStrategy` downloads each URL (3 retries, 5s timeout) and stores via the configured R2 storage strategy
- The old `npm run import` script (`import-products.ts`) is superseded by this one and passes its CSV as the wrong argument to `populate()` — don't use it
- Bootstraps Vendure with JobQueue/Scheduler/AdminUI/Email plugins removed; AssetServerPlugin stays (it configures R2 storage)
