import Papa from 'papaparse'
import { parseMediaEntries } from './media'
import type { CatalogRow } from './types'

const VIDEO_EXT = /\.(mp4|mov|webm|m4v)(\?|$)/i

function splitMedia(raw: string): { images: string[]; videos: string[] } {
  const parts = parseMediaEntries(raw)
  const images: string[] = []
  const videos: string[] = []
  for (const p of parts) {
    if (VIDEO_EXT.test(p)) videos.push(p)
    else images.push(p)
  }
  return { images, videos }
}

function isPublicHttpUrl(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed) return false

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return false
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return false
  }

  const host = url.hostname.toLowerCase()
  if (!host) return false

  if (
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host.endsWith('.local')
  ) {
    return false
  }

  if (/^127\./.test(host)) return false
  if (/^10\./.test(host)) return false
  if (/^192\.168\./.test(host)) return false
  if (/^169\.254\./.test(host)) return false

  const private172 = host.match(/^172\.(\d{1,3})\./)
  if (private172) {
    const secondOctet = Number(private172[1])
    if (secondOctet >= 16 && secondOctet <= 31) return false
  }

  return true
}

function isWebpImageUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.pathname.toLowerCase().endsWith('.webp')
  } catch {
    return false
  }
}

function toMetaImageUrl(value: string): string {
  const trimmed = value.trim()
  if (!isPublicHttpUrl(trimmed)) return ''

  // Meta katalogunda WebP tez-tez "Gorsel getirilemedi" verir.
  // Public JPEG URL vermek ucun WebP linkini converter URL-e yonlendiririk.
  if (isWebpImageUrl(trimmed)) {
    return `https://images.weserv.nl/?url=${encodeURIComponent(trimmed)}&output=jpg&q=90`
  }

  return trimmed
}

function parsePriceRaw(raw: string): { amount: number; currency: string } | null {
  const input = raw.trim()
  if (!input) return null

  const amountMatch = input.replace(',', '.').match(/-?\d+(?:\.\d+)?/)
  if (!amountMatch) return null
  const amount = Number(amountMatch[0])
  if (!Number.isFinite(amount) || amount <= 0) return null

  const currencyMatch = input.toUpperCase().match(/\b[A-Z]{3}\b/)
  const currency = currencyMatch?.[0] ?? 'AZN'
  return { amount, currency }
}

function toMetaPrice(raw: string): string {
  const parsed = parsePriceRaw(raw)
  if (!parsed) return ''
  return `${parsed.amount.toFixed(2)} ${parsed.currency}`
}

/**
 * Meta Ticarət Meneceri / kataloq feed-i üçün ingilis sütun adları.
 * @see https://www.facebook.com/business/help/120325381656392
 */
const META_FIELDS = [
  'id',
  'item_group_id',
  'title',
  'description',
  'availability',
  'condition',
  'price',
  'link',
  'image_link',
  'additional_image_link',
  'brand',
  'sale_price',
  'fb_product_category',
  'video_url',
] as const

type MetaCsvOptions = {
  resolveMedia?: (row: CatalogRow, index: number) => string | null | undefined
  useFallbackImage?: boolean
}

export function rowsToMetaCommerceCsv(rows: CatalogRow[], options: MetaCsvOptions = {}): string {
  const missingImageRows: number[] = []
  const idSeen = new Map<string, number>()

  const records: Record<string, string>[] = rows.map((r, idx) => {
    const baseId = r.contentId.trim() || buildSyntheticId(r, idx)
    const count = (idSeen.get(baseId) ?? 0) + 1
    idSeen.set(baseId, count)
    const exportId = count === 1 ? baseId : `${baseId}__${count}`
    const rawMedia = options.resolveMedia?.(r, idx) ?? r.imagesAndVideos
    const { images, videos } = splitMedia(rawMedia)
    const remoteImages = images.map(toMetaImageUrl).filter(Boolean)
    const fallbackImage =
      options.useFallbackImage === false ? '' : toMetaImageUrl(r._fallbackImageLink ?? '')
    const image_link = remoteImages[0] ?? fallbackImage
    if (!image_link) {
      missingImageRows.push(idx + 1)
    }
    const additional_image_link = remoteImages.slice(1).join(',')
    const videoUrl = videos.find(isPublicHttpUrl) ?? ''
    const price = toMetaPrice(r.price)
    let salePrice = toMetaPrice(r.salePrice)

    const priceParsed = parsePriceRaw(price)
    const saleParsed = parsePriceRaw(salePrice)
    if (
      priceParsed &&
      saleParsed &&
      priceParsed.currency === saleParsed.currency &&
      saleParsed.amount >= priceParsed.amount
    ) {
      salePrice = ''
    }

    const rec: Record<string, string> = {
      id: exportId,
      item_group_id: r.contentId.trim() || '',
      title: r.title,
      description: r.description,
      availability: r.availability,
      condition: r.condition,
      price,
      link: r.websiteLink,
      image_link,
      additional_image_link,
      brand: r.brand,
      sale_price: salePrice,
      fb_product_category: r.fbProductCategory,
      video_url: videoUrl,
    }
    return rec
  })

  if (missingImageRows.length > 0) {
    const preview = missingImageRows.slice(0, 12).join(', ')
    throw new Error(
      `CSV xetasi: image_link bosdur. Local/localhost URL qebul olunmur; public URL daxil edin. Problemi olan setirler: ${preview}${
        missingImageRows.length > 12 ? ' ...' : ''
      }`,
    )
  }

  return Papa.unparse(records, {
    columns: [...META_FIELDS],
    header: true,
  })
}

function buildSyntheticId(row: CatalogRow, index: number): string {
  const base = [row.title, row.websiteLink, row.brand]
    .map((part) => part.toLowerCase().replace(/[^a-z0-9]+/g, '-'))
    .join('-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')

  return base ? `manual-${base}-${index + 1}` : `manual-row-${index + 1}`
}

export function downloadTextFile(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  window.setTimeout(() => {
    a.remove()
    URL.revokeObjectURL(url)
  }, 1000)
}
