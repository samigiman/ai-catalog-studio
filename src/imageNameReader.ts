const GEMINI_ENDPOINT_BASE = '/proxy-gemini/models'
const OPENAI_RESPONSES_ENDPOINT = '/proxy-openai/v1/responses'
const DEFAULT_GEMINI_MODEL = 'gemini-3-flash-preview'
const DEFAULT_OPENAI_MODEL = 'gpt-4.1-mini'
const AI_REQUEST_TIMEOUT_MS = 12000
const PRODUCT_NAME_PROMPT =
  'Read clearly visible product name (brand + model). Append one color keyword if visible (for example black/white/blue). Return max 10 words, plain text only, no guessing, no explanation. If unclear return empty.'
const PRODUCT_ANALYSIS_PROMPT =
  'Analyze the main retail product in this image and return only minified JSON with keys search_query, brand, model, variant, storage, color, category, confidence. search_query must be short and useful for ecommerce catalog search. confidence must be one of high, medium, low. Use empty strings when unclear. No markdown.'
const DEFAULT_GEMINI_MODEL_PRIORITY = [
  'gemini-3-flash-preview',
  'gemini-3.1-pro-preview',
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.0-flash',
]

type EncodedImage = {
  dataUrl: string
  base64: string
  mimeType: string
}

export type ImageProductAnalysis = {
  rawText: string
  searchQuery: string
  brand: string
  model: string
  variant: string
  storage: string
  color: string
  category: string
  confidence: 'high' | 'medium' | 'low'
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
    // If we cannot read model catalog, avoid many failing calls; try only primary model.
    return [unique[0]]
  }

  const filtered = unique.filter((name) => available.has(name))
  return filtered.length > 0 ? filtered : [unique[0]]
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

async function resizeImage(file: File, maxSide = 1280): Promise<EncodedImage> {
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
        0.84,
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
    return record.output_text.filter((v) => typeof v === 'string').join(' ')
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

async function extractWithGemini(
  model: string,
  image: EncodedImage,
  prompt: string,
): Promise<string> {
  const generationConfig: Record<string, unknown> = {
    temperature: 0,
    maxOutputTokens: 40,
  }

  if (model.startsWith('gemini-3')) {
    // Gemini docs recommend high media resolution for image analysis quality.
    generationConfig.mediaResolution = 'media_resolution_high'
  }

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
              {
                text: prompt,
              },
              {
                inline_data: {
                  mime_type: image.mimeType,
                  data: image.base64,
                },
              },
            ],
          },
        ],
        generationConfig,
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
): Promise<string> {
  const response = await fetchWithTimeout(OPENAI_RESPONSES_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
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
              detail: 'low',
            },
          ],
        },
      ],
      max_output_tokens: 40,
      temperature: 0,
    }),
  })

  if (!response.ok) {
    throw new Error(`Vision API failed: ${response.status}`)
  }

  const payload = await response.json()
  return pickOutputText(payload).trim()
}

function extractJsonObject(raw: string): string {
  const match = raw.match(/\{[\s\S]*\}/)
  return match?.[0]?.trim() ?? ''
}

function cleanField(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
}

function normalizeConfidence(value: unknown): 'high' | 'medium' | 'low' {
  const normalized = cleanField(value).toLowerCase()
  if (normalized === 'high') return 'high'
  if (normalized === 'medium') return 'medium'
  return 'low'
}

function parseImageProductAnalysis(raw: string): ImageProductAnalysis | null {
  const jsonText = extractJsonObject(raw)
  if (!jsonText) return null

  try {
    const payload = JSON.parse(jsonText) as Record<string, unknown>
    const brand = cleanField(payload.brand)
    const model = cleanField(payload.model)
    const variant = cleanField(payload.variant)
    const storage = cleanField(payload.storage)
    const color = cleanField(payload.color)
    const category = cleanField(payload.category)
    const searchQuery =
      cleanField(payload.search_query) ||
      [brand, model, variant, storage, color].filter(Boolean).join(' ').trim()

    if (!searchQuery) return null

    return {
      rawText: raw.trim(),
      searchQuery,
      brand,
      model,
      variant,
      storage,
      color,
      category,
      confidence: normalizeConfidence(payload.confidence),
    }
  } catch {
    return null
  }
}

async function extractImageTextWithAi(image: EncodedImage, prompt: string): Promise<string> {
  const openAiModel =
    (import.meta.env.VITE_OPENAI_VISION_MODEL as string | undefined)?.trim() || ''

  const geminiCandidates = await buildGeminiCandidates()
  for (const model of geminiCandidates) {
    try {
      const gemini = await extractWithGemini(model, image, prompt)
      if (gemini) return gemini
    } catch {
      // Try next model candidate.
    }
  }

  if (openAiModel) {
    try {
      return await extractWithOpenAi(openAiModel || DEFAULT_OPENAI_MODEL, image, prompt)
    } catch {
      return ''
    }
  }

  return ''
}

export async function analyzeProductImageAi(file: File): Promise<ImageProductAnalysis | null> {
  const image = await resizeImage(file)
  const raw = await extractImageTextWithAi(image, PRODUCT_ANALYSIS_PROMPT)
  return parseImageProductAnalysis(raw)
}

export async function extractProductNameFromImageAi(file: File): Promise<string> {
  const structured = await analyzeProductImageAi(file)
  if (structured?.searchQuery) {
    return structured.searchQuery
  }

  const image = await resizeImage(file)
  return extractImageTextWithAi(image, PRODUCT_NAME_PROMPT)
}
