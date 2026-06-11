# Bulk Product Import — Complete Guide

Add products to the store in bulk from a CSV (spreadsheet) file. Built on
Vendure's own import machinery, wrapped with a validation layer that catches
mistakes **before** anything touches the database.

**Create-only:** existing products are never modified. If any SKU or slug in
the CSV already exists, validation fails and nothing is imported. To edit
existing products, use the Admin UI.

---

## One-time setup (already done, kept for reference)

```powershell
npm i -g @railway/cli
railway login          # opens browser
cd backend
railway link           # pick: project → production → backend service
railway service        # if "railway status" shows Service: None, run this and pick backend
```

---

## The workflow (every import)

```powershell
cd C:\Users\qalam\OneDrive\Desktop\EVER-AND-ALWAYS\backend

# 1. Check the file — read-only, changes nothing:
railway run npm run import:validate -- data/YOUR-FILE.csv

# 2. If validation passed, import for real:
railway run npm run import:run -- data/YOUR-FILE.csv
```

3. **Admin UI → Products → "Rebuild search index"** — new products are
   invisible in storefront search until you click this.
4. Spot-check one product in Admin: price right? images loaded? variants OK?

Notes:
- `railway run` executes on your PC but injects the production env vars, so
  the script connects to the live DB and stores images in R2.
- First boot takes ~30-60 seconds (it starts a small headless Vendure).
- Errors **block** the import. Warnings don't — read them and decide.

---

## CSV format

Start from a sample file (see bottom). The header must contain ALL 14 columns:

| Column | Example | Notes |
|---|---|---|
| `name` | `Cushion Cut Halo Engagement Ring` | Only on the FIRST row of each product |
| `slug` | `cushion-cut-halo-engagement-ring` | Lowercase + hyphens, unique store-wide |
| `description` | `"A stunning cushion cut..."` | Wrap in `"..."` if it contains commas |
| `assets` | `https://site.com/img.jpg` | Public image URL(s), `\|`-separated. See **Images** below |
| `facets` | `category:Rings\|type:Engagement Ring\|shape:Cushion\|style:Halo` | `facet:value` pairs, `\|`-separated |
| `optionGroups` | `Metal\|Ring Size` | Group names, `\|`-separated. Empty = single-variant product |
| `optionValues` | `White Gold\|6` | One value per group, SAME ORDER as optionGroups |
| `sku` | `ENG-HALO-WG-6` | Unique per variant, every variant row needs one |
| `price` | `2499.00` | ⚠️ **DOLLARS, NOT CENTS.** `2499.00` = $2,499. Writing `249900` imports as $249,900! |
| `taxCategory` | `standard` | Must match an existing tax category |
| `stockOnHand` | `5` | Units in stock for this variant |
| `trackInventory` | `true` | `true`/`false`, empty = inherit global setting |
| `variantAssets` | (usually empty) | Variant-specific image URLs |
| `variantFacets` | `metal:White Gold` | Facets on the variant — powers storefront filtering |

Save from Excel as **"CSV UTF-8"**.

### Existing facet vocabulary (reuse these — typos create junk facets)

- `category:` Rings, Earrings, Necklaces, Bracelets
- `type:` Engagement Ring, Wedding Band, Stud Earrings, Tennis Necklace, Tennis Bracelet, Pendant
- `shape:` Round, Oval, Princess, Cushion, Pear, Emerald, Radiant
- `style:` Solitaire, Halo, Pave
- `diamond-type:` Lab Grown
- `gender:` Men, Women
- variant: `metal:` White Gold, Yellow Gold, Rose Gold, Platinum

---

## Variants & options — the part people get wrong

**Core rules:**

1. The **first row** of a product carries the product info (name, slug,
   description, assets, facets, optionGroups) **plus the first variant**.
2. Every **additional variant is its own row** with the product columns
   left EMPTY — only variant columns filled (optionValues, sku, price, ...).
3. `optionValues` order matches `optionGroups` order:
   groups `Metal|Ring Size` → values `White Gold|6`.
4. **Vendure does NOT auto-generate combinations.** 3 metals × 2 sizes =
   you write all 6 rows yourself.
5. Each variant has its own SKU, price, and stock — so a Platinum variant
   can cost more than the White Gold one.

### Pattern 1 — one option group, same price (e.g. ring sizes)

```csv
Comfort Fit Wedding Band,comfort-fit-wedding-band,"Desc...",https://img.url,category:Rings|type:Wedding Band,Ring Size,8,WB-8,649.00,standard,6,true,,metal:Yellow Gold
,,,,,,9,WB-9,649.00,standard,6,true,,metal:Yellow Gold
,,,,,,10,WB-10,649.00,standard,4,true,,metal:Yellow Gold
```

### Pattern 2 — two option groups, price varies by variant

```csv
Halo Engagement Ring,halo-engagement-ring,"Desc...",https://img.url,category:Rings|type:Engagement Ring|style:Halo,Metal|Ring Size,White Gold|6,HALO-WG-6,2499.00,standard,3,true,,metal:White Gold
,,,,,,White Gold|7,HALO-WG-7,2499.00,standard,3,true,,metal:White Gold
,,,,,,Platinum|6,HALO-PT-6,2999.00,standard,2,true,,metal:Platinum
,,,,,,Platinum|7,HALO-PT-7,2999.00,standard,1,true,,metal:Platinum
```

### Pattern 3 — option group as a price ladder (e.g. carat weight)

```csv
Tennis Bracelet,tennis-bracelet,"Desc...",https://img.url,category:Bracelets|type:Tennis Bracelet,Carat Total Weight,2.00 ct,TB-200,1999.00,standard,5,true,,metal:White Gold
,,,,,,3.00 ct,TB-300,2999.00,standard,4,true,,metal:White Gold
,,,,,,5.00 ct,TB-500,4999.00,standard,2,true,,metal:White Gold
```

### Single-variant product (no options at all)

One row, `optionGroups` and `optionValues` empty:

```csv
Solitaire Pendant,solitaire-pendant,"Desc...",https://img.url,category:Necklaces|type:Pendant,,,PEND-1,749.00,standard,10,true,,
```

---

## Images — you do NOT upload to R2 manually

Put any **public image URL** in the `assets` column. During import, Vendure
**downloads the image and stores its own copy in R2** automatically. After
import, the original URL no longer matters — the store serves from R2 forever.

✅ **Works:** supplier/manufacturer image URLs (right-click → "Copy image
address"), images on your existing website, any URL that shows the raw image
when opened in an incognito browser.

❌ **Doesn't work:** Google Drive / Dropbox / WhatsApp "share" links — those
are webpages wrapped around the image, not the image itself. Validation will
warn about them.

**Photos only on your PC?**
- Few products → leave `assets` empty, import, then drag-drop photos onto
  each product in Admin UI (those uploads also land in R2 automatically).
- Multiple images per product → separate URLs with `|` in the assets column;
  the first one becomes the featured image.

---

## What validation checks (`import:validate`)

1. CSV structure — parsed by Vendure's own parser, errors include row numbers
2. Duplicate slugs/SKUs **within the file**
3. Collisions **with the database** — existing SKU/slug = hard error
4. Prices — zero/negative = error; ≥ $25,000 = "did you mean cents?" warning
5. Tax category — warns on no match (Vendure would silently use the first one)
6. Image URLs — checks each is reachable (HEAD, falls back to GET)

## Common mistakes

| Mistake | Result | Caught? |
|---|---|---|
| Price in cents (`249900`) | Imports as $249,900 | ⚠️ warning ≥ $25k |
| Reused SKU/slug | — | ✅ blocked |
| Wrong optionValues order vs optionGroups | Swapped option labels | ❌ review in Admin |
| Facet typo (`categry:Rings`) | Junk facet auto-created | ❌ check Admin → Facets |
| Forgot "Rebuild search index" | Products invisible in search | reminder printed |
| Google Drive share link as image | Import error on that asset | ⚠️ warned |

## Undo / recovery

No built-in undo. Options:
- **Few wrong products:** Admin UI → Products → select → Delete (variants go with the product).
- **Many wrong:** delete the imported products, fix the CSV, re-import
  (must delete first — SKU collisions block re-import).
- **Junk facets from typos:** Admin UI → Catalog → Facets → delete bogus values.

Tip: prefix test SKUs (`SAMPLE-...`) so test imports are easy to find and delete.

---

## Sample files

| File | Shows |
|---|---|
| `data/sample-bulk-upload.csv` | Basic: multi-variant ring, single-variant pendant, carat-tier earrings |
| `data/sample-variants-options.csv` | All three variant patterns above, per-variant pricing |

Both use `SAMPLE-`/`SAMPLE2-` SKU prefixes — safe to import as a test and delete afterwards.

---

## Technical notes

- Script: `src/scripts/bulk-import.ts` (compiled to `dist/scripts/bulk-import.js`)
- npm scripts: `import:validate` (dry-run) / `import:run` — both take the CSV path after `--`
- Uses `ImportParser` + `importProductsFromCsv` from `@vendure/core` — the same
  code path as Vendure's `populate()`; images via `DefaultAssetImportStrategy`
  (downloads URLs, 3 retries, stores via the configured R2 strategy)
- Bootstraps headless (port 0) with JobQueue/Scheduler/AdminUI/Email plugins
  filtered out; AssetServerPlugin stays (it configures R2 storage)
- The old `npm run import` script (`import-products.ts`) is superseded and
  buggy (passes the CSV as the wrong `populate()` argument) — don't use it
- New facets/option groups in the CSV are auto-created on import
