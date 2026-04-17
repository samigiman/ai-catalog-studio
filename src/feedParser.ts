import type { CatalogRow } from './types'

/** Google Merchant / RSS `g:` namespace */
const G_NS = 'http://base.google.com/ns/1.0'

export type ParsedItem = {
  contentId: string
  title: string
  description: string
  websiteLink: string
  price: string
  imageLink: string
  brand: string
  availability: string
  condition: string
  fbProductCategory: string
}

function text(el: Element | null | undefined): string {
  return el?.textContent?.trim() ?? ''
}

export function parseGoogleMerchantRss(xml: string): ParsedItem[] {
  const parser = new DOMParser()
  const doc = parser.parseFromString(xml, 'text/xml')
  const parseError = doc.querySelector('parsererror')
  if (parseError) {
    throw new Error('XML oxuna bilmədi: ' + (parseError.textContent ?? ''))
  }

  const items = doc.getElementsByTagName('item')
  const out: ParsedItem[] = []
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    const q = (name: string) => item.getElementsByTagNameNS(G_NS, name)[0]
    out.push({
      contentId: text(q('id')),
      title: text(q('title')),
      description: text(q('description')),
      websiteLink: text(q('link')),
      price: text(q('price')),
      imageLink: text(q('image_link')),
      brand: text(q('brand')),
      availability: text(q('availability')),
      condition: text(q('condition')),
      fbProductCategory: text(q('fb_product_category')),
    })
  }
  return out
}

export function filterByName(items: ParsedItem[], query: string): ParsedItem[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  return items.filter(
    (it) =>
      it.title.toLowerCase().includes(q) ||
      it.description.toLowerCase().includes(q),
  )
}

export function parsedItemToRow(it: ParsedItem): CatalogRow {
  return {
    // User requested manual media entry; do not prefill product image from feed.
    imagesAndVideos: '',
    title: it.title,
    description: it.description,
    websiteLink: it.websiteLink,
    price: it.price,
    salePrice: '',
    fbProductCategory: it.fbProductCategory,
    condition: it.condition || 'new',
    availability: it.availability || 'in stock',
    status: 'active',
    brand: it.brand,
    contentId: it.contentId,
    _fallbackImageLink: it.imageLink,
  }
}
