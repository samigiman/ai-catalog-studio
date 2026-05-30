import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from 'react'
import {
  ArrowRight,
  Download,
  RefreshCcw,
  type LucideIcon,
} from 'lucide-react'
import {
  filterByName,
  parseGoogleMerchantRss,
  parsedItemToRow,
  type ParsedItem,
} from './feedParser'
import { downloadTextFile, rowsToMetaCommerceCsv } from './csvExport'
import {
  type DriveUploadResult,
  ensureDriveSession,
  getDriveSessionState,
  revokeDriveSession,
  uploadImageToGoogleDrive,
} from './googleDrive'
import { clearLivePriceCache, getLivePriceForItem } from './livePricing'
import {
  analyzeProductImageAi,
  chooseBestCatalogCandidateAi,
  type CatalogCandidateDecision,
  type ImageProductAnalysis,
} from './imageNameReader'
import { appendMediaEntries, parseMediaEntries } from './media'
import type { CatalogRow } from './types'
import './App.css'
import './Workspace.css'

const FEED_URL =
  (import.meta.env.VITE_PRODUCT_FEED_URL as string | undefined)?.trim() ||
  '/sample-products.xml'
const LIVE_PRICE_PROXY_PATH = (
  import.meta.env.VITE_LIVE_PRICE_PROXY_PATH as string | undefined
)?.trim()
const GOOGLE_DRIVE_CLIENT_ID = (
  import.meta.env.VITE_GOOGLE_DRIVE_CLIENT_ID as string | undefined
)?.trim() ?? ''
const DEFAULT_CATALOG_MEDIA_PROVIDER: CatalogMediaProvider = GOOGLE_DRIVE_CLIENT_ID
  ? 'drive'
  : 'current'

const EMPTY_ROW = (): CatalogRow => ({
  imagesAndVideos: '',
  title: '',
  description: '',
  websiteLink: '',
  price: '',
  salePrice: '',
  fbProductCategory: '',
  condition: 'new',
  availability: 'in stock',
  status: 'active',
  brand: '',
  contentId: '',
})

const HEADERS: { key: keyof CatalogRow; label: string; wide?: boolean }[] = [
  { key: 'imagesAndVideos', label: 'Gorseller ve videolar', wide: true },
  { key: 'title', label: 'Title' },
  { key: 'description', label: 'Description', wide: true },
  { key: 'websiteLink', label: 'Website link', wide: true },
  { key: 'price', label: 'Price' },
  { key: 'salePrice', label: 'Sale price' },
  { key: 'fbProductCategory', label: 'Facebook product category' },
  { key: 'condition', label: 'Condition' },
  { key: 'availability', label: 'Availability' },
  { key: 'status', label: 'Status' },
  { key: 'brand', label: 'Brand' },
  { key: 'contentId', label: 'Content ID' },
]

const VIDEO_EXT = /\.(mp4|mov|webm|m4v)(\?|$)/i
const MAX_UPLOAD_FILES_PER_BATCH = 300
const AI_FILES_PER_PASS = 8
const AI_READ_CONCURRENCY = 1
const AI_REQUEST_SPACING_MS = 6500
const MEDIA_UPLOAD_CONCURRENCY = 3
const UPLOAD_PROCESS_CHUNK_SIZE = 40


type UploadMatchStatus = 'auto-added' | 'needs-choice' | 'not-found' | 'chosen'
type MediaLabMode = 'current' | 'google-drive' | 'gcs-public'
type CatalogMediaProvider = 'current' | 'drive'
type AssistantGoal = 'export' | 'refresh-media'

type UploadMatchCard = {
  id: string
  fileName: string
  query: string
  ocrQuery?: string
  colorHint?: string
  aiError?: string
  previewUrl: string
  status: UploadMatchStatus
  candidates: ParsedItem[]
  selectedTitle?: string
  selectedContentId?: string
  uploadedMediaUrl?: string
  mediaUploading?: boolean
  mediaUploadError?: string
  aiAnalysis?: ImageProductAnalysis
  aiMatchNote?: string
  aiDecision?: CatalogCandidateDecision
}

type CandidateRankEntry = {
  item: ParsedItem
  score: number
  matchedQueries: string[]
}

type UploadAiEntry = {
  file: File
  card: UploadMatchCard
}

type MediaLabEntry = {
  driveUrl: string
  driveViewUrl?: string
  driveFileId?: string
  driveState?: 'idle' | 'uploading' | 'ready' | 'error'
  driveMessage?: string
  selectedLocalFileName?: string
  gcsUrl: string
}

type ProductColorApiItem = {
  id?: string
  good?: string
  color?: string | null
}

const MEDIA_LAB_MODES: Array<{
  id: MediaLabMode
  label: string
  description: string
}> = [
  {
    id: 'current',
    label: 'Hazirki axin',
    description: 'Movcud public URL + fallback feed sekilleri ile baseline test.',
  },
  {
    id: 'google-drive',
    label: 'Google Drive testi',
    description: 'Drive share linkini direct URL-e cevirib ayrica feed kimi yoxla.',
  },
  {
    id: 'gcs-public',
    label: 'Google Cloud Storage testi',
    description: 'Public bucket/object URL ile daha stabil sekil hostunu sinayiq.',
  },
]

const CATALOG_MEDIA_PROVIDERS: Array<{
  id: CatalogMediaProvider
  label: string
  description: string
}> = [
  {
    id: 'drive',
    label: 'Google Drive',
    description: 'Daha stabil public link ile sekilleri export-a hazirla.',
  },
  {
    id: 'current',
    label: 'Alternativ public URL',
    description: 'Ehtiyat Catbox/public URL axini.',
  },
]

const ASSISTANT_GOALS: Array<{
  id: AssistantGoal
  label: string
  description: string
  prompt: string
  assistantReply: string
  icon: LucideIcon
}> = [
  {
    id: 'export',
    label: 'Meta CSV hazırla',
    description: 'Şəkilləri yüklə, məhsulları yoxla və sonda CSV-ni endir.',
    prompt: 'Meta üçün export faylını hazırlamaq istəyirəm.',
    assistantReply:
      'Oldu. Mən prosesi hazırlayıram: əvvəl məhsul bazası, sonra şəkillər, sonda isə yükləməyə hazır CSV.',
    icon: Download,
  },
  {
    id: 'refresh-media',
    label: 'Şəkilləri yenilə',
    description: 'Mövcud şəkilləri yenidən uyğunlaşdır, sonra export faylını hazırla.',
    prompt: 'Məhsulların şəkillərini yenidən uyğunlaşdırmaq istəyirəm.',
    assistantReply:
      'Oldu. Şəkilləri yenidən uyğunlaşdıracağam, bitəndən sonra export da hazır olacaq.',
    icon: RefreshCcw,
  },
]

function normalizeMedia(raw: string): string[] {
  return parseMediaEntries(raw)
}

function appendUrl(raw: string, url: string): string {
  return appendMediaEntries(raw, url)
}

function getRowLabKey(row: CatalogRow, index: number): string {
  return row._rowId ?? `${row.contentId || 'row'}-${index}`
}

function extractGoogleDriveFileId(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''

  try {
    const url = new URL(trimmed)
    const openId = url.searchParams.get('id')
    if (openId) return openId

    const pathMatch =
      url.pathname.match(/\/file\/d\/([a-zA-Z0-9_-]+)/) ??
      url.pathname.match(/\/d\/([a-zA-Z0-9_-]+)/)

    return pathMatch?.[1] ?? ''
  } catch {
    const idMatch = trimmed.match(/[a-zA-Z0-9_-]{20,}/)
    return idMatch?.[0] ?? ''
  }
}

function toGoogleDriveDirectUrl(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''

  if (/^https?:\/\/drive\.google\.com\/uc\?/i.test(trimmed)) {
    return trimmed
  }

  const fileId = extractGoogleDriveFileId(trimmed)
  if (!fileId) return trimmed

  // Drive share links are not ideal for Meta, but this gives us a direct-ish
  // test URL without changing the main export flow.
  return `https://drive.google.com/uc?export=view&id=${fileId}`
}

function getMediaLabUrl(mode: MediaLabMode, entry?: MediaLabEntry): string {
  if (!entry) return ''
  if (mode === 'google-drive') return toGoogleDriveDirectUrl(entry.driveUrl)
  if (mode === 'gcs-public') return entry.gcsUrl.trim()
  return ''
}

function getCurrentPrimaryImage(row: CatalogRow): string {
  const currentManaged = row._currentMediaUrl?.trim()
  if (currentManaged) return currentManaged
  const image = normalizeMedia(row.imagesAndVideos).find(
    (value) => !VIDEO_EXT.test(value) && isPublicHttpUrl(value),
  )
  return image ?? row._fallbackImageLink?.trim() ?? ''
}

function buildMediaWithPrimaryImage(imageUrl: string, currentValue: string): string {
  const videos = normalizeMedia(currentValue).filter((value) => VIDEO_EXT.test(value))
  return [imageUrl.trim(), ...videos].filter(Boolean).join('\n')
}

function uniqueMediaEntries(entries: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of entries) {
    const normalized = entry.trim()
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    out.push(normalized)
  }
  return out
}

function buildMediaWithCatalogProvider(
  row: CatalogRow,
  rowKey: string,
  provider: CatalogMediaProvider,
  mediaEntries: Record<string, MediaLabEntry>,
  overrides?: {
    currentUrl?: string
    driveUrl?: string
  },
): string {
  const currentUrl = (overrides?.currentUrl ?? row._currentMediaUrl ?? '').trim()
  const driveUrl = (
    overrides?.driveUrl ??
    row._driveMediaUrl ??
    mediaEntries[rowKey]?.driveUrl ??
    ''
  ).trim()

  const preferredUrl = provider === 'drive' ? driveUrl : currentUrl
  if (!isPublicHttpUrl(preferredUrl)) {
    return row.imagesAndVideos
  }

  const parts = normalizeMedia(row.imagesAndVideos)
  const images = parts.filter((value) => !VIDEO_EXT.test(value))
  const videos = parts.filter((value) => VIDEO_EXT.test(value))
  const managed = new Set([currentUrl, driveUrl].filter(Boolean))
  const remainingImages = images.filter((value) => !managed.has(value.trim()))

  return uniqueMediaEntries([preferredUrl, ...remainingImages, ...videos]).join('\n')
}

function buildMediaForCatalogExport(
  row: CatalogRow,
  rowKey: string,
  provider: CatalogMediaProvider,
  mediaEntries: Record<string, MediaLabEntry>,
): string {
  const currentUrl = (row._currentMediaUrl ?? '').trim()
  const driveUrl = (row._driveMediaUrl ?? mediaEntries[rowKey]?.driveUrl ?? '').trim()
  const fallbackUrl = (row._fallbackImageLink ?? '').trim()
  const preferredUrl = provider === 'drive' ? driveUrl : currentUrl
  const parts = normalizeMedia(row.imagesAndVideos)
  const images = parts.filter((value) => !VIDEO_EXT.test(value))
  const videos = parts.filter((value) => VIDEO_EXT.test(value))
  const managed = new Set([currentUrl, driveUrl, fallbackUrl].filter(Boolean))
  const remainingImages = images.filter((value) => !managed.has(value.trim()))

  if (!isPublicHttpUrl(preferredUrl)) {
    return uniqueMediaEntries([...remainingImages, ...videos]).join('\n')
  }

  return uniqueMediaEntries([preferredUrl, ...remainingImages, ...videos]).join('\n')
}

function isPublicHttpUrl(value: string): boolean {
  const trimmed = value.trim()
  if (!/^https?:\/\//i.test(trimmed)) return false
  try {
    const host = new URL(trimmed).hostname.toLowerCase()
    if (!host) return false
    if (host === 'localhost' || host === '0.0.0.0' || host === '::1' || host.endsWith('.local')) {
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
  } catch {
    return false
  }
}

function toPriceNumber(value: string | null | undefined): number | null {
  if (!value) return null
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

function normalizeSearch(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\u0400-\u04ff\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function compactInlineText(value: string, maxLength: number): string {
  const cleaned = value.replace(/\s+/g, ' ').trim()
  if (cleaned.length <= maxLength) return cleaned
  return `${cleaned.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`
}

function queryFromFileName(fileName: string): string {
  const withoutExt = fileName.replace(/\.[^.]+$/, '')
  return withoutExt
    .replace(/[_+]+/g, ' ')
    .replace(/[-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function queryFromOcrText(rawText: string): string {
  const normalized = normalizeSearch(rawText)
  if (!normalized) return ''

  const tokens = normalized
    .split(' ')
    .filter((token) => token.length > 1)
    .filter((token) => /[a-z0-9\u0400-\u04ff]/.test(token))
    .slice(0, 10)

  return tokens.join(' ')
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    const normalized = value.replace(/\s+/g, ' ').trim()
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    out.push(normalized)
  }
  return out
}

function toSearchTokens(rawText: string): string[] {
  const query = queryFromOcrText(rawText)
  return query ? query.split(' ').filter(Boolean) : []
}

function storageTokensFromText(rawText: string): string[] {
  const normalized = normalizeSearch(rawText)
  if (!normalized) return []

  const matches = normalized.match(/\b\d+\s?(?:gb|tb)\b/g) ?? []
  return uniqueStrings(matches.map((entry) => entry.replace(/\s+/g, '')))
}

function normalizeColorLabel(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim()
}

const COLOR_GROUPS: Array<{ id: string; label: string; aliases: string[] }> = [
  { id: 'black', label: 'Black', aliases: ['black', 'qara', 'chern', 'noir', 'graphite'] },
  { id: 'white', label: 'White', aliases: ['white', 'ag', 'ağ', 'beyaz', 'bel', 'ivory'] },
  { id: 'blue', label: 'Blue', aliases: ['blue', 'mavi', 'goy', 'göy', 'lacivert', 'navy'] },
  { id: 'green', label: 'Green', aliases: ['green', 'yasil', 'yaşıl', 'mint', 'olive'] },
  { id: 'red', label: 'Red', aliases: ['red', 'qirmizi', 'qırmızı', 'bordo', 'rose'] },
  { id: 'pink', label: 'Pink', aliases: ['pink', 'roz', 'rose pink'] },
  { id: 'gray', label: 'Gray', aliases: ['gray', 'grey', 'gri', 'boz', 'silver', 'metal'] },
  { id: 'purple', label: 'Purple', aliases: ['purple', 'violet', 'lilac', 'lavender'] },
  { id: 'gold', label: 'Gold', aliases: ['gold', 'qizil', 'qızıl', 'champagne'] },
  { id: 'brown', label: 'Brown', aliases: ['brown', 'kahve', 'qehveyi', 'qəhvəyi', 'bronze'] },
  { id: 'orange', label: 'Orange', aliases: ['orange', 'narinci'] },
  { id: 'yellow', label: 'Yellow', aliases: ['yellow', 'sari', 'sarı'] },
  { id: 'beige', label: 'Beige', aliases: ['beige', 'cream'] },
]

const COLOR_LABEL_BY_ID: Record<string, string> = Object.fromEntries(
  COLOR_GROUPS.map((group) => [group.id, group.label]),
)

function colorGroupsFromText(raw: string): string[] {
  const text = normalizeSearch(raw)
  if (!text) return []
  const found = new Set<string>()
  for (const group of COLOR_GROUPS) {
    const hasAlias = group.aliases.some((alias) => text.includes(normalizeSearch(alias)))
    if (hasAlias) found.add(group.id)
  }
  return [...found]
}

function buildColorHint(...parts: Array<string | undefined>): string {
  const found = new Set<string>()
  for (const part of parts) {
    if (!part) continue
    for (const group of colorGroupsFromText(part)) {
      found.add(group)
    }
  }
  return [...found]
    .map((id) => COLOR_LABEL_BY_ID[id] ?? id)
    .join(', ')
}

function rankCandidatesByColorHint(
  candidates: ParsedItem[],
  colorHint: string | undefined,
  colorById: Record<string, string>,
): ParsedItem[] {
  const hintGroups = colorGroupsFromText(colorHint ?? '')
  if (hintGroups.length === 0) return candidates

  const scored = candidates.map((candidate, index) => {
    const productColor = colorById[candidate.contentId] ?? ''
    const productGroups = colorGroupsFromText(productColor)
    const score = hintGroups.reduce(
      (sum, hint) => (productGroups.includes(hint) ? sum + 100 : sum),
      0,
    )
    return { candidate, index, score }
  })

  if (scored.every((entry) => entry.score === 0)) return candidates

  scored.sort((a, b) => b.score - a.score || a.index - b.index)
  return scored.map((entry) => entry.candidate)
}

function scoreItemAgainstQuery(item: ParsedItem, rawQuery: string): number {
  const query = normalizeSearch(rawQuery)
  if (!query) return 0

  const tokens = query.split(' ').filter((token) => token.length > 1)
  if (tokens.length === 0) return 0

  const title = normalizeSearch(item.title)
  const description = normalizeSearch(item.description)

  let score = 0
  let tokenHits = 0

  if (title.includes(query)) score += 120
  if (description.includes(query)) score += 70

  for (const token of tokens) {
    if (title.includes(token)) {
      score += 10
      tokenHits += 1
    } else if (description.includes(token)) {
      score += 4
      tokenHits += 1
    }
  }

  if (score === 0) return 0
  if (tokens.length >= 3 && tokenHits < Math.ceil(tokens.length / 2) && !title.includes(query)) {
    return 0
  }

  return score - Math.min(28, Math.abs(title.length - query.length) * 0.2)
}

function buildAnalysisQueries(
  baseQuery: string,
  analysis?: ImageProductAnalysis | null,
): string[] {
  const queries = [
    analysis?.searchQuery ?? '',
    [
      analysis?.brand,
      analysis?.series,
      analysis?.model,
      analysis?.variant,
      analysis?.storage,
    ]
      .filter(Boolean)
      .join(' '),
    [analysis?.brand, analysis?.series, analysis?.model].filter(Boolean).join(' '),
    analysis?.productName ?? '',
    baseQuery,
    analysis?.visibleText ?? '',
    analysis?.rawText ?? '',
  ]

  return uniqueStrings(
    queries
      .map((entry) => queryFromOcrText(entry))
      .filter((entry) => entry.length > 0),
  )
}

function rankCandidatesForUpload(
  items: ParsedItem[],
  baseQuery: string,
  analysis: ImageProductAnalysis | null | undefined,
  colorById: Record<string, string>,
): CandidateRankEntry[] {
  const queries = buildAnalysisQueries(baseQuery, analysis)
  if (queries.length === 0) return []

  const analysisColorHint = buildColorHint(baseQuery, analysis?.searchQuery, analysis?.color)
  const analysisColorGroups = colorGroupsFromText(analysisColorHint)
  const modelTokens = toSearchTokens(
    [analysis?.series, analysis?.model, analysis?.variant].filter(Boolean).join(' '),
  )
  const storageTokens = storageTokensFromText(
    [analysis?.storage, analysis?.searchQuery, baseQuery].filter(Boolean).join(' '),
  )
  const confidenceBoost =
    analysis?.confidence === 'high' ? 22 : analysis?.confidence === 'medium' ? 10 : 0

  const ranked: CandidateRankEntry[] = []

  for (const item of items) {
    let score = 0
    const matchedQueries: string[] = []
    const title = normalizeSearch(item.title)
    const description = normalizeSearch(item.description)
    const combined = `${title} ${description}`

    for (const [index, query] of queries.entries()) {
      const queryScore = scoreItemAgainstQuery(item, query)
      if (queryScore <= 0) continue
      score += queryScore + Math.max(18, 56 - index * 12)
      matchedQueries.push(query)
    }

    if (score === 0) continue

    const brandQuery = normalizeSearch(analysis?.brand ?? '')
    if (brandQuery && title.includes(brandQuery)) {
      score += 42
    }

    if (modelTokens.length > 0) {
      let modelHits = 0
      for (const token of modelTokens) {
        if (combined.includes(token)) {
          modelHits += 1
        }
      }
      score += modelHits * 18
      if (modelHits === modelTokens.length && modelHits > 0) {
        score += 28
      }
    }

    if (storageTokens.length > 0) {
      let storageHits = 0
      for (const token of storageTokens) {
        if (combined.includes(normalizeSearch(token))) {
          storageHits += 1
        }
      }
      score += storageHits * 24
    }

    if (analysisColorGroups.length > 0) {
      const candidateColorGroups = colorGroupsFromText(colorById[item.contentId] ?? '')
      const overlap = analysisColorGroups.filter((group) => candidateColorGroups.includes(group))
      if (overlap.length > 0) {
        score += overlap.length * 84
      } else if (candidateColorGroups.length > 0) {
        score -= 18
      }
    }

    score += confidenceBoost
    ranked.push({ item, score, matchedQueries })
  }

  ranked.sort((a, b) => b.score - a.score)
  return ranked.slice(0, 8)
}

function shouldAutoSelectCandidate(
  ranked: CandidateRankEntry[],
  rawQuery: string,
  analysis?: ImageProductAnalysis | null,
): boolean {
  const top = ranked[0]
  if (!top) return false

  if (isConfidentAutoMatch(top.item, analysis?.searchQuery || rawQuery)) {
    return true
  }

  const secondScore = ranked[1]?.score ?? 0
  const gap = top.score - secondScore
  const confidence = analysis?.confidence ?? 'low'

  if (confidence === 'high') {
    return top.score >= 190 && gap >= 26
  }
  if (confidence === 'medium') {
    return top.score >= 210 && gap >= 34
  }
  return top.score >= 230 && gap >= 42
}

function buildAiAnalysisChips(analysis?: ImageProductAnalysis): string[] {
  if (!analysis) return []
  const confidenceLabel = describeConfidence(analysis.confidence)
  const engineLabel = normalizeEngineLabel(analysis.engine)
  return [
    engineLabel ? `Mühərrik: ${engineLabel}` : '',
    analysis.brand ? `Brend: ${analysis.brand}` : '',
    analysis.series ? `Seriya: ${analysis.series}` : '',
    analysis.model ? `Model: ${analysis.model}` : '',
    analysis.variant ? `Variant: ${analysis.variant}` : '',
    analysis.storage ? `Yaddaş: ${analysis.storage}` : '',
    analysis.color ? `Rəng: ${analysis.color}` : '',
    analysis.category ? `Kateqoriya: ${analysis.category}` : '',
    analysis.condition ? `Vəziyyət: ${analysis.condition}` : '',
    `AI etibarı: ${confidenceLabel}`,
  ].filter(Boolean)
}

function describeConfidence(confidence: CatalogCandidateDecision['confidence']): string {
  if (confidence === 'high') return 'yüksək'
  if (confidence === 'medium') return 'orta'
  return 'aşağı'
}

function isAiQuotaError(error: string | undefined): boolean {
  const normalized = (error ?? '').toLowerCase()
  if (!normalized) return false
  return (
    normalized.includes('429') &&
    (normalized.includes('quota') ||
      normalized.includes('billing') ||
      normalized.includes('rate limit'))
  )
}

function summarizeAiError(error: string | undefined): string {
  const normalized = (error ?? '').trim()
  if (!normalized) return 'AI analizi alınmadı.'
  if (isAiQuotaError(normalized)) {
    return 'Gemini kvotası bitib. Billing və limitlər yoxlanmalıdır.'
  }
  if (normalized.toLowerCase().includes('openai proxy deaktivdir')) {
    return 'OpenAI proxy aktiv deyil.'
  }
  return compactInlineText(normalized, 140)
}

function normalizeEngineLabel(engine: string): string {
  const normalized = engine.trim().toLowerCase()
  if (!normalized) return ''
  if (normalized.includes('gemini-3.1')) return 'Gemini 3.1 Pro'
  if (normalized.includes('gemini-3')) return 'Gemini 3'
  if (normalized.includes('gemini-2.5')) return 'Gemini 2.5'
  if (normalized.includes('gpt-5')) return 'GPT-5'
  if (normalized.includes('gpt-4.1')) return 'GPT-4.1'
  return engine
}

function reorderCandidatesByDecision(
  candidates: ParsedItem[],
  decision?: CatalogCandidateDecision,
): ParsedItem[] {
  const selectedId = decision?.selectedContentId?.trim()
  if (!selectedId) return candidates
  const chosen = candidates.find((candidate) => candidate.contentId === selectedId)
  if (!chosen) return candidates
  return [chosen, ...candidates.filter((candidate) => candidate.contentId !== selectedId)]
}

function buildAiMetaPreview(analysis?: ImageProductAnalysis): string {
  if (!analysis) return ''
  if (analysis.metaDescription) return analysis.metaDescription
  if (analysis.metaTitle) return analysis.metaTitle
  return ''
}

function shouldUseAiMetaTitle(item: ParsedItem, analysis?: ImageProductAnalysis | null): boolean {
  const candidate = analysis?.metaTitle?.trim()
  if (!candidate) return false

  const itemTokens = new Set(toSearchTokens(item.title))
  const aiTokens = toSearchTokens(candidate)
  if (aiTokens.length === 0 || itemTokens.size === 0) return false

  const overlap = aiTokens.filter((token) => itemTokens.has(token)).length
  return overlap >= Math.max(2, Math.ceil(Math.min(aiTokens.length, itemTokens.size) / 2))
}

function applyAiDraftToCatalogRow(
  row: CatalogRow,
  item: ParsedItem,
  analysis?: ImageProductAnalysis | null,
): CatalogRow {
  if (!analysis) return row

  return {
    ...row,
    title: shouldUseAiMetaTitle(item, analysis) ? analysis.metaTitle : row.title,
    description: analysis.metaDescription || row.description,
    brand: row.brand || analysis.brand,
    fbProductCategory: row.fbProductCategory || analysis.fbProductCategoryHint,
  }
}

function buildAiMatchNote(
  card: Pick<UploadMatchCard, 'aiAnalysis' | 'aiDecision' | 'colorHint' | 'aiError'>,
): string {
  const analysis = card.aiAnalysis
  if (card.aiDecision?.selectedContentId) {
    const confidenceLabel = describeConfidence(card.aiDecision.confidence)
    const reason = card.aiDecision.reason ? ` • ${card.aiDecision.reason}` : ''
    return `AI seçimi: ${confidenceLabel}${reason}`
  }

  if (!analysis) {
    if (card.aiError) {
      const normalizedError = card.aiError.toLowerCase()
      const errorLabel = normalizedError.includes('openai')
        ? 'OpenAI xətası'
        : normalizedError.includes('gemini')
          ? 'Gemini xətası'
          : 'AI xətası'
      const shortError = summarizeAiError(card.aiError)
      return card.colorHint
        ? `${errorLabel}: ${shortError} • Rəng ipucu: ${card.colorHint}`
        : `${errorLabel}: ${shortError}`
    }
    return card.colorHint
      ? `Gemini analizi alınmadı • Rəng ipucu: ${card.colorHint}`
      : 'Gemini analizi alınmadı.'
  }

  const parts = [
    analysis.searchQuery ? `Sorgu: ${analysis.searchQuery}` : '',
    analysis.color || card.colorHint
      ? `Rəng: ${analysis.color || card.colorHint}`
      : '',
    analysis.category ? `Kateqoriya: ${analysis.category}` : '',
    analysis.matchSignals[0] ? `İz: ${analysis.matchSignals[0]}` : '',
  ].filter(Boolean)

  return parts.join(' • ')
}

function buildUploadCardSearchText(card: UploadMatchCard): string {
  const analysis = card.aiAnalysis
  const text = [
    card.fileName,
    card.query,
    card.ocrQuery,
    card.colorHint,
    card.selectedTitle,
    analysis?.engine,
    analysis?.brand,
    analysis?.series,
    analysis?.model,
    analysis?.variant,
    analysis?.storage,
    analysis?.color,
    analysis?.category,
    analysis?.searchQuery,
    analysis?.metaTitle,
    analysis?.metaDescription,
    analysis?.matchSignals.join(' '),
    card.candidates.map((candidate) => `${candidate.title} ${candidate.contentId}`).join(' '),
  ]
    .filter(Boolean)
    .join(' ')

  return normalizeSearch(text)
}

function matchesUploadCardSearch(card: UploadMatchCard, query: string): boolean {
  const normalizedQuery = normalizeSearch(query)
  if (!normalizedQuery) return true
  return buildUploadCardSearchText(card).includes(normalizedQuery)
}

function withRowMeta(row: CatalogRow, sourceUploadId?: string): CatalogRow {
  return {
    ...row,
    _rowId: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    _sourceUploadId: sourceUploadId,
  }
}

function withUploadPreview(row: CatalogRow, previewUrl?: string): CatalogRow {
  if (!previewUrl) return row
  return {
    ...row,
    _localPreviewUrl: previewUrl,
  }
}

function mergeCandidateLists(
  primary: ParsedItem[],
  secondary: ParsedItem[],
  limit = 8,
): ParsedItem[] {
  const map = new Map<string, ParsedItem>()
  for (const item of [...primary, ...secondary]) {
    if (!map.has(item.contentId)) {
      map.set(item.contentId, item)
    }
    if (map.size >= limit) break
  }
  return [...map.values()]
}

async function mapWithConcurrency<T, R>(
  list: T[],
  concurrency: number,
  handler: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (list.length === 0) return []
  const size = Math.max(1, Math.min(concurrency, list.length))
  const out = new Array<R>(list.length)
  let cursor = 0

  await Promise.all(
    Array.from({ length: size }, async () => {
      while (true) {
        const index = cursor
        cursor += 1
        if (index >= list.length) break
        out[index] = await handler(list[index], index)
      }
    }),
  )

  return out
}

function chunkList<T>(list: T[], size: number): T[][] {
  const safeSize = Math.max(1, size)
  const chunks: T[][] = []
  for (let index = 0; index < list.length; index += safeSize) {
    chunks.push(list.slice(index, index + safeSize))
  }
  return chunks
}

function waitForNextPaint(): Promise<void> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => resolve())
  })
}

function isConfidentAutoMatch(item: ParsedItem, rawQuery: string): boolean {
  const query = normalizeSearch(rawQuery)
  if (query.length < 4) return false

  const title = normalizeSearch(item.title)
  if (!title) return false
  if (title.includes(query)) return true

  const queryTokens = query.split(' ').filter((token) => token.length > 1)
  if (queryTokens.length < 3) return false

  const hits = queryTokens.filter((token) => title.includes(token)).length
  return hits >= Math.ceil(queryTokens.length * 0.75)
}

function findCandidatesByQuery(items: ParsedItem[], rawQuery: string): ParsedItem[] {
  const scored: Array<{ item: ParsedItem; score: number }> = []

  for (const item of items) {
    const score = scoreItemAgainstQuery(item, rawQuery)
    if (score === 0) continue
    scored.push({ item, score })
  }

  scored.sort((a, b) => b.score - a.score)

  const unique = new Map<string, ParsedItem>()
  for (const entry of scored) {
    if (!unique.has(entry.item.contentId)) {
      unique.set(entry.item.contentId, entry.item)
    }
    if (unique.size >= 8) break
  }

  return [...unique.values()]
}

function App() {
  const [feedItems, setFeedItems] = useState<ParsedItem[]>([])
  const [feedError, setFeedError] = useState<string | null>(null)
  const [tableError, setTableError] = useState<string | null>(null)
  const [tableNotice, setTableNotice] = useState<string | null>(null)
  const [catalogMediaProvider, setCatalogMediaProvider] =
    useState<CatalogMediaProvider>(DEFAULT_CATALOG_MEDIA_PROVIDER)
  const [mediaLabError, setMediaLabError] = useState<string | null>(null)
  const [mediaLabNotice, setMediaLabNotice] = useState<string | null>(null)
  const [driveConnected, setDriveConnected] = useState(Boolean(getDriveSessionState()))
  const [driveBusy, setDriveBusy] = useState(false)
  const [driveStatus, setDriveStatus] = useState<string | null>(null)
  const [loadingFeed, setLoadingFeed] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [rows, setRows] = useState<CatalogRow[]>([])
  const [mediaDrafts, setMediaDrafts] = useState<Record<number, string>>({})
  const [mediaLabMode, setMediaLabMode] = useState<MediaLabMode>('current')
  const [mediaLabEntries, setMediaLabEntries] = useState<Record<string, MediaLabEntry>>({})
  const [mediaLabResults, setMediaLabResults] = useState<
    Partial<Record<MediaLabMode, 'works' | 'fails'>>
  >({})
  const [loadingLivePrices, setLoadingLivePrices] = useState(false)
  const [uploadMatches, setUploadMatches] = useState<UploadMatchCard[]>([])
  const [manualSearchDrafts, setManualSearchDrafts] = useState<Record<string, string>>({})
  const [expandedCandidates, setExpandedCandidates] = useState<Record<string, boolean>>({})
  const [reviewSearchQuery, setReviewSearchQuery] = useState('')
  const [productColorById, setProductColorById] = useState<Record<string, string>>({})
  const [uploadNotice, setUploadNotice] = useState<string | null>(null)
  const [aiReadProgress, setAiReadProgress] = useState<{
    done: number
    total: number
  } | null>(null)
  const [processingUploads, setProcessingUploads] = useState(false)
  const [preparingExport, setPreparingExport] = useState(false)
  const [assistantGoal, setAssistantGoal] = useState<AssistantGoal | null>(null)
  const previewUrlsRef = useRef<string[]>([])
  const tableStatusRef = useRef<HTMLDivElement | null>(null)
  const guidedUploadInputRef = useRef<HTMLInputElement | null>(null)
  const uploadFileByIdRef = useRef<Record<string, File>>({})
  const uploadPublicUrlByIdRef = useRef<Record<string, string>>({})
  const uploadPublicPromiseByIdRef = useRef<Record<string, Promise<string | null>>>({})
  const uploadDriveUrlByIdRef = useRef<Record<string, string>>({})
  const uploadDrivePromiseByIdRef = useRef<Record<string, Promise<string | null>>>({})
  const productColorMapPromiseRef = useRef<Promise<Record<string, string>> | null>(null)

  const matches = useMemo(
    () => filterByName(feedItems, searchQuery),
    [feedItems, searchQuery],
  )
  const deferredReviewSearchQuery = useDeferredValue(reviewSearchQuery)

  useEffect(() => {
    if (!tableError && !tableNotice) return

    const frameId = window.requestAnimationFrame(() => {
      tableStatusRef.current?.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
      })
    })

    return () => window.cancelAnimationFrame(frameId)
  }, [tableError, tableNotice])

  const uploadStats = useMemo(() => {
    const stats = {
      autoAdded: 0,
      needsChoice: 0,
      chosen: 0,
      notFound: 0,
    }

    for (const card of uploadMatches) {
      if (card.status === 'auto-added') stats.autoAdded += 1
      if (card.status === 'needs-choice') stats.needsChoice += 1
      if (card.status === 'chosen') stats.chosen += 1
      if (card.status === 'not-found') stats.notFound += 1
    }
    return stats
  }, [uploadMatches])

  const aiInsightStats = useMemo(
    () =>
      uploadMatches.reduce(
        (stats, card) => {
          if (card.aiAnalysis) stats.analyzed += 1
          if (card.aiDecision?.selectedContentId) stats.decided += 1
          if (card.aiAnalysis?.metaDescription || card.aiAnalysis?.metaTitle) stats.metaDrafts += 1
          if (
            card.aiDecision?.confidence === 'high' ||
            card.aiAnalysis?.confidence === 'high'
          ) {
            stats.highConfidence += 1
          }
          return stats
        },
        {
          analyzed: 0,
          decided: 0,
          metaDrafts: 0,
          highConfidence: 0,
        },
      ),
    [uploadMatches],
  )

  const configuredAiPrimaryLabel = useMemo(() => {
    const geminiModel = (import.meta.env.VITE_GEMINI_MODEL as string | undefined)?.trim()
    if (geminiModel) return geminiModel

    const openAiModel = (
      import.meta.env.VITE_OPENAI_VISION_MODEL as string | undefined
    )?.trim()
    if (openAiModel) return openAiModel
    return 'gemini-2.5-flash'
  }, [])

  const mediaLabReadyCounts = useMemo(() => {
    return Object.fromEntries(
      MEDIA_LAB_MODES.map((mode) => {
        const ready = rows.filter((row, index) => {
          if (mode.id === 'current') {
            return isPublicHttpUrl(getCurrentPrimaryImage(row))
          }
          const entry = mediaLabEntries[getRowLabKey(row, index)]
          return isPublicHttpUrl(getMediaLabUrl(mode.id, entry))
        }).length
        return [mode.id, ready]
      }),
    ) as Record<MediaLabMode, number>
  }, [mediaLabEntries, rows])

  useEffect(
    () => () => {
      for (const url of previewUrlsRef.current) {
        URL.revokeObjectURL(url)
      }
      previewUrlsRef.current = []
    },
    [],
  )

  const analyzeUploadImage = useCallback(
    async (
      file: File,
    ): Promise<{
      query: string
      analysis: ImageProductAnalysis | null
      error?: string
    }> => {
      try {
        const analysis = await analyzeProductImageAi(file)
        if (analysis) {
          const normalizedQuery =
            queryFromOcrText(analysis.searchQuery) ||
            normalizeSearch(analysis.searchQuery) ||
            queryFromOcrText(analysis.productName) ||
            normalizeSearch(analysis.productName)

          if (normalizedQuery) {
            return {
              query: normalizedQuery,
              analysis: { ...analysis, searchQuery: normalizedQuery },
            }
          }
        }
      } catch (error) {
        return {
          query: '',
          analysis: null,
          error:
            error instanceof Error
              ? error.message
              : 'Gemini analizi zamani gozlenilmez xeta oldu.',
        }
      }
      return {
        query: '',
        analysis: null,
        error: 'Gemini sekilden istifade oluna bilen strukturlaşdirilmiş cavab qaytarmadi.',
      }
    },
    [],
  )

  const loadFeedItems = useCallback(async (): Promise<ParsedItem[]> => {
    setFeedError(null)
    setLoadingFeed(true)
    try {
      const res = await fetch(FEED_URL)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const xml = await res.text()
      const items = parseGoogleMerchantRss(xml)
      setFeedItems(items)
      return items
    } catch (e) {
      setFeedError(
        e instanceof Error
          ? e.message
          : 'Feed yuklenmedi. `npm run dev` ile calisdiginizdan emin olun.',
      )
      setFeedItems([])
      return []
    } finally {
      setLoadingFeed(false)
    }
  }, [])

  const loadProductColorMap = useCallback(async (): Promise<Record<string, string>> => {
    if (!LIVE_PRICE_PROXY_PATH) {
      setProductColorById({})
      return {}
    }

    if (productColorMapPromiseRef.current) {
      return productColorMapPromiseRef.current
    }

    const promise = (async () => {
      try {
        const [appProdRes, disProdRes] = await Promise.all([
          fetch(`${LIVE_PRICE_PROXY_PATH}/app_prod.php`),
          fetch(`${LIVE_PRICE_PROXY_PATH}/app_disprod.php`),
        ])

        if (!appProdRes.ok || !disProdRes.ok) {
          throw new Error('Color API response failed')
        }

        const [appProdData, disProdData] = (await Promise.all([
          appProdRes.json(),
          disProdRes.json(),
        ])) as [ProductColorApiItem[], ProductColorApiItem[]]

        const map: Record<string, string> = {}

        for (const item of appProdData) {
          const id = item.id?.trim()
          const color = normalizeColorLabel(item.color)
          if (id && color) map[id] = color
        }

        // Some discounted entries may use `good` as product id.
        for (const item of disProdData) {
          const id = (item.good ?? item.id ?? '').trim()
          const color = normalizeColorLabel(item.color)
          if (id && color && !map[id]) map[id] = color
        }

        setProductColorById(map)
        return map
      } catch {
        setProductColorById({})
        return {}
      }
    })()

    productColorMapPromiseRef.current = promise.catch(() => {
      productColorMapPromiseRef.current = null
      return {}
    })

    return productColorMapPromiseRef.current
  }, [])

  const loadFeed = useCallback(async () => {
    await Promise.all([loadFeedItems(), loadProductColorMap()])
  }, [loadFeedItems, loadProductColorMap])

  const buildRowWithLivePricing = useCallback(async (item: ParsedItem): Promise<CatalogRow> => {
    const base = parsedItemToRow(item)
    const live = await getLivePriceForItem(item)
    const basePrice = toPriceNumber(base.price)
    const livePrice = toPriceNumber(live.price)
    const liveSale = toPriceNumber(live.salePrice)

    let finalPrice = live.price ?? base.price
    let finalSalePrice = live.salePrice ?? base.salePrice

    if (
      liveSale == null &&
      livePrice != null &&
      basePrice != null &&
      Math.abs(livePrice - basePrice) > 0.0001
    ) {
      finalPrice = toAzn(Math.max(livePrice, basePrice))
      finalSalePrice = toAzn(Math.min(livePrice, basePrice))
    }

    return {
      ...base,
      price: finalPrice,
      salePrice: finalSalePrice,
    }
  }, [])

  const uploadLocalMediaForUploadId = useCallback(async (uploadId: string): Promise<string | null> => {
    if (!uploadId) return null

    const cached = uploadPublicUrlByIdRef.current[uploadId]
    if (cached) return cached

    const inflight = uploadPublicPromiseByIdRef.current[uploadId]
    if (inflight) return inflight

    const file = uploadFileByIdRef.current[uploadId]
    if (!file) return null

    const task = (async () => {
      setUploadMatches((prev) =>
        prev.map((card) =>
          card.id === uploadId
            ? { ...card, mediaUploading: true, mediaUploadError: undefined }
            : card,
        ),
      )
      try {
        const form = new FormData()
        form.append('reqtype', 'fileupload')
        form.append('fileToUpload', file, file.name || `${uploadId}.jpg`)

        const res = await fetch('/proxy-catbox-upload', { method: 'POST', body: form })
        const text = (await res.text()).trim()
        if (!res.ok) {
          if (res.status === 412) {
            throw new Error(
              GOOGLE_DRIVE_CLIENT_ID
                ? 'Catbox upload bloklandı. Google Drive ile davam edilir.'
                : 'Catbox upload bloklandı. Public URL üçün alternativ host lazımdır.',
            )
          }
          throw new Error(text || `Media upload HTTP ${res.status}`)
        }

        if (!isPublicHttpUrl(text)) {
          throw new Error('Media upload URL duzgun gelmedi')
        }

        uploadPublicUrlByIdRef.current[uploadId] = text
        setUploadMatches((prev) =>
          prev.map((card) =>
            card.id === uploadId
              ? { ...card, uploadedMediaUrl: text, mediaUploadError: undefined }
              : card,
          ),
        )
        return text
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Sekli public URL-e yuklemek olmadi'
        setUploadMatches((prev) =>
          prev.map((card) =>
            card.id === uploadId ? { ...card, mediaUploadError: message } : card,
          ),
        )
        return null
      } finally {
        setUploadMatches((prev) =>
          prev.map((card) =>
            card.id === uploadId ? { ...card, mediaUploading: false } : card,
          ),
        )
        delete uploadPublicPromiseByIdRef.current[uploadId]
      }
    })()

    uploadPublicPromiseByIdRef.current[uploadId] = task
    return task
  }, [])

  const uploadDriveMediaForUploadId = useCallback(
    async (uploadId: string, rowKey: string): Promise<string | null> => {
      if (!uploadId) return null
      if (!GOOGLE_DRIVE_CLIENT_ID) {
        setTableError('Google Drive client id tapilmadi.')
        return null
      }

      const cached = uploadDriveUrlByIdRef.current[uploadId]
      if (cached) return cached

      const inflight = uploadDrivePromiseByIdRef.current[uploadId]
      if (inflight) return inflight

      const file = uploadFileByIdRef.current[uploadId]
      if (!file) return null

      const task = (async () => {
        setUploadMatches((prev) =>
          prev.map((card) =>
            card.id === uploadId
              ? { ...card, mediaUploading: true, mediaUploadError: undefined }
              : card,
          ),
        )
        try {
          const session = await ensureDriveSession(GOOGLE_DRIVE_CLIENT_ID)
          setDriveConnected(true)

          const uploaded = await uploadImageToGoogleDrive(file, session.accessToken)
          uploadDriveUrlByIdRef.current[uploadId] = uploaded.publicUrl

          setMediaLabEntries((prev) => ({
            ...prev,
            [rowKey]: {
              ...prev[rowKey],
              driveUrl: uploaded.publicUrl,
              driveViewUrl: uploaded.webViewLink,
              driveFileId: uploaded.fileId,
              driveState: 'ready',
              driveMessage: 'Drive link hazirdir.',
              selectedLocalFileName: file.name,
              gcsUrl: prev[rowKey]?.gcsUrl ?? '',
            },
          }))

          setUploadMatches((prev) =>
            prev.map((card) =>
              card.id === uploadId
                ? { ...card, uploadedMediaUrl: uploaded.publicUrl, mediaUploadError: undefined }
                : card,
            ),
          )
          return uploaded.publicUrl
        } catch (error) {
          const message =
            error instanceof Error ? error.message : 'Google Drive upload alinmadi.'
          setUploadMatches((prev) =>
            prev.map((card) =>
              card.id === uploadId ? { ...card, mediaUploadError: message } : card,
            ),
          )
          setMediaLabEntries((prev) => ({
            ...prev,
            [rowKey]: {
              ...prev[rowKey],
              driveUrl: prev[rowKey]?.driveUrl ?? '',
              gcsUrl: prev[rowKey]?.gcsUrl ?? '',
              driveState: 'error',
              driveMessage: message,
              selectedLocalFileName: file.name,
            },
          }))
          setDriveStatus(message)
          return null
        } finally {
          setUploadMatches((prev) =>
            prev.map((card) =>
              card.id === uploadId ? { ...card, mediaUploading: false } : card,
            ),
          )
          delete uploadDrivePromiseByIdRef.current[uploadId]
        }
      })()

      uploadDrivePromiseByIdRef.current[uploadId] = task
      return task
    },
    [],
  )

  const applyCatalogMediaProviderToRows = useCallback(
    (provider: CatalogMediaProvider, targetRowKeys?: string[]) => {
      const targetSet = targetRowKeys ? new Set(targetRowKeys) : null
      let applied = 0

      const nextRows = rows.map((row, index) => {
        const rowKey = getRowLabKey(row, index)
        if (targetSet && !targetSet.has(rowKey)) return row

        const nextMedia = buildMediaWithCatalogProvider(
          row,
          rowKey,
          provider,
          mediaLabEntries,
        )
        if (nextMedia === row.imagesAndVideos) return row

        applied += 1
        return {
          ...row,
          imagesAndVideos: nextMedia,
        }
      })

      if (applied > 0) {
        setRows(nextRows)
      }

      return applied
    },
    [mediaLabEntries, rows],
  )

  const getCachedUploadedUrl = useCallback(
    (uploadId: string) =>
      catalogMediaProvider === 'drive'
        ? uploadDriveUrlByIdRef.current[uploadId]
        : uploadPublicUrlByIdRef.current[uploadId],
    [catalogMediaProvider],
  )

  const ensureUploadedMediaForSelection = useCallback(
    async (uploadId: string, rowKey: string): Promise<string> => {
      const cached = getCachedUploadedUrl(uploadId)?.trim() ?? ''
      if (cached) return cached

      let uploadedUrl: string | null = null
      if (catalogMediaProvider === 'drive') {
        uploadedUrl = await uploadDriveMediaForUploadId(uploadId, rowKey)
        if (!uploadedUrl) {
          uploadedUrl = await uploadLocalMediaForUploadId(uploadId)
        }
      } else {
        uploadedUrl = await uploadLocalMediaForUploadId(uploadId)
        if (!uploadedUrl && GOOGLE_DRIVE_CLIENT_ID) {
          uploadedUrl = await uploadDriveMediaForUploadId(uploadId, rowKey)
        }
      }

      return uploadedUrl?.trim() ?? ''
    },
    [
      catalogMediaProvider,
      getCachedUploadedUrl,
      uploadDriveMediaForUploadId,
      uploadLocalMediaForUploadId,
    ],
  )

  const buildRowForUploadSelection = useCallback(
    async (
      uploadId: string,
      item: ParsedItem,
      previewUrl?: string,
      analysis?: ImageProductAnalysis | null,
    ): Promise<CatalogRow> => {
      const priced = applyAiDraftToCatalogRow(
        await buildRowWithLivePricing(item),
        item,
        analysis,
      )
      let row = withUploadPreview(withRowMeta(priced, uploadId), previewUrl)
      const rowKey = row._rowId ?? getRowLabKey(row, 0)
      const uploadedUrl = await ensureUploadedMediaForSelection(uploadId, rowKey)
      if (uploadedUrl) {
        row = {
          ...row,
          _currentMediaUrl: uploadedUrl,
          _driveMediaUrl: uploadedUrl,
          imagesAndVideos: buildMediaWithCatalogProvider(
            {
              ...row,
              _currentMediaUrl: uploadedUrl,
              _driveMediaUrl: uploadedUrl,
            },
            rowKey,
            catalogMediaProvider,
            mediaLabEntries,
            {
              currentUrl: uploadedUrl,
              driveUrl: uploadedUrl,
            },
          ),
        }
      }
      return row
    },
    [
      buildRowWithLivePricing,
      catalogMediaProvider,
      ensureUploadedMediaForSelection,
      mediaLabEntries,
    ],
  )

  const addMatchesToTable = useCallback(async () => {
    if (matches.length === 0) return

    setLoadingLivePrices(true)
    try {
      const newRows = await Promise.all(matches.map((item) => buildRowWithLivePricing(item)))
      setRows((prev) => [...prev, ...newRows.map((row) => withRowMeta(row))])
    } finally {
      setLoadingLivePrices(false)
    }
  }, [buildRowWithLivePricing, matches])

  const selectUploadCandidate = useCallback(
    async (uploadId: string, item: ParsedItem, previewUrl?: string) => {
      setLoadingLivePrices(true)
      try {
        const analysis = uploadMatches.find((entry) => entry.id === uploadId)?.aiAnalysis
        const row = await buildRowForUploadSelection(uploadId, item, previewUrl, analysis)
        setRows((prev) => [...prev, row])
        setUploadMatches((prev) =>
          prev.map((entry) =>
            entry.id === uploadId
              ? {
                  ...entry,
                  status: 'chosen',
                  selectedTitle: item.title,
                  selectedContentId: item.contentId,
                  uploadedMediaUrl: getCachedUploadedUrl(uploadId) ?? entry.uploadedMediaUrl,
                  colorHint:
                    entry.colorHint ||
                    buildColorHint(productColorById[item.contentId] ?? '', item.title),
                  candidates: entry.candidates.some(
                    (candidate) => candidate.contentId === item.contentId,
                  )
                    ? entry.candidates
                    : [item, ...entry.candidates],
                }
              : entry,
          ),
        )
      } finally {
        setLoadingLivePrices(false)
      }
    },
    [buildRowForUploadSelection, getCachedUploadedUrl, productColorById, uploadMatches],
  )

  const resetUploadSelection = useCallback((uploadId: string) => {
    setRows((prev) => prev.filter((row) => row._sourceUploadId !== uploadId))
    setUploadMatches((prev) =>
      prev.map((entry) => {
        if (entry.id !== uploadId) return entry
        return {
          ...entry,
          status: entry.candidates.length > 0 ? 'needs-choice' : 'not-found',
          selectedTitle: undefined,
          selectedContentId: undefined,
        }
      }),
    )
  }, [])

  const toggleCandidateExpand = useCallback((uploadId: string) => {
    setExpandedCandidates((prev) => ({ ...prev, [uploadId]: !prev[uploadId] }))
  }, [])

  const bulkSelectTopCandidates = useCallback(async () => {
    const selections = uploadMatches
      .filter((card) => card.status === 'needs-choice' && card.candidates[0] != null)
      .map((card) => ({
        uploadId: card.id,
        previewUrl: card.previewUrl,
        item: card.candidates[0],
        analysis: card.aiAnalysis,
      }))

    if (selections.length === 0) return

    setLoadingLivePrices(true)
    try {
      const newRows = await mapWithConcurrency(
        selections,
        MEDIA_UPLOAD_CONCURRENCY,
        async ({ uploadId, item, previewUrl, analysis }) =>
          buildRowForUploadSelection(uploadId, item, previewUrl, analysis),
      )
      setRows((prev) => [...prev, ...newRows])

      const chosenByUploadId = new Map(selections.map((entry) => [entry.uploadId, entry.item]))
      setUploadMatches((prev) =>
        prev.map((card) => {
          const chosen = chosenByUploadId.get(card.id)
          if (!chosen) return card
          return {
            ...card,
            status: 'chosen',
            selectedTitle: chosen.title,
            selectedContentId: chosen.contentId,
            uploadedMediaUrl: getCachedUploadedUrl(card.id) ?? card.uploadedMediaUrl,
            colorHint:
              card.colorHint || buildColorHint(productColorById[chosen.contentId] ?? '', chosen.title),
          }
        }),
      )
    } finally {
      setLoadingLivePrices(false)
    }
  }, [buildRowForUploadSelection, getCachedUploadedUrl, productColorById, uploadMatches])

  const updateUploadSearchDraft = useCallback((uploadId: string, value: string) => {
    setManualSearchDrafts((prev) => ({ ...prev, [uploadId]: value }))
  }, [])

  const searchUploadCardByDraft = useCallback(
    async (uploadId: string) => {
      const query = (manualSearchDrafts[uploadId] ?? '').trim()
      if (!query) return

      const sourceItems = feedItems.length > 0 ? feedItems : await loadFeedItems()
      if (sourceItems.length === 0) return

      setUploadMatches((prev) =>
        prev.map((card) => {
          if (card.id !== uploadId || card.status === 'chosen') return card
          const manualColorHint = buildColorHint(query, card.colorHint)
          const candidates = rankCandidatesByColorHint(
            findCandidatesByQuery(sourceItems, query),
            manualColorHint,
            productColorById,
          )
          if (candidates.length === 0) {
            return {
              ...card,
              status: 'not-found',
              candidates: [],
            }
          }
          return {
            ...card,
            status: 'needs-choice',
            colorHint: manualColorHint || card.colorHint,
            candidates,
          }
        }),
      )
    },
    [feedItems, loadFeedItems, manualSearchDrafts, productColorById],
  )

  const processAiEntries = useCallback(
    async (
      aiEntries: UploadAiEntry[],
      sourceItems: ParsedItem[],
      colorMap: Record<string, string>,
    ): Promise<{ processed: number; quotaErrorHit: boolean }> => {
      if (aiEntries.length === 0) {
        setAiReadProgress(null)
        return { processed: 0, quotaErrorHit: false }
      }

      setAiReadProgress({
        done: 0,
        total: aiEntries.length,
      })

      const patchById = new Map<string, Partial<UploadMatchCard>>()
      const autoFromOcr: Array<{
        uploadId: string
        item: ParsedItem
        previewUrl: string
        analysis?: ImageProductAnalysis | null
      }> = []
      let quotaErrorHit = false

      const results = await mapWithConcurrency(
        aiEntries,
        AI_READ_CONCURRENCY,
        async (entry, index) => {
          if (index > 0 && AI_REQUEST_SPACING_MS > 0) {
            await new Promise((resolve) => window.setTimeout(resolve, AI_REQUEST_SPACING_MS))
          }
          const { query: ocrQuery, analysis, error } = await analyzeUploadImage(entry.file)
          setAiReadProgress((prev) =>
            prev
              ? { ...prev, done: Math.min(prev.total, prev.done + 1) }
              : prev,
          )
          const colorHint = buildColorHint(
            entry.card.query,
            ocrQuery,
            entry.card.colorHint,
            analysis?.color,
          )
          const ranked = rankCandidatesForUpload(
            sourceItems,
            ocrQuery || entry.card.query,
            analysis,
            colorMap,
          )
          const mergedCandidates = mergeCandidateLists(
            ranked.map((candidate) => candidate.item),
            entry.card.candidates,
          )
          const finalRanked = rankCandidatesForUpload(
            mergedCandidates,
            ocrQuery || entry.card.query,
            analysis,
            colorMap,
          )
          const mergedBase =
            finalRanked.length > 0
              ? finalRanked.map((candidate) => candidate.item)
              : mergedCandidates
          const aiDecision =
            !error && analysis && mergedBase.length > 1
              ? await chooseBestCatalogCandidateAi(
                  entry.file,
                  analysis,
                  mergedBase,
                  colorMap,
                ).catch(() => null)
              : null
          const merged = reorderCandidatesByDecision(mergedBase, aiDecision ?? undefined)

          return {
            entry,
            ocrQuery,
            analysis,
            merged,
            finalRanked,
            colorHint,
            aiDecision,
            error,
          }
        },
      )

      for (const result of results) {
        if (!result) continue
        const {
          entry,
          ocrQuery,
          analysis,
          merged,
          finalRanked,
          colorHint,
          aiDecision,
          error,
        } = result

        if (isAiQuotaError(error)) {
          quotaErrorHit = true
        }

        const aiMatchNote = buildAiMatchNote({
          aiAnalysis: analysis ?? undefined,
          aiDecision: aiDecision ?? undefined,
          colorHint,
          aiError: error,
        })

        if (
          merged[0] &&
          ((aiDecision?.selectedContentId === merged[0].contentId &&
            aiDecision.confidence === 'high') ||
            shouldAutoSelectCandidate(
              finalRanked,
              ocrQuery || entry.card.query,
              analysis,
            ))
        ) {
          patchById.set(entry.card.id, {
            ocrQuery,
            aiAnalysis: analysis ?? undefined,
            aiDecision: aiDecision ?? undefined,
            aiError: error,
            aiMatchNote,
            colorHint,
            candidates: merged,
            status: 'auto-added',
            selectedTitle: merged[0].title,
            selectedContentId: merged[0].contentId,
          })
          autoFromOcr.push({
            uploadId: entry.card.id,
            item: merged[0],
            previewUrl: entry.card.previewUrl,
            analysis,
          })
        } else if (merged.length > 1) {
          patchById.set(entry.card.id, {
            ocrQuery,
            aiAnalysis: analysis ?? undefined,
            aiDecision: aiDecision ?? undefined,
            aiError: error,
            aiMatchNote,
            colorHint,
            candidates: merged,
            status: 'needs-choice',
          })
        } else {
          patchById.set(entry.card.id, {
            ocrQuery,
            aiAnalysis: analysis ?? undefined,
            aiDecision: aiDecision ?? undefined,
            aiError: error,
            aiMatchNote,
            colorHint,
            candidates: [],
            status: 'not-found',
          })
        }
      }

      if (patchById.size > 0) {
        setUploadMatches((prev) =>
          prev.map((card) => {
            if (card.status === 'chosen') return card
            const patch = patchById.get(card.id)
            return patch ? { ...card, ...patch } : card
          }),
        )
        setManualSearchDrafts((prev) => {
          const next = { ...prev }
          for (const [id, patch] of patchById.entries()) {
            if (patch.ocrQuery?.trim()) {
              next[id] = patch.ocrQuery
            }
          }
          return next
        })
      }

      if (autoFromOcr.length > 0) {
        setLoadingLivePrices(true)
        try {
          const rowsFromOcr = await mapWithConcurrency(
            autoFromOcr,
            MEDIA_UPLOAD_CONCURRENCY,
            async ({ uploadId, item, previewUrl, analysis }) =>
              buildRowForUploadSelection(uploadId, item, previewUrl, analysis),
          )
          setRows((prev) => [...prev, ...rowsFromOcr])
        } finally {
          setLoadingLivePrices(false)
        }
      }

      setAiReadProgress(null)
      return { processed: aiEntries.length, quotaErrorHit }
    },
    [analyzeUploadImage, buildRowForUploadSelection],
  )

  const continueQueuedAiAnalysis = useCallback(async () => {
    const queuedCards = uploadMatches.filter(
      (card) =>
        card.status !== 'chosen' &&
        card.status !== 'auto-added' &&
        !card.aiAnalysis &&
        !card.aiError &&
        !card.ocrQuery,
    )
    if (processingUploads || queuedCards.length === 0) return

    setProcessingUploads(true)
    try {
      const [sourceItems, colorMap] = await Promise.all([
        feedItems.length > 0 ? Promise.resolve(feedItems) : loadFeedItems(),
        loadProductColorMap(),
      ])
      if (sourceItems.length === 0) return

      const aiEntries = queuedCards
        .slice(0, AI_FILES_PER_PASS)
        .flatMap((card) => {
          const file = uploadFileByIdRef.current[card.id]
          return file ? [{ file, card }] : []
        })

      const missingCount = Math.min(AI_FILES_PER_PASS, queuedCards.length) - aiEntries.length
      const { processed, quotaErrorHit } = await processAiEntries(aiEntries, sourceItems, colorMap)

      const nextPendingCount = Math.max(0, queuedCards.length - processed - missingCount)
      const noticeParts: string[] = []
      if (processed > 0) {
        noticeParts.push(`AI bu keçiddə ${processed} şəkli analiz etdi.`)
      }
      if (nextPendingCount > 0) {
        noticeParts.push(`${nextPendingCount} şəkil AI növbəsində qalır.`)
      }
      if (missingCount > 0) {
        noticeParts.push(`${missingCount} şəkilin lokal faylı tapılmadı.`)
      }
      if (quotaErrorHit) {
        noticeParts.push(
          'Gemini kvotası bitdiyi üçün AI bu keçiddə dayandı. Sonra yenidən davam etdirə bilərsən.',
        )
      }
      setUploadNotice(noticeParts.length > 0 ? noticeParts.join(' ') : null)
    } finally {
      setAiReadProgress(null)
      setProcessingUploads(false)
    }
  }, [
    feedItems,
    loadFeedItems,
    loadProductColorMap,
    uploadMatches,
    processAiEntries,
    processingUploads,
  ])

  const handleBatchImageUpload = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const incomingFiles = [...(event.target.files ?? [])]
      event.target.value = ''
      if (incomingFiles.length === 0) return

      const files = incomingFiles.slice(0, MAX_UPLOAD_FILES_PER_BATCH)
      const noticeParts: string[] = []
      if (incomingFiles.length > MAX_UPLOAD_FILES_PER_BATCH) {
        noticeParts.push(
          `Bir dəfədə maksimum ${MAX_UPLOAD_FILES_PER_BATCH} şəkil işlənir. Qalanları növbəti batch-da yükləyin.`,
        )
      }
      if (files.length > UPLOAD_PROCESS_CHUNK_SIZE) {
        noticeParts.push(
          `${files.length} şəkil hissə-hissə emal olunur ki səhifə donmasın.`,
        )
      }
      setUploadNotice(noticeParts.length > 0 ? noticeParts.join(' ') : null)
      setAiReadProgress(null)

      setProcessingUploads(true)
      try {
        const [sourceItems, colorMap] = await Promise.all([
          feedItems.length > 0 ? Promise.resolve(feedItems) : loadFeedItems(),
          loadProductColorMap(),
        ])
        if (sourceItems.length === 0) return

        const fileChunks = chunkList(files, UPLOAD_PROCESS_CHUNK_SIZE)
        const initialAiEntries: UploadAiEntry[] = []

        for (const [chunkIndex, fileChunk] of fileChunks.entries()) {
          const entries = fileChunk.map((file, index) => {
            const query = queryFromFileName(file.name)
            const colorHint = buildColorHint(query)
            const candidates = rankCandidatesByColorHint(
              findCandidatesByQuery(sourceItems, query),
              colorHint,
              colorMap,
            )
            const previewUrl = URL.createObjectURL(file)
            previewUrlsRef.current.push(previewUrl)
            const uploadId = `${Date.now()}-${chunkIndex}-${index}-${file.name}`
            uploadFileByIdRef.current[uploadId] = file

            const cardBase = {
              id: uploadId,
              fileName: file.name,
              query,
              colorHint,
              previewUrl,
              uploadedMediaUrl: getCachedUploadedUrl(uploadId),
            }

            if (candidates.length === 1 && isConfidentAutoMatch(candidates[0], query)) {
              return {
                file,
                card: {
                  ...cardBase,
                  status: 'needs-choice' as const,
                  candidates,
                },
              }
            }

            if (candidates.length > 0) {
              return {
                file,
                card: {
                  ...cardBase,
                  status: 'needs-choice' as const,
                  candidates,
                },
              }
            }

            return {
              file,
              card: {
                ...cardBase,
                status: 'not-found' as const,
                candidates: [],
              },
            }
          })

          const cards: UploadMatchCard[] = entries.map((entry) => entry.card)
          const roomLeft = Math.max(0, AI_FILES_PER_PASS - initialAiEntries.length)
          if (roomLeft > 0) {
            initialAiEntries.push(...entries.slice(0, roomLeft))
          }

          setUploadMatches((prev) => [
            ...prev,
            ...cards.map((card) => ({
              ...card,
              uploadedMediaUrl: getCachedUploadedUrl(card.id) ?? card.uploadedMediaUrl,
            })),
          ])
          setManualSearchDrafts((prev) => {
            const next = { ...prev }
            for (const card of cards) {
              next[card.id] = card.query
            }
            return next
          })

          if (chunkIndex < fileChunks.length - 1) {
            await waitForNextPaint()
          }
        }

        let quotaErrorHit = false
        if (initialAiEntries.length > 0) {
          const result = await processAiEntries(initialAiEntries, sourceItems, colorMap)
          quotaErrorHit = result.quotaErrorHit
        }

        if (files.length > AI_FILES_PER_PASS) {
          noticeParts.push(
            `AI bu dəfə yalnız ilk ${Math.min(files.length, AI_FILES_PER_PASS)} şəkli analiz etdi. Qalan ${Math.max(0, files.length - AI_FILES_PER_PASS)} şəkil növbədə saxlanıldı.`,
          )
        }
        if (quotaErrorHit) {
          noticeParts.push(
            'Gemini kvotası bitdiyi üçün AI bu keçiddə dayandı. Qalan şəkillər növbədə qaldı.',
          )
        }
        setUploadNotice(noticeParts.length > 0 ? noticeParts.join(' ') : null)
      } finally {
        setAiReadProgress(null)
        setProcessingUploads(false)
      }
    },
    [
      feedItems,
      getCachedUploadedUrl,
      loadFeedItems,
      loadProductColorMap,
      processAiEntries,
    ],
  )

  const clearUploadMatches = useCallback(() => {
    const usedPreviewUrls = new Set(
      rows.map((row) => row._localPreviewUrl).filter((url): url is string => Boolean(url)),
    )
    const keep: string[] = []
    for (const url of previewUrlsRef.current) {
      if (usedPreviewUrls.has(url)) {
        keep.push(url)
      } else {
        URL.revokeObjectURL(url)
      }
    }
    previewUrlsRef.current = keep
    for (const card of uploadMatches) {
      delete uploadFileByIdRef.current[card.id]
      delete uploadPublicPromiseByIdRef.current[card.id]
      delete uploadPublicUrlByIdRef.current[card.id]
      delete uploadDrivePromiseByIdRef.current[card.id]
      delete uploadDriveUrlByIdRef.current[card.id]
    }
    setUploadMatches([])
    setManualSearchDrafts({})
    setExpandedCandidates({})
    setUploadNotice(null)
    setAiReadProgress(null)
  }, [rows, uploadMatches])

  const addEmptyRow = useCallback(() => {
    setRows((prev) => [...prev, withRowMeta(EMPTY_ROW())])
  }, [])

  const removeRow = useCallback((index: number) => {
    const rowKey = rows[index] ? getRowLabKey(rows[index], index) : ''
    setRows((prev) => prev.filter((_, i) => i !== index))
    setMediaDrafts((prev) => {
      const next = { ...prev }
      delete next[index]
      return next
    })
    if (rowKey) {
      setMediaLabEntries((prev) => {
        const next = { ...prev }
        delete next[rowKey]
        return next
      })
    }
  }, [rows])

  const updateCell = useCallback(
    (rowIndex: number, key: keyof CatalogRow, value: string) => {
      setRows((prev) =>
        prev.map((row, i) => (i === rowIndex ? { ...row, [key]: value } : row)),
      )
      if (key === 'imagesAndVideos') {
        setTableError(null)
      }
    },
    [],
  )

  const updateMediaDraft = useCallback((rowIndex: number, value: string) => {
    setMediaDrafts((prev) => ({ ...prev, [rowIndex]: value }))
  }, [])

  const appendMediaUrl = useCallback((rowIndex: number) => {
    const draft = (mediaDrafts[rowIndex] ?? '').trim()
    if (!draft) return

    setRows((prev) =>
      prev.map((row, i) =>
        i === rowIndex
          ? { ...row, imagesAndVideos: appendUrl(row.imagesAndVideos, draft) }
          : row,
      ),
    )

    setMediaDrafts((prev) => ({ ...prev, [rowIndex]: '' }))
    setTableError(null)
  }, [mediaDrafts])

  const syncCatalogMediaToTable = useCallback(() => {
    setTableError(null)
    const applied = applyCatalogMediaProviderToRows(catalogMediaProvider)
    if (applied === 0) {
      setTableError(
        catalogMediaProvider === 'drive'
          ? 'Drive linki hazir olan row tapilmadi. Evvelce Drive upload et.'
          : 'Hemiseki sistem ucun avtomatik sekil tapilmadi.',
      )
      return
    }
  }, [applyCatalogMediaProviderToRows, catalogMediaProvider])

  const updateMediaLabEntry = useCallback(
    (rowKey: string, field: keyof MediaLabEntry, value: string) => {
      setMediaLabEntries((prev) => ({
        ...prev,
        [rowKey]: {
          ...prev[rowKey],
          driveUrl: prev[rowKey]?.driveUrl ?? '',
          gcsUrl: prev[rowKey]?.gcsUrl ?? '',
          [field]: value,
        },
      }))
      setMediaLabError(null)
      setMediaLabNotice(null)
    },
    [],
  )

  const markMediaLabResult = useCallback((mode: MediaLabMode, result: 'works' | 'fails') => {
    setMediaLabResults((prev) => ({ ...prev, [mode]: result }))
    setMediaLabNotice(
      result === 'works'
        ? `${MEDIA_LAB_MODES.find((entry) => entry.id === mode)?.label ?? mode} isleyir kimi isaretlendi.`
        : `${MEDIA_LAB_MODES.find((entry) => entry.id === mode)?.label ?? mode} hele ugursuz gorunur.`,
    )
    setMediaLabError(null)
  }, [])

  const connectGoogleDrive = useCallback(async () => {
    if (!GOOGLE_DRIVE_CLIENT_ID) {
      setDriveStatus(
        'Google Drive client id yoxdur. `.env.local` daxilinde `VITE_GOOGLE_DRIVE_CLIENT_ID` olmalidir.',
      )
      setMediaLabError(
        'Google Drive client id tapilmadi. Local env yenilenmelidir.',
      )
      return
    }

    setDriveBusy(true)
    setDriveStatus(null)
    setMediaLabError(null)
    try {
      await ensureDriveSession(GOOGLE_DRIVE_CLIENT_ID, true)
      setDriveConnected(true)
      setDriveStatus(
        'Google Drive baglandi. Indi secilmis local sekilleri birbasa Drive-a yukleyib test ede bilerik.',
      )
    } catch (error) {
      setDriveConnected(Boolean(getDriveSessionState()))
      const message =
        error instanceof Error ? error.message : 'Google Drive auth alinmadi.'
      setDriveStatus(message)
      setMediaLabError(
        `${message} OAuth client-de Authorized JavaScript origins hissesine http://localhost:3007 elave edin.`,
      )
    } finally {
      setDriveBusy(false)
    }
  }, [])

  const disconnectGoogleDrive = useCallback(() => {
    revokeDriveSession()
    setDriveConnected(false)
    setDriveStatus('Google Drive baglantisi sifirlandi.')
  }, [])

  const uploadDriveFiles = useCallback(
    async (items: Array<{ rowKey: string; file: File }>, source: 'bulk' | 'single') => {
      if (!GOOGLE_DRIVE_CLIENT_ID) {
        setMediaLabError('Google Drive client id tapilmadi.')
        return
      }

      if (items.length === 0) {
        setMediaLabError(
          source === 'bulk'
            ? 'Drive-a yuklemek ucun yeni local sekil tapilmadi. Page refresh olunubsa sekilleri yeniden secmek lazimdir.'
            : 'Yuklemek ucun sekil secilmedi.',
        )
        setDriveStatus(null)
        return
      }

      setDriveBusy(true)
      setDriveStatus(null)
      setMediaLabError(null)
      setMediaLabNotice(null)

      setMediaLabEntries((prev) => {
        const next = { ...prev }
        for (const item of items) {
          next[item.rowKey] = {
            ...next[item.rowKey],
            driveUrl: next[item.rowKey]?.driveUrl ?? '',
            gcsUrl: next[item.rowKey]?.gcsUrl ?? '',
            driveState: 'uploading',
            driveMessage: 'Google Drive-a yuklenir...',
            selectedLocalFileName: item.file.name,
          }
        }
        return next
      })

      try {
        const session = await ensureDriveSession(GOOGLE_DRIVE_CLIENT_ID)
        setDriveConnected(true)

        const results = await mapWithConcurrency(items, 2, async (item) => {
          try {
            const uploaded = await uploadImageToGoogleDrive(item.file, session.accessToken)
            return { ...item, uploaded }
          } catch (error) {
            return {
              ...item,
              error:
                error instanceof Error ? error.message : 'Google Drive upload alinmadi.',
            }
          }
        })

        let okCount = 0
        let failCount = 0
        const successByRowKey = new Map<string, DriveUploadResult>()

        setMediaLabEntries((prev) => {
          const next = { ...prev }
          for (const result of results) {
            if ('uploaded' in result) {
              okCount += 1
              successByRowKey.set(result.rowKey, result.uploaded)
              next[result.rowKey] = {
                ...next[result.rowKey],
                driveUrl: result.uploaded.publicUrl,
                driveViewUrl: result.uploaded.webViewLink,
                driveFileId: result.uploaded.fileId,
                gcsUrl: next[result.rowKey]?.gcsUrl ?? '',
                driveState: 'ready',
                driveMessage: 'Drive link hazirdir.',
                selectedLocalFileName: result.file.name,
              }
            } else {
              failCount += 1
              next[result.rowKey] = {
                ...next[result.rowKey],
                driveUrl: next[result.rowKey]?.driveUrl ?? '',
                gcsUrl: next[result.rowKey]?.gcsUrl ?? '',
                driveState: 'error',
                driveMessage: result.error,
                selectedLocalFileName: result.file.name,
              }
            }
          }
          return next
        })

        if (successByRowKey.size > 0) {
          setRows((prev) =>
            prev.map((row, index) => {
              const rowKey = getRowLabKey(row, index)
              const uploaded = successByRowKey.get(rowKey)
              if (!uploaded) return row

              const nextRow: CatalogRow = {
                ...row,
                _driveMediaUrl: uploaded.publicUrl,
              }

              if (catalogMediaProvider !== 'drive') {
                return nextRow
              }

              return {
                ...nextRow,
                imagesAndVideos: buildMediaWithCatalogProvider(
                  nextRow,
                  rowKey,
                  'drive',
                  mediaLabEntries,
                  { driveUrl: uploaded.publicUrl },
                ),
              }
            }),
          )
        }

        setDriveStatus(
          `${okCount} sekil Google Drive-a yuklendi${failCount > 0 ? `, ${failCount} xeta var` : ''}.`,
        )
        if (okCount > 0) {
          setMediaLabNotice(
            `${okCount} row ucun Drive public linki hazirdir. Indi "Test CSV export et" ile ayri feed yoxlaya bilersen.`,
          )
        }
        if (failCount > 0) {
          setMediaLabError('Bazi sekiller Drive-a yuklenmedi. Setirlerde xeta mesajina bax.')
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Google Drive upload baslamadi.'
        setDriveStatus(message)
        setMediaLabError(message)
      } finally {
        setDriveBusy(false)
      }
    },
    [catalogMediaProvider, mediaLabEntries],
  )

  const uploadRowsToGoogleDrive = useCallback(async () => {
    const candidates = rows
      .map((row, index) => {
        const rowKey = getRowLabKey(row, index)
        const uploadId = row._sourceUploadId?.trim() ?? ''
        const file = uploadId ? uploadFileByIdRef.current[uploadId] : undefined
        const existingUrl = mediaLabEntries[rowKey]?.driveUrl?.trim() ?? ''
        return { rowKey, file, existingUrl }
      })
      .filter((entry): entry is { rowKey: string; file: File; existingUrl: string } =>
        Boolean(entry.file && !entry.existingUrl),
      )
      .map((entry) => ({ rowKey: entry.rowKey, file: entry.file }))

    await uploadDriveFiles(candidates, 'bulk')
  }, [mediaLabEntries, rows, uploadDriveFiles])

  const uploadSingleRowToGoogleDrive = useCallback(
    async (rowKey: string, file: File | null) => {
      if (!file) return
      await uploadDriveFiles([{ rowKey, file }], 'single')
    },
    [uploadDriveFiles],
  )

  const resolveCatalogMediaForExport = useCallback(
    (row: CatalogRow, index: number) => {
      const rowKey = getRowLabKey(row, index)
      return buildMediaForCatalogExport(
        row,
        rowKey,
        catalogMediaProvider,
        mediaLabEntries,
      )
    },
    [catalogMediaProvider, mediaLabEntries],
  )

  const ensureRowMediaForExport = useCallback(
    async (row: CatalogRow, index: number): Promise<CatalogRow> => {
      const rowKey = getRowLabKey(row, index)
      const media = parseMediaEntries(
        buildMediaForCatalogExport(row, rowKey, catalogMediaProvider, mediaLabEntries),
      )
      const hasRemoteImage = media.some(
        (value) => !VIDEO_EXT.test(value) && isPublicHttpUrl(value),
      )
      if (hasRemoteImage) return row

      const uploadId = row._sourceUploadId?.trim() ?? ''
      if (!uploadId) return row

      let uploadedUrl: string | null = null
      if (catalogMediaProvider === 'drive') {
        uploadedUrl = await uploadDriveMediaForUploadId(uploadId, rowKey)
        if (!uploadedUrl) {
          uploadedUrl = await uploadLocalMediaForUploadId(uploadId)
        }
      } else {
        uploadedUrl = await uploadLocalMediaForUploadId(uploadId)
        if (!uploadedUrl && GOOGLE_DRIVE_CLIENT_ID) {
          uploadedUrl = await uploadDriveMediaForUploadId(uploadId, rowKey)
        }
      }

      if (!uploadedUrl) return row

      const nextRow: CatalogRow = {
        ...row,
        _currentMediaUrl: uploadedUrl,
        _driveMediaUrl: uploadedUrl,
      }

      return {
        ...nextRow,
        imagesAndVideos: buildMediaWithCatalogProvider(
          nextRow,
          rowKey,
          catalogMediaProvider,
          mediaLabEntries,
          {
            currentUrl: uploadedUrl,
            driveUrl: uploadedUrl,
          },
        ),
      }
    },
    [
      catalogMediaProvider,
      mediaLabEntries,
      uploadDriveMediaForUploadId,
      uploadLocalMediaForUploadId,
    ],
  )

  const ensureRowsReadyForExport = useCallback(async (): Promise<CatalogRow[]> => {
    const candidates = rows
      .map((row, index) => ({ row, index }))
      .filter(({ row, index }) => {
        const rowKey = getRowLabKey(row, index)
        const media = parseMediaEntries(
          buildMediaForCatalogExport(row, rowKey, catalogMediaProvider, mediaLabEntries),
        )
        const hasRemoteImage = media.some(
          (value) => !VIDEO_EXT.test(value) && isPublicHttpUrl(value),
        )
        return !hasRemoteImage && Boolean(row._sourceUploadId?.trim())
      })

    if (candidates.length === 0) return rows

    setPreparingExport(true)
    try {
      const prepared = [...rows]
      const updates = await mapWithConcurrency(
        candidates,
        MEDIA_UPLOAD_CONCURRENCY,
        async ({ row, index }) => ({
          index,
          row: await ensureRowMediaForExport(row, index),
        }),
      )

      for (const update of updates) {
        prepared[update.index] = update.row
      }

      setRows(prepared)
      return prepared
    } finally {
      setPreparingExport(false)
    }
  }, [catalogMediaProvider, ensureRowMediaForExport, mediaLabEntries, rows])

  const catalogExportStatus = useMemo(
    () =>
      rows.reduce(
        (status, row, index) => {
          const media = parseMediaEntries(resolveCatalogMediaForExport(row, index))
          const hasRemoteImage = media.some(
            (value) => !VIDEO_EXT.test(value) && isPublicHttpUrl(value),
          )
          if (hasRemoteImage) {
            status.ready += 1
          } else if (row._sourceUploadId?.trim()) {
            status.deferred += 1
          } else {
            status.blocked += 1
          }
          return status
        },
        { ready: 0, deferred: 0, blocked: 0 },
      ),
    [resolveCatalogMediaForExport, rows],
  )

  const catalogExportReadyCount = catalogExportStatus.ready
  const catalogExportDeferredCount = catalogExportStatus.deferred
  const catalogExportBlockedCount = catalogExportStatus.blocked
  const exportPrimaryLabel = useMemo(() => {
    if (preparingExport) return 'CSV hazırlanır...'
    if (
      catalogMediaProvider === 'drive' &&
      catalogExportDeferredCount > 0 &&
      !driveConnected
    ) {
      return 'Google Drive-a bağlan və CSV-ni hazırla'
    }
    if (catalogExportDeferredCount > 0) {
      return 'CSV-ni hazırla və şəkilləri tamamla'
    }
    return 'CSV-ni hazırla və endir'
  }, [catalogExportDeferredCount, catalogMediaProvider, driveConnected, preparingExport])

  const exportCsv = useCallback(async () => {
    if (rows.length === 0) return
    setTableError(null)
    setTableNotice(null)
    try {
      if (catalogExportDeferredCount > 0) {
        setTableNotice(
          catalogMediaProvider === 'drive'
            ? 'Çatışmayan şəkillər Google Drive üzərindən hazırlanır. İlk dəfə icazə pəncərəsi açıla bilər.'
            : 'Çatışmayan şəkillər hazırlanır. Export bir az sonra hazır olacaq.',
        )
      }

      const preparedRows =
        catalogExportDeferredCount > 0 ? await ensureRowsReadyForExport() : rows

      const csv = rowsToMetaCommerceCsv(preparedRows, {
        resolveMedia: resolveCatalogMediaForExport,
        useFallbackImage: false,
      })
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
      downloadTextFile(`meta-catalog-${stamp}.csv`, csv, 'text/csv;charset=utf-8')
      setTableNotice('Meta CSV fayli yukleme ucun hazirlandi.')
    } catch (error) {
      setTableError(error instanceof Error ? error.message : 'CSV export xetasi')
    }
  }, [
    catalogExportDeferredCount,
    catalogMediaProvider,
    ensureRowsReadyForExport,
    resolveCatalogMediaForExport,
    rows,
  ])

  const exportMediaLabCsv = useCallback(() => {
    if (rows.length === 0) return
    setMediaLabError(null)
    setMediaLabNotice(null)

    try {
      let csv = ''
      let suffix: string = mediaLabMode

      if (mediaLabMode === 'current') {
        csv = rowsToMetaCommerceCsv(rows)
      } else {
        const testRows = rows.filter((row, index) => {
          const rowKey = getRowLabKey(row, index)
          return isPublicHttpUrl(getMediaLabUrl(mediaLabMode, mediaLabEntries[rowKey]))
        })

        if (testRows.length === 0) {
          throw new Error(
            'Bu test modu ucun en azi 1 setirde public URL daxil edin. Bos test CSV menali olmayacaq.',
          )
        }

        csv = rowsToMetaCommerceCsv(testRows, {
          resolveMedia: (row, index) => {
            const rowKey = getRowLabKey(row, index)
            return getMediaLabUrl(mediaLabMode, mediaLabEntries[rowKey])
          },
          useFallbackImage: false,
        })
        suffix = `${mediaLabMode}-test`
      }

      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
      downloadTextFile(`meta-catalog-${suffix}-${stamp}.csv`, csv, 'text/csv;charset=utf-8')
      setMediaLabNotice(
        mediaLabMode === 'current'
          ? 'Hazirki axin ucun baseline test CSV cixarildi.'
          : `${mediaLabReadyCounts[mediaLabMode]} setirlik test feed cixarildi. Meta-da bunu ayri yoxlaya bilersen.`,
      )
    } catch (error) {
      setMediaLabError(error instanceof Error ? error.message : 'Media test CSV xetasi')
    }
  }, [mediaLabEntries, mediaLabMode, mediaLabReadyCounts, rows])

  const applyMediaLabModeToRows = useCallback(() => {
    if (mediaLabMode === 'current') {
      setMediaLabError('Hazirki axin onsuz da esas cedvelde aktivdir.')
      setMediaLabNotice(null)
      return
    }

    let applied = 0
    const nextRows = rows.map((row, index) => {
      const rowKey = getRowLabKey(row, index)
      const nextImage = getMediaLabUrl(mediaLabMode, mediaLabEntries[rowKey])
      if (!isPublicHttpUrl(nextImage)) return row

      applied += 1
      return {
        ...row,
        imagesAndVideos: buildMediaWithPrimaryImage(nextImage, row.imagesAndVideos),
      }
    })

    if (applied === 0) {
      setMediaLabError('Kocurmek ucun duzgun public URL tapilmadi.')
      setMediaLabNotice(null)
      return
    }

    setRows(nextRows)
    setMediaLabError(null)
    setMediaLabNotice(
      `${applied} setirde ${MEDIA_LAB_MODES.find((entry) => entry.id === mediaLabMode)?.label ?? mediaLabMode} esas sekil kimi tetbiq olundu.`,
    )
  }, [mediaLabEntries, mediaLabMode, rows])

  const refreshAllRowLivePrices = useCallback(async () => {
    if (rows.length === 0) return

    setLoadingLivePrices(true)
    try {
      clearLivePriceCache()
      const refreshed = await Promise.all(
        rows.map(async (row) => {
          if (!row.contentId?.trim()) return row
          const pseudoItem: ParsedItem = {
            contentId: row.contentId,
            title: row.title,
            description: row.description,
            websiteLink: row.websiteLink,
            price: row.price,
            imageLink: '',
            brand: row.brand,
            availability: row.availability,
            condition: row.condition,
            fbProductCategory: row.fbProductCategory,
          }
          const fromLive = await buildRowWithLivePricing(pseudoItem)
          return {
            ...row,
            price: fromLive.price,
            salePrice: fromLive.salePrice,
          }
        }),
      )
      setRows(refreshed)
    } finally {
      setLoadingLivePrices(false)
    }
  }, [buildRowWithLivePricing, rows])

  const reviewUploadCards = useMemo(
    () => uploadMatches.filter((card) => card.status === 'needs-choice'),
    [uploadMatches],
  )

  const unmatchedUploadCards = useMemo(
    () => uploadMatches.filter((card) => card.status === 'not-found'),
    [uploadMatches],
  )

  const selectedUploadCards = useMemo(
    () =>
      uploadMatches.filter(
        (card) => card.status === 'auto-added' || card.status === 'chosen',
      ),
    [uploadMatches],
  )

  const pendingAiCards = useMemo(
    () =>
      uploadMatches.filter(
        (card) =>
          card.status !== 'chosen' &&
          card.status !== 'auto-added' &&
          !card.aiAnalysis &&
          !card.aiError &&
          !card.ocrQuery,
      ),
    [uploadMatches],
  )

  const activeReviewSearch = deferredReviewSearchQuery.trim()

  const filteredReviewUploadCards = useMemo(
    () =>
      reviewUploadCards.filter((card) => matchesUploadCardSearch(card, activeReviewSearch)),
    [activeReviewSearch, reviewUploadCards],
  )

  const filteredUnmatchedUploadCards = useMemo(
    () =>
      unmatchedUploadCards.filter((card) => matchesUploadCardSearch(card, activeReviewSearch)),
    [activeReviewSearch, unmatchedUploadCards],
  )

  const reviewVisibleCount =
    filteredReviewUploadCards.length + filteredUnmatchedUploadCards.length

  const assistantBusyLabel = useMemo(() => {
    if (loadingFeed) return 'Məhsul məlumatları hazırlanır.'
    if (processingUploads) return 'Şəkillər tanınır və uyğun məhsullar axtarılır.'
    if (preparingExport) return 'Export üçün çatışmayan şəkillər hazırlanır.'
    if (loadingLivePrices) return 'Qiymətlər və məhsul kartları yekunlaşdırılır.'
    if (driveBusy) return 'Şəkillər Google Drive üzərindən hazırlanır.'
    return null
  }, [driveBusy, loadingFeed, loadingLivePrices, preparingExport, processingUploads])

  const activeAssistantGoal = useMemo(
    () => ASSISTANT_GOALS.find((goal) => goal.id === assistantGoal) ?? null,
    [assistantGoal],
  )

  const exportDisabled =
    rows.length === 0 ||
    loadingFeed ||
    processingUploads ||
    loadingLivePrices ||
    preparingExport ||
    catalogExportBlockedCount > 0

  const showSelectionStep = selectedUploadCards.length > 0
  const showResolveStep = reviewUploadCards.length > 0 || unmatchedUploadCards.length > 0
  const showExportStep =
    uploadMatches.length > 0 || rows.length > 0 || Boolean(tableNotice) || Boolean(tableError)

  const assistantGoalText =
    activeAssistantGoal?.assistantReply ?? 'Birini seç, kartlar növbə ilə açılacaq.'

  const pickAssistantGoal = useCallback(
    (goal: AssistantGoal) => {
      setAssistantGoal(goal)
      setTableError(null)
      setTableNotice(null)
      if (feedItems.length === 0 && !loadingFeed) {
        void loadFeed()
      }
    },
    [feedItems.length, loadFeed, loadingFeed],
  )

  const resetAssistantGoal = useCallback(() => {
    setAssistantGoal(null)
    setTableError(null)
    setTableNotice(null)
  }, [])

  const openGuidedUploadPicker = useCallback(() => {
    guidedUploadInputRef.current?.click()
  }, [])

  return (
    <div className="app-shell">
      <div className="shape shape-a" />
      <div className="shape shape-b" />

      <div className="assistant-app">
        <div className="workspace-app">
          <header className="workspace-hero card">
            <div className="workspace-hero-copy">
              <p className="workspace-kicker">AI Catalog Studio</p>
              <h1>Upload et, AI yoxlasın, Meta row hazır olsun.</h1>
              <p className="workspace-lead">
                Bu panel birbaşa iş üçündür: feed statusu, şəkil upload-u, AI qərarı,
                review növbəsi və export eyni səthdə görünür.
              </p>

              <div className="workspace-goal-row">
                {ASSISTANT_GOALS.map((goal) => {
                  const GoalIcon = goal.icon
                  return (
                    <button
                      key={goal.id}
                      type="button"
                      className={`workspace-goal-btn ${assistantGoal === goal.id ? 'active' : ''}`}
                      onClick={() => pickAssistantGoal(goal.id)}
                    >
                      <GoalIcon size={16} />
                      <span>{goal.label}</span>
                      <ArrowRight size={15} />
                    </button>
                  )
                })}
                {assistantGoal && (
                  <button
                    type="button"
                    className="workspace-goal-reset"
                    onClick={resetAssistantGoal}
                  >
                    Rejimi sıfırla
                  </button>
                )}
              </div>

              <div className="workspace-hero-note">
                <strong>{activeAssistantGoal?.prompt ?? 'Hazırkı məqsəd seçilməyib.'}</strong>
                <span>{assistantGoalText}</span>
              </div>
            </div>

            <div className="workspace-hero-aside">
              <div className="workspace-stat-grid">
                <article className="workspace-stat-card">
                  <span>Feed məhsulu</span>
                  <strong>{feedItems.length}</strong>
                  <small>{feedItems.length > 0 ? 'Baza hazırdır' : 'Baza hələ yüklənməyib'}</small>
                </article>
                <article className="workspace-stat-card">
                  <span>Hazır row</span>
                  <strong>{rows.length}</strong>
                  <small>Meta cədvəlində aktiv sətirlər</small>
                </article>
                <article className="workspace-stat-card">
                  <span>AI analiz</span>
                  <strong>{aiInsightStats.analyzed}</strong>
                  <small>{aiInsightStats.highConfidence} yüksək etibarlı kart</small>
                </article>
                <article className="workspace-stat-card">
                  <span>Review növbəsi</span>
                  <strong>{reviewUploadCards.length + unmatchedUploadCards.length}</strong>
                  <small>{uploadStats.chosen + uploadStats.autoAdded} kart artıq həll olunub</small>
                </article>
              </div>

              <div className="workspace-engine-card">
                <p className="workspace-kicker subtle">AI mühərriki</p>
                <h2>{configuredAiPrimaryLabel}</h2>
                <p>
                  Prioritet model budur. Sistem əvvəl şəkli dərin analiz edir, sonra
                  top feed namizədləri arasında ayrıca AI qərarı verir.
                </p>
                <div className="workspace-engine-pills">
                  <span>{aiInsightStats.decided} AI qərarı</span>
                  <span>{aiInsightStats.metaDrafts} Meta draft</span>
                  <span>{catalogMediaProvider === 'drive' ? 'Drive export' : 'Public URL export'}</span>
                </div>
              </div>
            </div>
          </header>

          {assistantBusyLabel && (
            <section className="workspace-busy card">
              <div className="workspace-busy-pulse" aria-hidden="true">
                <span />
                <span />
                <span />
              </div>
              <div>
                <p className="workspace-kicker subtle">Arxa plan işi</p>
                <h2>{assistantBusyLabel}</h2>
                <p>
                  Şəkil analizi, namizəd seçimi, qiymət yenilənməsi və export üçün
                  media hazırlığı arxada davam edir.
                </p>
              </div>
            </section>
          )}

          <section className="workspace-grid">
            <article className="workspace-card card">
              <div className="workspace-card-head">
                <div>
                  <p className="workspace-kicker subtle">01. Baza</p>
                  <h2>Feed və rəng xəritəsini hazırla</h2>
                </div>
              </div>
              <p className="workspace-card-copy">
                Uyğunlaşdırma keyfiyyəti feed və rəng datasından asılıdır. Bu addımda
                məhsullar və rəng ipucları lokala çəkilir.
              </p>
              <div className="workspace-actions">
                <button type="button" onClick={() => void loadFeed()} disabled={loadingFeed}>
                  {loadingFeed
                    ? 'Baza hazırlanır...'
                    : feedItems.length > 0
                      ? 'Bazanı yenilə'
                      : 'Bazanı yüklə'}
                </button>
                <span className="workspace-inline-note">
                  {feedItems.length > 0
                    ? `${feedItems.length} məhsul və rəng ipucu hazırdır.`
                    : 'İlk dəfə yükledikdən sonra AI matching daha dəqiq işləyəcək.'}
                </span>
              </div>
              {feedError && <p className="error">{feedError}</p>}
            </article>

            <article className="workspace-card card">
              <div className="workspace-card-head">
                <div>
                  <p className="workspace-kicker subtle">02. Batch upload</p>
                  <h2>Şəkilləri yüklə və AI pipeline-i işə sal</h2>
                </div>
              </div>
              <p className="workspace-card-copy">
                Bütün şəkillər dərhal qəbul olunur, AI isə onları hissə-hissə analiz edir.
                Fayl adı sadəcə yardımçı siqnaldır; yekun uyğunlaşdırma vizual analiz və
                namizəd qərarı ilə verilir.
              </p>
              <div className="workspace-actions">
                <input
                  ref={guidedUploadInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  onChange={handleBatchImageUpload}
                  className="assistant-hidden-input"
                />
                <button
                  type="button"
                  className="primary"
                  onClick={openGuidedUploadPicker}
                  disabled={loadingFeed || processingUploads}
                >
                  {processingUploads ? 'AI pipeline işləyir...' : 'Şəkilləri seç'}
                </button>
                <button
                  type="button"
                  onClick={clearUploadMatches}
                  disabled={uploadMatches.length === 0}
                >
                  Siyahını təmizlə
                </button>
                <button
                  type="button"
                  onClick={bulkSelectTopCandidates}
                  disabled={uploadStats.needsChoice === 0 || loadingLivePrices}
                >
                  Top seçimi tətbiq et
                </button>
                <button
                  type="button"
                  onClick={() => void continueQueuedAiAnalysis()}
                  disabled={processingUploads || pendingAiCards.length === 0}
                >
                  {processingUploads
                    ? 'AI batch işləyir...'
                    : `AI davam et (${Math.min(pendingAiCards.length, AI_FILES_PER_PASS)})`}
                </button>
              </div>
              <div className="workspace-upload-stats">
                <span className="stat-pill ok">Auto: {uploadStats.autoAdded}</span>
                <span className="stat-pill info">Review: {uploadStats.needsChoice}</span>
                <span className="stat-pill done">Seçilib: {uploadStats.chosen}</span>
                <span className="stat-pill warn">Tapılmayıb: {uploadStats.notFound}</span>
                <span className="stat-pill">AI növbə: {pendingAiCards.length}</span>
              </div>
              {uploadNotice && <p className="hint warning">{uploadNotice}</p>}
              {aiReadProgress && aiReadProgress.total > 0 && (
                <p className="workspace-inline-note">
                  AI pipeline: {aiReadProgress.done}/{aiReadProgress.total}
                </p>
              )}
            </article>

            <article className="workspace-card card">
              <div className="workspace-card-head">
                <div>
                  <p className="workspace-kicker subtle">03. Manual axtarış</p>
                  <h2>Feed içində əl ilə məhsul tap</h2>
                </div>
              </div>
              <div className="workspace-search-row">
                <input
                  type="search"
                  placeholder="Məs: iPhone 16 Pro 256GB Black"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
                <span className="workspace-inline-note">
                  {searchQuery.trim() ? `${matches.length} uyğun nəticə` : 'Sorğu yaz'}
                </span>
              </div>
              {matches.length > 0 && (
                <div className="workspace-match-list">
                  {matches.slice(0, 5).map((item) => (
                    <article key={`${item.contentId}-${item.title}`} className="workspace-match-item">
                      <strong>{item.title}</strong>
                      <span>{item.price}</span>
                    </article>
                  ))}
                </div>
              )}
              <div className="workspace-actions">
                <button
                  type="button"
                  onClick={addMatchesToTable}
                  disabled={matches.length === 0 || loadingLivePrices}
                >
                  {loadingLivePrices
                    ? 'Qiymətlər yenilənir...'
                    : `Tapılanları cədvələ əlavə et (${matches.length})`}
                </button>
              </div>
            </article>

            <article className="workspace-card card">
              <div className="workspace-card-head">
                <div>
                  <p className="workspace-kicker subtle">04. AI nəticəsi</p>
                  <h2>AI bu batch-də nə etdi</h2>
                </div>
              </div>
              <div className="workspace-feature-list">
                <div>
                  <strong>Detallı vizual profil</strong>
                  <span>Brend, seriya, model, storage, rəng, görünən mətn və paket ipucu çıxarılır.</span>
                </div>
                <div>
                  <strong>AI namizəd qərarı</strong>
                  <span>Top feed namizədləri arasında ayrıca qərar verilir və ən uyğun SKU önə keçirilir.</span>
                </div>
                <div>
                  <strong>Meta draft</strong>
                  <span>Uyğun olan kartlarda Meta üçün title/description draft-ları yaradılır.</span>
                </div>
              </div>
            </article>
          </section>

          {showSelectionStep && (
            <section className="workspace-board card">
              <div className="workspace-board-head">
                <div>
                  <p className="workspace-kicker subtle">Hazır seçilənlər</p>
                  <h2>AI və ya sənin təsdiqinlə seçilmiş məhsullar</h2>
                </div>
                <span>{selectedUploadCards.length} kart hazırdır</span>
              </div>
              <p className="workspace-board-copy">
                Bu hissədə limit yoxdur. Seçilmiş kartların hamısı aşağıdakı listdə görünür.
              </p>

              <div className="workspace-selected-list">
                <div className="workspace-selected-grid">
                  {selectedUploadCards.map((card) => {
                    const selectedColor = card.selectedContentId
                      ? productColorById[card.selectedContentId]
                      : ''

                    return (
                      <article className="workspace-selected-card" key={card.id}>
                        <img src={card.previewUrl} alt={card.fileName} />
                        <div>
                          <strong>{card.selectedTitle ?? card.fileName}</strong>
                          <p>{card.aiMatchNote ?? buildAiMatchNote(card)}</p>
                          {(selectedColor || card.colorHint) && (
                            <div className="workspace-chip-row">
                              {selectedColor && (
                                <span className="workspace-chip">Rəng: {selectedColor}</span>
                              )}
                              {!selectedColor && card.colorHint && (
                                <span className="workspace-chip ghost">İpucu: {card.colorHint}</span>
                              )}
                            </div>
                          )}
                          {buildAiMetaPreview(card.aiAnalysis) && (
                            <small>{buildAiMetaPreview(card.aiAnalysis)}</small>
                          )}
                          <button
                            type="button"
                            className="mini-btn"
                            onClick={() => resetUploadSelection(card.id)}
                          >
                            Seçimi dəyiş
                          </button>
                        </div>
                      </article>
                    )
                  })}
                </div>
              </div>
            </section>
          )}

          {showResolveStep && (
            <section className="workspace-board workspace-review-board card">
              <div className="workspace-board-head">
                <div>
                  <p className="workspace-kicker subtle">AI review board</p>
                  <h2>Şübhəli kartları sürətli şəkildə həll et</h2>
                </div>
                <span>
                  {activeReviewSearch
                    ? `${reviewVisibleCount}/${reviewUploadCards.length + unmatchedUploadCards.length} kart görünür`
                    : `${reviewUploadCards.length + unmatchedUploadCards.length} kart gözləyir`}
                </span>
              </div>
              <p className="workspace-board-copy">
                Sol tərəfdə AI-nin namizəd tapdığı kartlar, sağ tərəfdə isə feed-də
                etibarlı SKU tapılmayanlar var. Hər sütunda bütün kartlar görünür; artıq
                süni limit yoxdur.
              </p>
              <div className="workspace-review-toolbar">
                <label className="workspace-review-search">
                  <span>Batch içində axtar</span>
                  <input
                    type="search"
                    placeholder="Fayl adı, model, brend, rəng və ya SKU yaz"
                    value={reviewSearchQuery}
                    onChange={(e) => setReviewSearchQuery(e.target.value)}
                  />
                </label>
                <div className="workspace-review-summary">
                  <span>{filteredReviewUploadCards.length} namizədli</span>
                  <span>{filteredUnmatchedUploadCards.length} tapılmayan</span>
                  <span>Limit yoxdur</span>
                  {reviewSearchQuery.trim() && (
                    <button
                      type="button"
                      className="mini-btn"
                      onClick={() => setReviewSearchQuery('')}
                    >
                      Filtri sil
                    </button>
                  )}
                </div>
              </div>

              <div className="workspace-review-grid">
                <div className="workspace-review-column">
                  <div className="workspace-column-head">
                    <strong>Namizəd tapılanlar</strong>
                    <span>
                      {activeReviewSearch
                        ? `${filteredReviewUploadCards.length}/${reviewUploadCards.length}`
                        : reviewUploadCards.length}
                    </span>
                  </div>

                  <div className="workspace-review-list">
                    {filteredReviewUploadCards.length === 0 && (
                      <p className="workspace-inline-note">
                        {activeReviewSearch
                          ? 'Bu filter ilə review kartı tapılmadı.'
                          : 'Hazırda review gözləyən AI namizədi yoxdur.'}
                      </p>
                    )}

                    {filteredReviewUploadCards.map((card) => (
                      <article className="vision-card" key={card.id}>
                        <div className="vision-card-media">
                          <img src={card.previewUrl} alt={card.fileName} />
                          <span className="vision-badge">
                            {card.aiDecision?.selectedContentId
                              ? `AI pick • ${describeConfidence(card.aiDecision.confidence)}`
                              : 'Review lazımdır'}
                          </span>
                        </div>
                        <div className="vision-card-body">
                          <div className="vision-card-head">
                            <strong>{card.fileName}</strong>
                            <span>{card.aiMatchNote ?? buildAiMatchNote(card)}</span>
                          </div>

                          <div className="workspace-chip-row">
                            {buildAiAnalysisChips(card.aiAnalysis).slice(0, 3).map((chip) => (
                              <span key={chip} className="workspace-chip">
                                {chip}
                              </span>
                            ))}
                            {card.colorHint && (
                              <span className="workspace-chip ghost">İpucu: {card.colorHint}</span>
                            )}
                          </div>

                          {card.aiAnalysis?.matchSignals.length ? (
                            <div className="vision-signals">
                              {card.aiAnalysis.matchSignals.slice(0, 2).map((signal) => (
                                <span key={signal}>{signal}</span>
                              ))}
                            </div>
                          ) : null}

                          {buildAiMetaPreview(card.aiAnalysis) && (
                            <div className="vision-meta-draft">
                              {card.aiAnalysis?.metaTitle && (
                                <strong>{card.aiAnalysis.metaTitle}</strong>
                              )}
                              <p>{buildAiMetaPreview(card.aiAnalysis)}</p>
                            </div>
                          )}

                          {card.candidates.length > 3 && (
                            <div className="workspace-inline-actions">
                              <button
                                type="button"
                                className="mini-btn"
                                onClick={() => toggleCandidateExpand(card.id)}
                              >
                                {expandedCandidates[card.id]
                                  ? 'Yığ'
                                  : `Daha çox (${card.candidates.length - 3})`}
                              </button>
                            </div>
                          )}

                          <div className="vision-candidate-list">
                            {(expandedCandidates[card.id]
                              ? card.candidates
                              : card.candidates.slice(0, 3)
                            ).map((candidate) => {
                              const color = productColorById[candidate.contentId]
                              const aiPicked =
                                card.aiDecision?.selectedContentId === candidate.contentId
                              return (
                                <button
                                  type="button"
                                  key={candidate.contentId}
                                  className={`vision-candidate-btn ${aiPicked ? 'is-ai-picked' : ''}`}
                                  onClick={() =>
                                    void selectUploadCandidate(card.id, candidate, card.previewUrl)
                                  }
                                  disabled={loadingLivePrices}
                                >
                                  <strong>{candidate.title}</strong>
                                  <span>
                                    {candidate.price}
                                    {candidate.brand ? ` • ${candidate.brand}` : ''}
                                    {color ? ` • Rəng: ${color}` : ''}
                                  </span>
                                  {aiPicked && <small>AI bunu önə çəkib</small>}
                                </button>
                              )
                            })}
                          </div>

                          <div className="workspace-manual-search">
                            <input
                              type="search"
                              value={manualSearchDrafts[card.id] ?? ''}
                              placeholder="Əl ilə məhsul adını yaz"
                              onChange={(e) => updateUploadSearchDraft(card.id, e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  e.preventDefault()
                                  void searchUploadCardByDraft(card.id)
                                }
                              }}
                            />
                            <button
                              type="button"
                              onClick={() => void searchUploadCardByDraft(card.id)}
                              disabled={loadingFeed}
                            >
                              Axtar
                            </button>
                          </div>
                        </div>
                      </article>
                    ))}
                  </div>
                </div>

                <div className="workspace-review-column">
                  <div className="workspace-column-head">
                    <strong>Feed-də tapılmayanlar</strong>
                    <span>
                      {activeReviewSearch
                        ? `${filteredUnmatchedUploadCards.length}/${unmatchedUploadCards.length}`
                        : unmatchedUploadCards.length}
                    </span>
                  </div>

                  <div className="workspace-review-list">
                    {filteredUnmatchedUploadCards.length === 0 && (
                      <p className="workspace-inline-note">
                        {activeReviewSearch
                          ? 'Bu filter ilə tapılmayan kart çıxmadı.'
                          : 'Hazırda ayrıca həll tələb edən tapılmayan kart yoxdur.'}
                      </p>
                    )}

                    {filteredUnmatchedUploadCards.map((card) => (
                      <article className="vision-card unmatched" key={card.id}>
                        <div className="vision-card-media">
                          <img src={card.previewUrl} alt={card.fileName} />
                          <span className="vision-badge muted">Etibarlı SKU tapılmadı</span>
                        </div>
                        <div className="vision-card-body">
                          <div className="vision-card-head">
                            <strong>{card.fileName}</strong>
                            <span>{card.aiMatchNote ?? buildAiMatchNote(card)}</span>
                          </div>

                          <div className="workspace-chip-row">
                            {buildAiAnalysisChips(card.aiAnalysis).slice(0, 3).map((chip) => (
                              <span key={chip} className="workspace-chip">
                                {chip}
                              </span>
                            ))}
                          </div>

                          {buildAiMetaPreview(card.aiAnalysis) && (
                            <div className="vision-meta-draft">
                              {card.aiAnalysis?.metaTitle && (
                                <strong>{card.aiAnalysis.metaTitle}</strong>
                              )}
                              <p>{buildAiMetaPreview(card.aiAnalysis)}</p>
                            </div>
                          )}

                          <div className="workspace-manual-search">
                            <input
                              type="search"
                              value={manualSearchDrafts[card.id] ?? ''}
                              placeholder="Əl ilə məhsul adı yaz və axtar"
                              onChange={(e) => updateUploadSearchDraft(card.id, e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  e.preventDefault()
                                  void searchUploadCardByDraft(card.id)
                                }
                              }}
                            />
                            <button
                              type="button"
                              onClick={() => void searchUploadCardByDraft(card.id)}
                              disabled={loadingFeed}
                            >
                              Axtar
                            </button>
                          </div>
                        </div>
                      </article>
                    ))}
                  </div>
                </div>
              </div>
            </section>
          )}

          {showExportStep && (
            <section className="workspace-board card">
              <div className="workspace-board-head">
                <div>
                  <p className="workspace-kicker subtle">Export mərkəzi</p>
                  <h2>Meta üçün yekun CSV-ni hazırla</h2>
                </div>
                <span>{catalogMediaProvider === 'drive' ? 'Drive əsaslı export' : 'Public URL export'}</span>
              </div>

              <div className="workspace-export-grid">
                <div className="workspace-export-metric">
                  <strong>{rows.length}</strong>
                  <span>hazır row</span>
                </div>
                <div className="workspace-export-metric">
                  <strong>{catalogExportReadyCount}</strong>
                  <span>tam hazır</span>
                </div>
                <div className="workspace-export-metric">
                  <strong>{catalogExportDeferredCount}</strong>
                  <span>export zamanı tamamlanacaq</span>
                </div>
                <div className="workspace-export-metric">
                  <strong>{catalogExportBlockedCount}</strong>
                  <span>əl ilə düzəliş istəyir</span>
                </div>
              </div>

              <div className="workspace-actions">
                <button
                  type="button"
                  className="primary"
                  onClick={exportCsv}
                  disabled={exportDisabled}
                >
                  {exportPrimaryLabel}
                </button>
                <button
                  type="button"
                  onClick={refreshAllRowLivePrices}
                  disabled={rows.length === 0 || loadingLivePrices}
                >
                  Qiymətləri yenilə
                </button>
              </div>

              <div ref={tableStatusRef} className="workspace-status-panel" aria-live="polite">
                {tableNotice && <p className="ok">{tableNotice}</p>}
                {tableError && <p className="error">{tableError}</p>}
                {!tableError && !tableNotice && (
                  <p className="workspace-inline-note">
                    {rows.length === 0
                      ? 'Hələ export üçün məhsul yoxdur.'
                      : catalogExportBlockedCount > 0
                        ? 'Bəzi sətirlərdə public image yoxdur. Əvvəlcə onları düzəltmək lazımdır.'
                        : catalogExportDeferredCount > 0 &&
                            catalogMediaProvider === 'drive' &&
                            !driveConnected
                          ? 'İlk klikdə Google icazəsi soruşula bilər, sonra şəkillər tamamlanacaq.'
                          : catalogExportDeferredCount > 0
                            ? `${catalogExportDeferredCount} sətirdə media export zamanı tamamlanacaq.`
                            : 'Hər şey hazırdır. CSV-ni indi endirə bilərsən.'}
                  </p>
                )}
              </div>
            </section>
          )}

          <section className="workspace-board card">
            <div className="workspace-board-head">
              <div>
                <p className="workspace-kicker subtle">Kataloq cədvəli</p>
                <h2>Meta row-larını son dəfə yoxla</h2>
              </div>
              <span>{rows.length} sətir</span>
            </div>

            <div className="row-actions">
              <button type="button" onClick={addEmptyRow}>
                Boş sətir əlavə et
              </button>
              <button
                type="button"
                onClick={refreshAllRowLivePrices}
                disabled={rows.length === 0 || loadingLivePrices}
              >
                {loadingLivePrices ? 'Qiymətlər yenilənir...' : 'Qiymətləri yenilə'}
              </button>
              <button type="button" onClick={exportCsv} disabled={rows.length === 0} className="primary">
                Meta CSV yüklə
              </button>
            </div>

            <div className="media-provider-panel">
              <div className="media-provider-copy">
                <strong>Avtomatik əsas şəkil mənbəyi</strong>
                <p>
                  Yeni seçilən məhsullarda `Gorseller ve videolar` sahəsi bu mənbəyə
                  görə önə çəkilir.
                </p>
              </div>
              <div className="media-provider-switch">
                {CATALOG_MEDIA_PROVIDERS.map((provider) => (
                  <button
                    key={provider.id}
                    type="button"
                    className={`provider-chip ${
                      catalogMediaProvider === provider.id ? 'active' : ''
                    }`}
                    onClick={() => {
                      setCatalogMediaProvider(provider.id)
                      setTableError(null)
                    }}
                  >
                    <span>{provider.label}</span>
                    <small>{provider.description}</small>
                  </button>
                ))}
              </div>
              <div className="row-actions media-provider-actions">
                <button type="button" onClick={syncCatalogMediaToTable} disabled={rows.length === 0}>
                  Seçiləni `Gorseller ve videolar` sahəsinə uygula
                </button>
              </div>
            </div>

            <p className={`hint ${catalogExportReadyCount < rows.length ? 'warning' : ''}`}>
              Export hazırdır: <strong>{catalogExportReadyCount}</strong> row tam hazırdır,
              <strong> {catalogExportDeferredCount}</strong> row export zamanı tamamlanacaq,
              <strong> {catalogExportBlockedCount}</strong> row isə əl ilə düzəliş istəyir.
            </p>

            <div className="table-wrap">
              <table className="catalog-table">
                <thead>
                  <tr>
                    <th className="col-del">Sil</th>
                    {HEADERS.map((header) => (
                      <th key={header.key} className={header.wide ? 'col-wide' : ''}>
                        {header.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 ? (
                    <tr>
                      <td colSpan={HEADERS.length + 1} className="empty-cell">
                        Hələ sətir yoxdur. AI seçimi və ya manual axtarışla row əlavə et.
                      </td>
                    </tr>
                  ) : (
                    rows.map((row, rowIndex) => {
                      const media = normalizeMedia(row.imagesAndVideos)
                      const imageUrls = media.filter((value) => !VIDEO_EXT.test(value))
                      const videoUrls = media.filter((value) => VIDEO_EXT.test(value))
                      const localPreviewUrl = row._localPreviewUrl?.trim() ?? ''

                      return (
                        <tr key={row._rowId ?? `${row.contentId}-${rowIndex}`}>
                          <td className="col-del">
                            <button
                              type="button"
                              className="btn-icon"
                              onClick={() => removeRow(rowIndex)}
                              title="Sil"
                            >
                              x
                            </button>
                          </td>

                          {HEADERS.map((header) => (
                            <td key={header.key} className={header.wide ? 'col-wide' : ''}>
                              {header.key === 'imagesAndVideos' ? (
                                <div className="media-cell">
                                  <textarea
                                    value={row[header.key]}
                                    onChange={(e) =>
                                      updateCell(rowIndex, header.key, e.target.value)
                                    }
                                    rows={4}
                                    placeholder="Media URL-ləri buraya yaz"
                                  />

                                  <div className="media-tools">
                                    <input
                                      type="url"
                                      value={mediaDrafts[rowIndex] ?? ''}
                                      placeholder="Media URL əlavə et"
                                      onChange={(e) => updateMediaDraft(rowIndex, e.target.value)}
                                      onKeyDown={(e) => {
                                        if (e.key === 'Enter') {
                                          e.preventDefault()
                                          appendMediaUrl(rowIndex)
                                        }
                                      }}
                                    />
                                    <button
                                      type="button"
                                      className="mini-btn"
                                      onClick={() => appendMediaUrl(rowIndex)}
                                    >
                                      Əlavə et
                                    </button>
                                  </div>

                                  <div className="media-preview">
                                    {imageUrls.slice(0, 3).map((url) => (
                                      <a
                                        key={url}
                                        href={url}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="thumb-link"
                                        title={url}
                                      >
                                        <img src={url} alt="preview" loading="lazy" />
                                      </a>
                                    ))}
                                    {videoUrls.slice(0, 2).map((url) => (
                                      <a
                                        key={url}
                                        href={url}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="video-chip"
                                        title={url}
                                      >
                                        video
                                      </a>
                                    ))}
                                    {imageUrls.length === 0 && localPreviewUrl && (
                                      <>
                                        <span className="thumb-link" title="Local preview">
                                          <img src={localPreviewUrl} alt="local preview" loading="lazy" />
                                        </span>
                                        <span className="muted">Local preview</span>
                                      </>
                                    )}
                                    {media.length === 0 && !localPreviewUrl && (
                                      <span className="muted">Media yoxdur</span>
                                    )}
                                  </div>
                                </div>
                              ) : header.key === 'description' ? (
                                <textarea
                                  value={row[header.key]}
                                  onChange={(e) => updateCell(rowIndex, header.key, e.target.value)}
                                  rows={3}
                                />
                              ) : (
                                <input
                                  type="text"
                                  value={row[header.key]}
                                  onChange={(e) => updateCell(rowIndex, header.key, e.target.value)}
                                />
                              )}
                            </td>
                          ))}
                        </tr>
                      )
                    })
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <details className="workspace-advanced card">
            <summary>
              <div>
                <p className="workspace-kicker subtle">Advanced media lab</p>
                <strong>Alternativ media strategiyalarını test et</strong>
              </div>
              <span>{mediaLabReadyCounts[mediaLabMode]} row hazırdır</span>
            </summary>

            <div className="lab-mode-grid">
              {MEDIA_LAB_MODES.map((mode) => {
                const result = mediaLabResults[mode.id]
                return (
                  <button
                    type="button"
                    key={mode.id}
                    className={`lab-mode-card ${mediaLabMode === mode.id ? 'active' : ''}`}
                    onClick={() => {
                      setMediaLabMode(mode.id)
                      setMediaLabError(null)
                      setMediaLabNotice(null)
                    }}
                  >
                    <div>
                      <strong>{mode.label}</strong>
                      <p>{mode.description}</p>
                    </div>
                    <div className="lab-mode-meta">
                      <span>{mediaLabReadyCounts[mode.id]} setir hazır</span>
                      {result && (
                        <span className={`lab-result ${result}`}>
                          {result === 'works' ? 'İşlədi' : 'İşləmədi'}
                        </span>
                      )}
                    </div>
                  </button>
                )
              })}
            </div>

            <div className="row-actions lab-actions">
              <button type="button" onClick={exportMediaLabCsv} disabled={rows.length === 0}>
                Test CSV export et
              </button>
              <button
                type="button"
                onClick={applyMediaLabModeToRows}
                disabled={rows.length === 0 || mediaLabMode === 'current'}
              >
                İşləyən variantı əsas cədvələ köçür
              </button>
              <button type="button" className="ghost-success" onClick={() => markMediaLabResult(mediaLabMode, 'works')}>
                İşlədi kimi qeyd et
              </button>
              <button type="button" className="ghost-warn" onClick={() => markMediaLabResult(mediaLabMode, 'fails')}>
                İşləmədi kimi qeyd et
              </button>
              {mediaLabMode === 'google-drive' && (
                <>
                  <button type="button" onClick={() => void connectGoogleDrive()} disabled={driveBusy}>
                    {driveConnected ? 'Drive-i yenidən bağla' : 'Google Drive-a bağlan'}
                  </button>
                  <button
                    type="button"
                    onClick={() => void uploadRowsToGoogleDrive()}
                    disabled={driveBusy || rows.length === 0}
                  >
                    {driveBusy ? 'Drive upload...' : 'Local şəkilləri Drive-a yüklə'}
                  </button>
                  <button
                    type="button"
                    className="ghost-neutral"
                    onClick={disconnectGoogleDrive}
                    disabled={driveBusy || !driveConnected}
                  >
                    Drive bağlantısını sil
                  </button>
                </>
              )}
            </div>

            {mediaLabNotice && <p className="ok">{mediaLabNotice}</p>}
            {mediaLabError && <p className="error">{mediaLabError}</p>}
            {driveStatus && <p className="hint">{driveStatus}</p>}

            {rows.length === 0 ? (
              <div className="lab-empty">
                Əvvəlcə məhsulları cədvələ sal. Sonra burada alternativ image URL
                strategiyalarını ayrıca test edə bilərsən.
              </div>
            ) : mediaLabMode === 'current' ? (
              <div className="lab-baseline-grid">
                {rows.slice(0, 12).map((row, rowIndex) => {
                  const currentImage = getCurrentPrimaryImage(row)
                  const sourceLabel = normalizeMedia(row.imagesAndVideos).some(
                    (value) => !VIDEO_EXT.test(value) && isPublicHttpUrl(value),
                  )
                    ? 'Custom public URL'
                    : row._fallbackImageLink
                      ? 'Feed fallback'
                      : 'Şəkil yoxdur'

                  return (
                    <article
                      className="lab-baseline-card"
                      key={row._rowId ?? `${row.contentId}-${rowIndex}`}
                    >
                      <strong>{row.title || `Setir ${rowIndex + 1}`}</strong>
                      <span>{sourceLabel}</span>
                      {isPublicHttpUrl(currentImage) ? (
                        <a href={currentImage} target="_blank" rel="noreferrer">
                          Cari şəkli aç
                        </a>
                      ) : (
                        <span className="muted">Public image yoxdur</span>
                      )}
                    </article>
                  )
                })}
              </div>
            ) : (
              <div className="table-wrap lab-table-wrap">
                <table className="catalog-table lab-table">
                  <thead>
                    <tr>
                      <th>Məhsul</th>
                      <th>İndiki şəkil</th>
                      <th>{mediaLabMode === 'google-drive' ? 'Drive linki' : 'GCS public URL'}</th>
                      <th>Test URL preview</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, rowIndex) => {
                      const rowKey = getRowLabKey(row, rowIndex)
                      const entry = mediaLabEntries[rowKey]
                      const currentImage = getCurrentPrimaryImage(row)
                      const value =
                        mediaLabMode === 'google-drive' ? entry?.driveUrl ?? '' : entry?.gcsUrl ?? ''
                      const previewUrl = getMediaLabUrl(mediaLabMode, entry)

                      return (
                        <tr key={rowKey}>
                          <td>
                            <div className="lab-product-cell">
                              <strong>{row.title || `Setir ${rowIndex + 1}`}</strong>
                              <span>{row.contentId || 'Content ID yoxdur'}</span>
                            </div>
                          </td>
                          <td>
                            {isPublicHttpUrl(currentImage) ? (
                              <a href={currentImage} target="_blank" rel="noreferrer">
                                Cari şəkli aç
                              </a>
                            ) : (
                              <span className="muted">Public image yoxdur</span>
                            )}
                          </td>
                          <td>
                            <div className="lab-input-stack">
                              <input
                                type="text"
                                value={value}
                                placeholder={
                                  mediaLabMode === 'google-drive'
                                    ? 'Drive share linki və ya file id'
                                    : 'https://storage.googleapis.com/...'
                                }
                                onChange={(e) =>
                                  updateMediaLabEntry(
                                    rowKey,
                                    mediaLabMode === 'google-drive' ? 'driveUrl' : 'gcsUrl',
                                    e.target.value,
                                  )
                                }
                              />
                              {mediaLabMode === 'google-drive' && (
                                <label className="lab-file-picker">
                                  <input
                                    type="file"
                                    accept="image/*"
                                    onChange={(e) => {
                                      const file = e.target.files?.[0] ?? null
                                      void uploadSingleRowToGoogleDrive(rowKey, file)
                                      e.currentTarget.value = ''
                                    }}
                                  />
                                  <span>Bu row üçün şəkil seç və Drive-a yüklə</span>
                                </label>
                              )}
                            </div>
                          </td>
                          <td>
                            {isPublicHttpUrl(previewUrl) ? (
                              <div className="lab-preview-cell">
                                <a href={previewUrl} target="_blank" rel="noreferrer">
                                  Test URL aç
                                </a>
                                {mediaLabMode === 'google-drive' && entry?.driveViewUrl && (
                                  <a href={entry.driveViewUrl} target="_blank" rel="noreferrer">
                                    Drive faylını aç
                                  </a>
                                )}
                                <code>{previewUrl}</code>
                                {entry?.driveMessage && (
                                  <span
                                    className={`muted ${entry.driveState === 'error' ? 'warn-text' : ''}`}
                                  >
                                    {entry.driveMessage}
                                  </span>
                                )}
                              </div>
                            ) : (
                              <div className="lab-preview-cell">
                                <span className="muted">
                                  {value.trim() ? 'Düzgün public URL alınmadı' : 'Hələ daxil edilməyib'}
                                </span>
                                {entry?.driveMessage && <span className="muted">{entry.driveMessage}</span>}
                              </div>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </details>
        </div>
      </div>

      {/* Legacy console removed — Obsidian Studio redesign */}

    </div>
  )
}

export default App
