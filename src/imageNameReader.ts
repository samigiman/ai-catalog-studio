import type { ParsedItem } from './feedParser'

const GEMINI_ENDPOINT_BASE = '/proxy-gemini/models'
const OPENAI_RESPONSES_ENDPOINT = '/proxy-openai/v1/responses'
const DEFAULT_GEMINI_MODEL = 'gemini-3.1-pro-preview'
const DEFAULT_OPENAI_MODEL = 'gpt-5.4'
const AI_REQUEST_TIMEOUT_MS = 40000
const PRODUCT_ANALYSIS_PROMPT = `Return JSON only.
Analyze the main sellable retail product in this image for ecommerce cataloging.
Be conservative and do not guess hidden details.
Focus on the actual product, box text, storage/capacity, color/finish, bundle clues, and visible condition.
The search_query must be compact but useful for matching against a product feed.
The meta_title must be concise and marketplace-ready.
The meta_description must be 1-2 short Azerbaijani sentences for a Meta product catalog.
The match_signals array must contain short factual clues from the image, not chain-of-thought.`
const PRODUCT_ANALYSIS_FALLBACK_PROMPT = `Return JSON only.
Analyze only the main product in this ecommerce image.
Ignore price text, installment text, discount labels, campaign copy, and background clutter.
Prefer the product name visible on the device or retail box.
If something is not readable, return an empty string instead of guessing.`

function buildCatalogDecisionPrompt(
  analysis: ImageProductAnalysis | null,
  candidates: ParsedItem[],
  colorById: Record<string, string>,
): string {
  const summarizedCandidates = candidates.slice(0, 6).map((candidate) => ({
    content_id: candidate.contentId,
    title: candidate.title,
    brand: candidate.brand,
    color: colorById[candidate.contentId] ?? '',
    price: candidate.price,
    description: compactText(candidate.description, 220),
  }))

  return `Return JSON only.
Choose the single best matching catalog candidate for the product image.
If none of the candidates are reliable enough, return an empty selected_content_id.
Use visible product text, storage, color, bundle clues, and overall product type.
Do not choose based on price alone.

AI_IMAGE_SUMMARY:
${JSON.stringify(
    {
      search_query: analysis?.searchQuery ?? '',
      brand: analysis?.brand ?? '',
      series: analysis?.series ?? '',
      model: analysis?.model ?? '',
      variant: analysis?.variant ?? '',
      storage: analysis?.storage ?? '',
      color: analysis?.color ?? '',
      category: analysis?.category ?? '',
      visible_text: analysis?.visibleText ?? '',
      match_signals: analysis?.matchSignals ?? [],
    },
    null,
    2,
  )}

CATALOG_CANDIDATES:
${JSON.stringify(summarizedCandidates, null, 2)}`
}

const DEFAULT_GEMINI_MODEL_PRIORITY = [
  'gemini-3.1-pro-preview',
  'gemini-3-flash-preview',
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.0-flash',
]

const DEFAULT_OPENAI_MODEL_PRIORITY = [
  'gpt-5.4',
  'gpt-5.2',
  'gpt-5.1',
  'gpt-5-mini',
  'gpt-4.1',
]

type EncodedImage = {
  dataUrl: string
  base64: string
  mimeType: string
}

type Confidence = 'high' | 'medium' | 'low'

type JsonSchema = {
  type: 'object'
  additionalProperties: boolean
  properties: Record<string, unknown>
  required: string[]
}

export type ImageProductAnalysis = {
  engine: string
  rawText: string
  searchQuery: string
  productName: string
  brand: string
  series: string
  model: string
  variant: string
  storage: string
  color: string
  category: string
  condition: string
  packageState: string
  visibleText: string
  accessories: string
  confidence: Confidence
  matchSignals: string[]
  metaTitle: string
  metaDescription: string
  fbProductCategoryHint: string
}

export type CatalogCandidateDecision = {
  engine: string
  rawText: string
  selectedContentId: string
  confidence: Confidence
  reason: string
}

const ANALYSIS_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'search_query',
    'product_name',
    'brand',
    'series',
    'model',
    'variant',
    'storage',
    'color',
    'category',
    'condition',
    'package_state',
    'visible_text',
    'accessories',
    'confidence',
    'match_signals',
    'meta_title',
    'meta_description',
    'fb_product_category_hint',
  ],
  properties: {
    search_query: { type: 'string' },
    product_name: { type: 'string' },
    brand: { type: 'string' },
    series: { type: 'string' },
    model: { type: 'string' },
    variant: { type: 'string' },
    storage: { type: 'string' },
    color: { type: 'string' },
    category: { type: 'string' },
    condition: { type: 'string' },
    package_state: { type: 'string' },
    visible_text: { type: 'string' },
    accessories: { type: 'string' },
    confidence: {
      type: 'string',
      enum: ['high', 'medium', 'low'],
    },
    match_signals: {
      type: 'array',
      items: { type: 'string' },
    },
    meta_title: { type: 'string' },
    meta_description: { type: 'string' },
    fb_product_category_hint: { type: 'string' },
  },
}

const ANALYSIS_FALLBACK_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'search_query',
    'brand',
    'series',
    'model',
    'variant',
    'storage',
    'color',
    'category',
    'visible_text',
    'confidence',
  ],
  properties: {
    search_query: { type: 'string' },
    brand: { type: 'string' },
    series: { type: 'string' },
    model: { type: 'string' },
    variant: { type: 'string' },
    storage: { type: 'string' },
    color: { type: 'string' },
    category: { type: 'string' },
    visible_text: { type: 'string' },
    confidence: {
      type: 'string',
      enum: ['high', 'medium', 'low'],
    },
  },
}

const CATALOG_DECISION_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['selected_content_id', 'confidence', 'reason'],
  properties: {
    selected_content_id: { type: 'string' },
    confidence: {
      type: 'string',
      enum: ['high', 'medium', 'low'],
    },
    reason: { type: 'string' },
  },
}

let geminiModelCatalogPromise: Promise<Set<string> | null> | null = null

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs = AI_REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(input, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

function normalizeModelName(name: string): string {
  return name.replace(/^models\//, '').trim()
}

function parseModelList(raw: string | undefined): string[] {
  if (!raw) return []
  return raw
    .split(/[,\n;]/)
    .map((part) => normalizeModelName(part))
    .filter(Boolean)
}

async function getAvailableGeminiModels(): Promise<Set<string> | null> {
  if (geminiModelCatalogPromise) return geminiModelCatalogPromise

  geminiModelCatalogPromise = (async () => {
    try {
      const response = await fetchWithTimeout(`${GEMINI_ENDPOINT_BASE}`, {
        method: 'GET',
      })
      if (!response.ok) return null
      const payload = (await response.json()) as {
        models?: Array<{ name?: string }>
      }
      const set = new Set<string>()
      for (const model of payload.models ?? []) {
        const normalized = normalizeModelName(model.name ?? '')
        if (normalized) set.add(normalized)
      }
      return set.size > 0 ? set : null
    } catch {
      return null
    }
  })()

  return geminiModelCatalogPromise
}

async function buildGeminiCandidates(): Promise<string[]> {
  const envPrimary = parseModelList(import.meta.env.VITE_GEMINI_MODEL as string | undefined)
  const envFallback = parseModelList(import.meta.env.VITE_GEMINI_MODELS as string | undefined)
  const preferred = [
    ...envPrimary,
    ...envFallback,
    DEFAULT_GEMINI_MODEL,
    ...DEFAULT_GEMINI_MODEL_PRIORITY,
  ]
  const unique = [...new Set(preferred.map((name) => normalizeModelName(name)).filter(Boolean))]
  if (unique.length === 0) return [DEFAULT_GEMINI_MODEL]

  const available = await getAvailableGeminiModels()
  if (!available) {
    return [unique[0]]
  }

  const filtered = unique.filter((name) => available.has(name))
  return filtered.length > 0 ? filtered : [unique[0]]
}

function buildOpenAiCandidates(): string[] {
  const envPrimary = parseModelList(
    import.meta.env.VITE_OPENAI_VISION_MODEL as string | undefined,
  )
  const envFallback = parseModelList(
    import.meta.env.VITE_OPENAI_VISION_MODELS as string | undefined,
  )
  return [
    ...new Set(
      [...envPrimary, ...envFallback, DEFAULT_OPENAI_MODEL, ...DEFAULT_OPENAI_MODEL_PRIORITY]
        .map((name) => normalizeModelName(name))
        .filter(Boolean),
    ),
  ]
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('FileReader error'))
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result)
        return
      }
      reject(new Error('Unexpected FileReader result'))
    }
    reader.readAsDataURL(blob)
  })
}

function dataUrlToBase64(dataUrl: string): { base64: string; mimeType: string } {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/)
  if (!match) {
    throw new Error('Invalid data URL')
  }
  return {
    mimeType: match[1],
    base64: match[2],
  }
}

async function resizeImage(file: File, maxSide = 1440): Promise<EncodedImage> {
  const srcUrl = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image()
      image.onload = () => resolve(image)
      image.onerror = () => reject(new Error('Image decode failed'))
      image.src = srcUrl
    })

    const longSide = Math.max(img.width, img.height)
    const scale = longSide > maxSide ? maxSide / longSide : 1
    const width = Math.max(1, Math.round(img.width * scale))
    const height = Math.max(1, Math.round(img.height * scale))

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height

    const ctx = canvas.getContext('2d')
    if (!ctx) {
      const dataUrl = await blobToDataUrl(file)
      const { base64, mimeType } = dataUrlToBase64(dataUrl)
      return { dataUrl, base64, mimeType }
    }

    ctx.drawImage(img, 0, 0, width, height)
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (value) => {
          if (value) resolve(value)
          else reject(new Error('Canvas export failed'))
        },
        'image/jpeg',
        0.9,
      )
    })
    const dataUrl = await blobToDataUrl(blob)
    const { base64, mimeType } = dataUrlToBase64(dataUrl)
    return { dataUrl, base64, mimeType }
  } finally {
    URL.revokeObjectURL(srcUrl)
  }
}

function pickOutputText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const record = payload as Record<string, unknown>

  if (typeof record.output_text === 'string') {
    return record.output_text
  }

  if (Array.isArray(record.output_text)) {
    return record.output_text.filter((value) => typeof value === 'string').join(' ')
  }

  if (!Array.isArray(record.output)) {
    return ''
  }

  const out: string[] = []
  for (const item of record.output) {
    if (!item || typeof item !== 'object') continue
    const content = (item as { content?: unknown }).content
    if (!Array.isArray(content)) continue

    for (const part of content) {
      if (!part || typeof part !== 'object') continue
      const text =
        (part as { text?: unknown; output_text?: unknown }).text ??
        (part as { text?: unknown; output_text?: unknown }).output_text
      if (typeof text === 'string') {
        out.push(text)
      }
    }
  }

  return out.join(' ')
}

function extractJsonObject(raw: string): string {
  const match = raw.match(/\{[\s\S]*\}/)
  return match?.[0]?.trim() ?? ''
}

function cleanField(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
}

function cleanFieldArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const entry of value) {
    const cleaned = cleanField(entry)
    if (cleaned) out.push(cleaned)
  }
  return out.slice(0, 6)
}

function normalizeConfidence(value: unknown): Confidence {
  const normalized = cleanField(value).toLowerCase()
  if (normalized === 'high') return 'high'
  if (normalized === 'medium') return 'medium'
  return 'low'
}

function compactText(value: string, maxLength: number): string {
  const cleaned = value.replace(/\s+/g, ' ').trim()
  if (cleaned.length <= maxLength) return cleaned
  return `${cleaned.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`
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

function parseImageProductAnalysis(raw: string, engine: string): ImageProductAnalysis | null {
  const jsonText = extractJsonObject(raw)
  if (!jsonText) return null

  try {
    const payload = JSON.parse(jsonText) as Record<string, unknown>
    const brand = cleanField(payload.brand)
    const series = cleanField(payload.series)
    const model = cleanField(payload.model)
    const variant = cleanField(payload.variant)
    const storage = cleanField(payload.storage)
    const color = cleanField(payload.color)
    const category = cleanField(payload.category)
    const visibleText = cleanField(payload.visible_text)
    const productName =
      cleanField(payload.product_name) ||
      [brand, series, model, variant, storage, color].filter(Boolean).join(' ').trim()
    const searchQuery =
      cleanField(payload.search_query) ||
      [brand, series, model, variant, storage, color].filter(Boolean).join(' ').trim()

    if (!searchQuery) return null

    return {
      engine,
      rawText: raw.trim(),
      searchQuery,
      productName,
      brand,
      series,
      model,
      variant,
      storage,
      color,
      category,
      condition: cleanField(payload.condition),
      packageState: cleanField(payload.package_state),
      visibleText,
      accessories: cleanField(payload.accessories),
      confidence: normalizeConfidence(payload.confidence),
      matchSignals: uniqueStrings(cleanFieldArray(payload.match_signals)),
      metaTitle: compactText(cleanField(payload.meta_title), 150),
      metaDescription: compactText(cleanField(payload.meta_description), 280),
      fbProductCategoryHint: cleanField(payload.fb_product_category_hint),
    }
  } catch {
    return null
  }
}

function parseCatalogCandidateDecision(
  raw: string,
  engine: string,
): CatalogCandidateDecision | null {
  const jsonText = extractJsonObject(raw)
  if (!jsonText) return null

  try {
    const payload = JSON.parse(jsonText) as Record<string, unknown>
    return {
      engine,
      rawText: raw.trim(),
      selectedContentId: cleanField(payload.selected_content_id),
      confidence: normalizeConfidence(payload.confidence),
      reason: compactText(cleanField(payload.reason), 220),
    }
  } catch {
    return null
  }
}

function parseFallbackImageProductAnalysis(
  raw: string,
  engine: string,
): ImageProductAnalysis | null {
  const jsonText = extractJsonObject(raw)
  if (!jsonText) return null

  try {
    const payload = JSON.parse(jsonText) as Record<string, unknown>
    const brand = cleanField(payload.brand)
    const series = cleanField(payload.series)
    const model = cleanField(payload.model)
    const variant = cleanField(payload.variant)
    const storage = cleanField(payload.storage)
    const color = cleanField(payload.color)
    const category = cleanField(payload.category)
    const visibleText = cleanField(payload.visible_text)
    const searchQuery =
      cleanField(payload.search_query) ||
      [brand, series, model, variant, storage, color].filter(Boolean).join(' ').trim()

    if (!searchQuery) return null

    const productName = [brand, series, model, variant].filter(Boolean).join(' ').trim()

    return {
      engine,
      rawText: raw.trim(),
      searchQuery,
      productName: productName || searchQuery,
      brand,
      series,
      model,
      variant,
      storage,
      color,
      category,
      condition: '',
      packageState: '',
      visibleText,
      accessories: '',
      confidence: normalizeConfidence(payload.confidence),
      matchSignals: uniqueStrings([visibleText, category, color].filter(Boolean)),
      metaTitle: productName || searchQuery,
      metaDescription: '',
      fbProductCategoryHint: '',
    }
  } catch {
    return null
  }
}

async function extractWithGemini(
  model: string,
  image: EncodedImage,
  prompt: string,
  schema?: JsonSchema,
): Promise<string> {
  const response = await fetchWithTimeout(
    `${GEMINI_ENDPOINT_BASE}/${encodeURIComponent(model)}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              { text: prompt },
              {
                inline_data: {
                  mime_type: image.mimeType,
                  data: image.base64,
                },
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 900,
          responseMimeType: 'application/json',
          responseSchema: schema,
        },
      }),
    },
  )

  if (!response.ok) {
    throw new Error(`Gemini API failed: ${response.status}`)
  }

  const payload = (await response.json()) as {
    candidates?: Array<{
      content?: {
        parts?: Array<{ text?: string }>
      }
    }>
  }
  const parts = payload.candidates?.[0]?.content?.parts ?? []
  return parts.map((part) => part.text ?? '').join(' ').trim()
}

async function extractWithOpenAi(
  model: string,
  image: EncodedImage,
  prompt: string,
  schemaName: string,
  schema: JsonSchema,
): Promise<string> {
  const body: Record<string, unknown> = {
    model,
    input: [
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: prompt,
          },
          {
            type: 'input_image',
            image_url: image.dataUrl,
            detail: 'high',
          },
        ],
      },
    ],
    max_output_tokens: 900,
    text: {
      format: {
        type: 'json_schema',
        name: schemaName,
        strict: true,
        schema,
      },
    },
  }

  if (model.startsWith('gpt-5')) {
    body.reasoning = {
      effort: 'low',
    }
  }

  const response = await fetchWithTimeout(OPENAI_RESPONSES_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    throw new Error(`Vision API failed: ${response.status}`)
  }

  const payload = await response.json()
  return pickOutputText(payload).trim()
}

async function callImageJsonTask<T>(
  image: EncodedImage,
  prompt: string,
  schemaName: string,
  schema: JsonSchema,
  parser: (raw: string, engine: string) => T | null,
): Promise<T | null> {
  const openAiCandidates = buildOpenAiCandidates()
  const geminiCandidates = await buildGeminiCandidates()

  const orderedProviders: Array<{ provider: 'openai' | 'gemini'; model: string }> = [
    ...geminiCandidates.map((model) => ({ provider: 'gemini' as const, model })),
    ...openAiCandidates.map((model) => ({ provider: 'openai' as const, model })),
  ]

  for (const attempt of orderedProviders) {
    try {
      const raw =
        attempt.provider === 'openai'
          ? await extractWithOpenAi(attempt.model, image, prompt, schemaName, schema)
          : await extractWithGemini(attempt.model, image, prompt, schema)
      const parsed = parser(raw, attempt.model)
      if (parsed) return parsed
    } catch {
      // Try the next configured model/provider.
    }
  }

  return null
}

export async function analyzeProductImageAi(file: File): Promise<ImageProductAnalysis | null> {
  const image = await resizeImage(file)
  const primary = await callImageJsonTask(
    image,
    PRODUCT_ANALYSIS_PROMPT,
    'myshops_product_analysis',
    ANALYSIS_SCHEMA,
    parseImageProductAnalysis,
  )
  if (primary) return primary

  return callImageJsonTask(
    image,
    PRODUCT_ANALYSIS_FALLBACK_PROMPT,
    'myshops_product_analysis_fallback',
    ANALYSIS_FALLBACK_SCHEMA,
    parseFallbackImageProductAnalysis,
  )
}

export async function chooseBestCatalogCandidateAi(
  file: File,
  analysis: ImageProductAnalysis | null,
  candidates: ParsedItem[],
  colorById: Record<string, string>,
): Promise<CatalogCandidateDecision | null> {
  if (candidates.length === 0) return null
  const image = await resizeImage(file)
  return callImageJsonTask(
    image,
    buildCatalogDecisionPrompt(analysis, candidates, colorById),
    'myshops_catalog_decision',
    CATALOG_DECISION_SCHEMA,
    parseCatalogCandidateDecision,
  )
}

export async function extractProductNameFromImageAi(file: File): Promise<string> {
  const structured = await analyzeProductImageAi(file)
  return structured?.searchQuery ?? ''
}
