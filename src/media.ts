const URL_RE = /https?:\/\/[^\s,;]+/gi

function cleanToken(value: string): string {
  return value
    .trim()
    .replace(/^['"<[]+/, '')
    .replace(/[>'"\]]+$/, '')
}

export function parseMediaEntries(raw: string): string[] {
  const normalized = raw.replace(/\\n/g, '\n')
  const urls = normalized.match(URL_RE)

  if (urls && urls.length > 0) {
    return urls.map(cleanToken).filter(Boolean)
  }

  return normalized
    .split(/[\n,;]+/)
    .map(cleanToken)
    .filter(Boolean)
}

export function appendMediaEntries(current: string, rawInput: string): string {
  const existing = parseMediaEntries(current)
  const incoming = parseMediaEntries(rawInput)
  if (incoming.length === 0) return current

  const seen = new Set<string>()
  const merged: string[] = []

  for (const item of [...existing, ...incoming]) {
    const key = item.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(item)
  }

  return merged.join('\n')
}
