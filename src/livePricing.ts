import type { ParsedItem } from './feedParser'

type ApiProductItem = {
  id: string
  price?: string | number | null
  taksit?: string | number | null
  new_price?: string | number | null
  discont?: string | number | null
}

type ViewPriceResponse = {
  prices?: Array<{
    price?: string | number | null
    taksit?: string | number | null
  }>
}

type LivePriceResult = {
  price?: string
  salePrice?: string
}

const API_BASE = (import.meta.env.VITE_LIVE_PRICE_PROXY_PATH as string | undefined)?.trim()

let appProdMapPromise: Promise<Map<string, ApiProductItem>> | null = null
let disProdMapPromise: Promise<Map<string, ApiProductItem>> | null = null

const livePriceCache = new Map<string, Promise<LivePriceResult>>()
const EMPTY_PRODUCT_MAP = new Map<string, ApiProductItem>()

export function clearLivePriceCache(): void {
  livePriceCache.clear()
}

function toNumber(value: string | number | null | undefined): number | null {
  if (value == null) return null
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }

  const cleaned = value
    .replace(/\s+/g, '')
    .replace(/AZN|azn|₼/g, '')
    .replace(',', '.')
    .trim()

  if (!cleaned) return null
  const parsed = Number(cleaned)
  return Number.isFinite(parsed) ? parsed : null
}

function toAzn(value: number): string {
  return `${value.toFixed(2)} AZN`
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`)
  }
  return (await response.json()) as T
}

async function getAppProdMap(): Promise<Map<string, ApiProductItem>> {
  if (!API_BASE) return EMPTY_PRODUCT_MAP
  if (!appProdMapPromise) {
    appProdMapPromise = fetchJson<ApiProductItem[]>(`${API_BASE}/app_prod.php`)
      .then((list) => new Map(list.map((item) => [item.id, item])))
      .catch((error) => {
        appProdMapPromise = null
        throw error
      })
  }
  return appProdMapPromise
}

async function getDisProdMap(): Promise<Map<string, ApiProductItem>> {
  if (!API_BASE) return EMPTY_PRODUCT_MAP
  if (!disProdMapPromise) {
    disProdMapPromise = fetchJson<ApiProductItem[]>(`${API_BASE}/app_disprod.php`)
      .then((list) => new Map(list.map((item) => [item.id, item])))
      .catch((error) => {
        disProdMapPromise = null
        throw error
      })
  }
  return disProdMapPromise
}

async function getViewPrice(
  productId: string,
): Promise<{ price: number | null; taksit: number | null }> {
  if (!API_BASE) return { price: null, taksit: null }
  const data = await fetchJson<ViewPriceResponse>(
    `${API_BASE}/app_view.php?id=${encodeURIComponent(productId)}`,
  )
  return {
    price: toNumber(data.prices?.[0]?.price),
    taksit: toNumber(data.prices?.[0]?.taksit),
  }
}

function chooseRegularAndSale(values: number[]): { price?: number; salePrice?: number } {
  const uniq = [...new Set(values)].filter((n) => Number.isFinite(n) && n > 0)
  if (uniq.length === 0) return {}
  if (uniq.length === 1) return { price: uniq[0] }

  const sorted = uniq.sort((a, b) => a - b)
  const salePrice = sorted[0]
  const price = sorted[sorted.length - 1]

  if (price > salePrice) {
    return { price, salePrice }
  }
  return { price }
}

/**
 * Price comes from real product APIs used by the live site:
 * - app_view.php (product detail)
 * - app_prod.php / app_disprod.php (list data with discount metadata)
 *
 * The function tries to infer regular vs sale by comparing numeric candidates.
 */
export async function getLivePriceForItem(item: ParsedItem): Promise<LivePriceResult> {
  const productId = item.contentId?.trim()
  if (!productId) return {}

  if (livePriceCache.has(productId)) {
    return livePriceCache.get(productId)!
  }

  const promise = (async (): Promise<LivePriceResult> => {
    try {
      const [appProdMap, disProdMap, viewData] = await Promise.all([
        getAppProdMap().catch(() => EMPTY_PRODUCT_MAP),
        getDisProdMap().catch(() => EMPTY_PRODUCT_MAP),
        getViewPrice(productId).catch(() => ({ price: null, taksit: null })),
      ])

      const appProd = appProdMap.get(productId)
      const disProd = disProdMap.get(productId)

      const saleCandidates = [
        toNumber(appProd?.price),
        toNumber(appProd?.new_price),
        toNumber(disProd?.price),
        toNumber(disProd?.new_price),
        viewData.price,
      ].filter((n): n is number => n != null && n > 0)

      const regularCandidates = [
        toNumber(appProd?.taksit),
        toNumber(disProd?.taksit),
        viewData.taksit,
      ].filter((n): n is number => n != null && n > 0)

      const sale = saleCandidates.length > 0 ? Math.min(...saleCandidates) : undefined
      const regular =
        regularCandidates.length > 0 ? Math.max(...regularCandidates) : undefined

      // Some merchant APIs expose both current and installment/list prices.
      // If the secondary value is higher, use it as regular `price` and the lower value as `sale_price`.
      if (sale != null && regular != null && regular - sale > 0.1) {
        return {
          price: toAzn(regular),
          salePrice: toAzn(sale),
        }
      }

      const chosen = chooseRegularAndSale(saleCandidates)
      return {
        price: chosen.price != null ? toAzn(chosen.price) : undefined,
        salePrice: chosen.salePrice != null ? toAzn(chosen.salePrice) : undefined,
      }
    } catch {
      return {}
    }
  })()

  livePriceCache.set(productId, promise)
  return promise
}
