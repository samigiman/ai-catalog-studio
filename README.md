# AI Catalog Studio

AI Catalog Studio is an open-source workspace for turning ecommerce product feeds and product images into reviewed Meta Commerce catalog CSV exports.

It is designed for small ecommerce teams, agencies, and catalog maintainers who need to match uploaded product photos to a merchant feed, prepare catalog fields, validate media URLs, and export a Meta-ready CSV without maintaining fragile spreadsheets.

## What It Does

- Loads a Google Merchant / RSS XML product feed.
- Searches feed products by title and description.
- Converts selected feed items into editable Meta Commerce catalog rows.
- Supports batch image upload for AI-assisted product matching.
- Extracts product attributes from images, including brand, model, color, storage, visible text, and category clues.
- Ranks feed candidates and can ask an AI model to choose the best matching `content_id`.
- Drafts product titles and descriptions for catalog review.
- Tracks items that need manual review when no confident feed match is found.
- Validates media links before export.
- Exports Meta Commerce CSV columns:
  `id,title,description,availability,condition,price,link,image_link,additional_image_link,brand,sale_price,fb_product_category,video_url`

## Use Cases

- Building or refreshing Meta Commerce catalogs from an existing product feed.
- Matching product photos from a shoot to feed SKUs.
- Preparing clean CSV uploads for Facebook and Instagram shops.
- Reviewing missing media, broken URLs, and weak product metadata before catalog import.
- Creating an operator-friendly workflow for merchants that do not want to edit catalog spreadsheets manually.

## Feed Support

The parser currently supports Google Merchant-style RSS/XML feeds with `g:` namespaced fields such as:

- `g:id`
- `g:title`
- `g:description`
- `g:link`
- `g:price`
- `g:image_link`
- `g:brand`
- `g:availability`
- `g:condition`
- `g:fb_product_category`

The default development build loads `public/sample-products.xml`. For another store, set `VITE_PRODUCT_FEED_URL` to a public XML feed URL in `.env.local`.

```bash
VITE_PRODUCT_FEED_URL=https://example.com/products.xml
```

If the feed server blocks browser requests with CORS, configure a Vite proxy for that merchant feed and point `VITE_PRODUCT_FEED_URL` to the local proxy path.

## Getting Started

```bash
git clone https://github.com/samigiman/ai-catalog-studio.git
cd ai-catalog-studio
npm install
npm run dev
```

Open the local URL shown by Vite, usually:

```text
http://127.0.0.1:3007
```

## Basic Workflow

1. Load the product feed.
2. Search for products and add matching items to the catalog table.
3. Review and edit catalog fields:
   - media URLs
   - title
   - description
   - website link
   - price
   - sale price
   - Facebook product category
   - condition
   - availability
   - status
   - brand
   - content ID
4. Upload product images for batch AI matching when needed.
5. Review AI-picked candidates and manually resolve uncertain matches.
6. Export the Meta Commerce CSV.

Every exported row should have at least one public `http` or `https` image URL for `image_link`.

## AI Setup

AI analysis runs through the local Vite development proxy so API keys are not exposed directly in frontend code.

Create `.env.local` from `.env.example` and add the providers you want to use.

### Gemini

```bash
GEMINI_API_KEY=...
VITE_GEMINI_MODEL=gemini-2.5-flash
VITE_GEMINI_MODELS=gemini-2.5-flash,gemini-2.5-pro,gemini-2.5-flash-lite,gemini-2.0-flash,gemini-3.1-pro-preview
```

### OpenAI

```bash
OPENAI_API_KEY=sk-...
VITE_OPENAI_FALLBACK_ENABLED=true
VITE_OPENAI_VISION_MODEL=gpt-5.4
VITE_OPENAI_VISION_MODELS=gpt-5.4,gpt-5.2,gpt-5.1,gpt-5-mini,gpt-4.1
```

When OpenAI fallback is enabled, the app can use OpenAI vision models if Gemini does not return a usable structured result.

## Optional Google Drive Media Flow

If you want uploaded images to become public media URLs during export, configure:

```bash
VITE_GOOGLE_DRIVE_CLIENT_ID=...
```

Without Google Drive configuration, the app expects catalog media to be entered as public URLs or supplied by the feed fallback.

## Development Notes

- The app is built with React, TypeScript, and Vite.
- Optional live price helpers can be enabled with `LIVE_PRICE_PROXY_TARGET` and `VITE_LIVE_PRICE_PROXY_PATH`, but the core catalog workflow is feed-driven.
- API keys belong in `.env.local`; do not commit real credentials.
- Use `.env.example` as the public configuration template.

## License

Add a license before publishing if you want others to reuse or contribute to the project.
