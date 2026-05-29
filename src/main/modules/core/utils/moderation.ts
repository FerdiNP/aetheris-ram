import { net } from 'electron'
import { safeRequest } from '@main/lib/request'

export type ModerationInfo = {
  moderated: true
  reason: string
  banExpiresAt?: string
}

const fallbackModerationInfo: ModerationInfo = {
  moderated: true,
  reason: 'User is moderated'
}

export const decodeHtml = (value: string): string =>
  value
    .replace(/\\u0026/g, '&')
    .replace(/\\u003c/gi, '<')
    .replace(/\\u003e/gi, '>')
    .replace(/\\"/g, '"')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()

/**
 * Strips HTML tags from the body so regexes can match text directly even if intermixed with HTML tags
 */
const stripHtmlTags = (value: string): string =>
  value
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const getJsonStringValue = (source: string, keys: string[]): string | undefined => {
  const decoded = decodeHtml(source)
  for (const key of keys) {
    const patterns = [
      new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`, 'i'),
      new RegExp(`&quot;${key}&quot;\\s*:\\s*&quot;([^&]+)&quot;`, 'i'),
      new RegExp(`${key}\\s*[=:]\\s*["']([^"']+)["']`, 'i')
    ]
    for (const pattern of patterns) {
      const match = decoded.match(pattern) || source.match(pattern)
      if (match?.[1]) return match[1]
    }
  }
  return undefined
}

/**
 * Robust date parser supporting MM/DD/YYYY, DD/MM/YYYY, ISO, and standard formats
 */
const parseDateSlashFormat = (str: string): Date | null => {
  const match = str.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?\b/i)
  if (!match) return null

  const part1 = Number(match[1]) // Month or Day
  const part2 = Number(match[2]) // Day or Month
  const year = Number(match[3])
  
  let hour = match[4] ? Number(match[4]) : 0
  const minute = match[5] ? Number(match[5]) : 0
  const second = match[6] ? Number(match[6]) : 0
  const ampm = match[7]?.toUpperCase()

  if (ampm) {
    if (ampm === 'PM' && hour < 12) hour += 12
    if (ampm === 'AM' && hour === 12) hour = 0
  }

  let monthIndex = 0
  let day = 1

  // Detect DD/MM/YYYY vs MM/DD/YYYY
  if (part1 > 12) {
    // 30/05/2026 -> part1 is Day, part2 is Month
    day = part1
    monthIndex = part2 - 1
  } else if (part2 > 12) {
    // 05/30/2026 -> part1 is Month, part2 is Day
    monthIndex = part1 - 1
    day = part2
  } else {
    // Ambiguous (e.g. 05/06/2026), default to MM/DD/YYYY (Roblox default US format)
    monthIndex = part1 - 1
    day = part2
  }

  if (monthIndex < 0 || monthIndex > 11 || day < 1 || day > 31) {
    return null
  }

  const isUtc = str.toUpperCase().includes('UTC') || str.toUpperCase().includes('GMT')
  if (isUtc) {
    return new Date(Date.UTC(year, monthIndex, day, hour, minute, second))
  } else {
    return new Date(year, monthIndex, day, hour, minute, second)
  }
}

const parseRobloxModerationDate = (value?: string): Date | null => {
  if (!value) return null
  const decoded = decodeHtml(value)
  
  // Try native date parsing first (e.g. ISO format)
  const direct = new Date(decoded)
  if (Number.isFinite(direct.getTime())) return direct

  // Try custom slash parser
  const slashParsed = parseDateSlashFormat(decoded)
  if (slashParsed) return slashParsed

  const datePatterns = [
    /\b([A-Z][a-z]{2,9}\s+\d{1,2},\s+\d{4}(?:\s+\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?)?(?:\s+(?:UTC|GMT))?)\b/i,
    /\b(\d{1,2}\/\d{1,2}\/\d{4}(?:\s+\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?)?(?:\s+(?:UTC|GMT))?)\b/i,
    /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)\b/i
  ]

  for (const pattern of datePatterns) {
    const match = decoded.match(pattern)
    if (!match?.[1]) continue
    
    const slash = parseDateSlashFormat(match[1])
    if (slash) return slash

    const parsed = new Date(match[1].replace(/\s+(UTC|GMT)$/i, ' UTC'))
    if (Number.isFinite(parsed.getTime())) return parsed
  }

  return null
}

/**
 * Parse ban duration from page text. Supports English and Indonesian.
 * E.g., "1 Day Ban", "3 Days", "7 Day Suspension", "1 Hari", "3 Hari".
 */
const getModerationDurationMs = (body: string): number | null => {
  const decoded = stripHtmlTags(decodeHtml(body))

  const durationPatterns = [
    /\b(?:suspension|blokir|penangguhan|ban)\s+(\d+)\s*(day|days|hari|hour|hours|jam|minute|minutes|menit)\b/i,
    /\b(\d+)\s*(day|days|hari|hour|hours|jam|minute|minutes|menit)\s*(?:ban|suspension|moderation|blokir|penangguhan)?\b/i,
    /\b(?:ban|suspension|moderation|blokir|penangguhan)\s*(?:duration|durasi)?:?\s*(\d+)\s*(day|days|hari|hour|hours|jam|minute|minutes|menit)\b/i,
    /\b(?:for|in|of|selama)\s+(\d+)\s*(day|days|hari|hour|hours|jam|minute|minutes|menit)\b/i,
    /\b(?:suspended|banned|ditangguhkan|diblokir)\s+(?:for\s+|selama\s+)?(\d+)\s*(day|days|hari|hour|hours|jam|minute|minutes|menit)\b/i
  ]

  for (const pattern of durationPatterns) {
    const match = decoded.match(pattern)
    if (!match) continue
    const amount = Number(match[1])
    const unit = match[2].toLowerCase()
    if (!Number.isFinite(amount)) continue
    
    if (unit.startsWith('day') || unit === 'hari') return amount * 24 * 60 * 60 * 1000
    if (unit.startsWith('hour') || unit === 'jam') return amount * 60 * 60 * 1000
    return amount * 60 * 1000
  }

  return null
}

export const getModerationReason = (body: string): string => {
  const decodedHtml = decodeHtml(body)
  const decodedText = stripHtmlTags(decodedHtml)
  
  const rawReason =
    getJsonStringValue(body, [
      'punishmentTypeDescription',
      'moderationReason',
      'reason',
      'internalReason',
      'displayReason'
    ]) ||
    decodedText.match(/\b(\d+\s*(?:Day|Hour|Minute|Hari|Jam|Menit)s?\s*(?:Ban|Suspension|Moderation|Blokir|Penangguhan))\b/i)?.[1] ||
    decodedText.match(/(?:reason|alasan|moderator note|catatan moderator)\s*:\s*([^.]{1,160})/i)?.[1]

  return rawReason ? decodeHtml(rawReason) : 'User is moderated'
}

export const getModerationExpiresAt = (body: string): string | undefined => {
  const decodedHtml = decodeHtml(body)
  const decodedText = stripHtmlTags(decodedHtml)
  
  const rawExpiresAt = getJsonStringValue(body, [
    'banExpiresAt',
    'bannedUntil',
    'endDate',
    'expiration',
    'expiresAt',
    'moderationEndDate',
    'punishmentEndDate',
    'reactivationDate',
    'reactivateDate',
    'canReactivateAt',
    'reactivateAt',
    'reenableDate',
    'notApprovedUntil',
    'suspensionEndDate'
  ])

  // Try direct date patterns in the text (HTML tags stripped)
  const dateStrMatches = [
    decodedText.match(/(?:reactivate|re-activate|mengaktifkan|continue|appeal|available|eligible|restore|after|setelah|pada|hingga)[^.]{0,160}?(?:after|on|until|at|setelah|pada|hingga|date|tanggal)\s+([^.]+)/i)?.[1],
    decodedText.match(/(?:after|on|until|at|setelah|pada|hingga)\s+([^.]{8,100})(?:\s+(?:to continue|to appeal|you can appeal|before continuing|untuk melanjutkan))?/i)?.[1],
    decodedText.match(/\b(\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?)\b/i)?.[1],
    decodedText.match(/\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)\b/i)?.[1]
  ]

  for (const matchStr of dateStrMatches) {
    if (!matchStr) continue
    const parsed = parseRobloxModerationDate(matchStr)
    if (parsed) return parsed.toISOString()
  }

  // Calculate using duration + start date
  const durationMs = getModerationDurationMs(body)
  if (!durationMs) return undefined

  const rawStartAt = getJsonStringValue(body, [
    'startDate',
    'beginDate',
    'created',
    'createdAt',
    'reviewedAt',
    'moderationStartDate',
    'punishmentStartDate',
    'suspensionStartDate'
  ])

  const startAtStr =
    rawStartAt ||
    decodedText.match(/(?:reviewed|started|created|ditinjau|dimulai|dibuat)\s*(?:on|at|:|pada)?\s*([^.\r\n]+)/i)?.[1] ||
    decodedText.match(/\b(\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?)\b/i)?.[1]

  const startAt = parseRobloxModerationDate(startAtStr)
  return new Date((startAt?.getTime() ?? Date.now()) + durationMs).toISOString()
}

/**
 * Calculates ban expiration from beginDate + punishmentTypeDescription.
 * Roblox's /v1/not-approved API returns:
 *   - punishmentTypeDescription: e.g. "1 Day Ban", "3 Day Ban", "7 Day Ban", "Delete"
 *   - beginDate: ISO timestamp of when the ban started
 *   - endDate: ISO timestamp of when the ban ends (sometimes empty string for temp bans)
 */
const calculateBanExpiry = (json: any): string | undefined => {
  // Strategy A: Try endDate directly (most reliable when present)
  const endDateCandidates = [
    json.endDate,
    json.punishmentEndDate,
    json.expiration,
    json.banExpiresAt,
    json.reactivateDate,
    json.canReactivateAt
  ]

  for (const endDate of endDateCandidates) {
    if (endDate && typeof endDate === 'string' && endDate.trim() !== '') {
      const parsed = new Date(endDate)
      if (Number.isFinite(parsed.getTime())) {
        console.log(`[Moderation] calculateBanExpiry: Using endDate directly: ${endDate} -> ${parsed.toISOString()}`)
        return parsed.toISOString()
      }
    }
  }

  // Strategy B: Calculate from beginDate + duration (from punishmentTypeDescription)
  const description = String(json.punishmentTypeDescription || json.moderationReason || json.reason || '')
  const beginDateStr = json.beginDate || json.startDate || json.created || json.createdAt

  console.log(`[Moderation] calculateBanExpiry: description="${description}", beginDate="${beginDateStr}"`)

  // Parse duration from description (e.g. "1 Day Ban", "3 Day Ban", "181 Day Ban")
  const durationMatch = description.match(/(\d+)\s*(day|days|hari|hour|hours|jam|minute|minutes|menit|month|months|year|years)/i)
  if (!durationMatch) {
    console.log(`[Moderation] calculateBanExpiry: No duration found in description`)
    return undefined
  }

  const amount = Number(durationMatch[1])
  const unit = durationMatch[2].toLowerCase()
  if (!Number.isFinite(amount)) return undefined

  let durationMs: number
  if (unit.startsWith('year')) durationMs = amount * 365 * 24 * 60 * 60 * 1000
  else if (unit.startsWith('month')) durationMs = amount * 30 * 24 * 60 * 60 * 1000
  else if (unit.startsWith('day') || unit === 'hari') durationMs = amount * 24 * 60 * 60 * 1000
  else if (unit.startsWith('hour') || unit === 'jam') durationMs = amount * 60 * 60 * 1000
  else durationMs = amount * 60 * 1000

  let startMs = Date.now()
  if (beginDateStr && typeof beginDateStr === 'string') {
    const parsed = new Date(beginDateStr)
    if (Number.isFinite(parsed.getTime())) {
      startMs = parsed.getTime()
      console.log(`[Moderation] calculateBanExpiry: Using beginDate: ${beginDateStr} -> ${parsed.toISOString()}`)
    }
  }

  const expiryDate = new Date(startMs + durationMs)
  console.log(`[Moderation] calculateBanExpiry: Calculated expiry: ${expiryDate.toISOString()} (${amount} ${unit} from ${new Date(startMs).toISOString()})`)
  return expiryDate.toISOString()
}

// ============================================================================
// Moderation Info Cache
// ============================================================================

/** Cache moderation info per cookie to avoid spamming the API on every poll */
const moderationCache = new Map<string, { info: ModerationInfo; fetchedAt: number }>()

/** Clear cached moderation info. Called when user explicitly refreshes. */
export const clearModerationCache = (): void => {
  console.log(`[Moderation] Cache cleared (had ${moderationCache.size} entries)`)
  moderationCache.clear()
}

export const fetchRobloxModerationInfo = async (
  cookie?: string,
  forceRefresh = false
): Promise<ModerationInfo> => {
  if (!cookie) return fallbackModerationInfo

  // Check cache first (unless force refresh)
  if (!forceRefresh) {
    const cached = moderationCache.get(cookie)
    if (cached) {
      console.log(`[Moderation] Using cached moderation info (fetched ${Math.round((Date.now() - cached.fetchedAt) / 1000)}s ago)`)
      return cached.info
    }
  }

  console.log(`[Moderation] fetchRobloxModerationInfo started (forceRefresh=${forceRefresh})`)

  // Strategy 1: Try the JSON API endpoint first with HBA auth (most reliable)
  try {
    console.log('[Moderation] Strategy 1: Fetching JSON API usermoderation with HBA...')
    const json = await safeRequest<any>({
      method: 'GET',
      url: 'https://usermoderation.roblox.com/v1/not-approved',
      cookie,
      headers: {
        Accept: 'application/json, text/plain, */*'
      }
    })

    console.log(`[Moderation] API JSON: ${JSON.stringify(json).substring(0, 500)}`)
    const reason = json.punishmentTypeDescription || json.moderationReason || json.reason || 'User is moderated'
    const banExpiresAt = calculateBanExpiry(json)
    console.log(`[Moderation] API calculated banExpiresAt: ${banExpiresAt}`)

    const result: ModerationInfo = {
      moderated: true,
      reason,
      banExpiresAt
    }
    moderationCache.set(cookie, { info: result, fetchedAt: Date.now() })
    return result
  } catch (err: any) {
    console.warn(`[Moderation] Strategy 1 failed: ${err.message}`)
  }

  // Strategy 2: Fetch the HTML not-approved page and parse duration from page text
  try {
    console.log('[Moderation] Strategy 2: Fetching HTML from www.roblox.com/not-approved...')
    const response = await net.fetch('https://www.roblox.com/not-approved', {
      method: 'GET',
      headers: {
        Cookie: `.ROBLOSECURITY=${cookie}`,
        Accept: 'text/html,application/json'
      }
    })

    console.log(`[Moderation] HTML Response status: ${response.status}`)
    const body = await response.text()
    if (!body || body.trim() === '') {
      console.log('[Moderation] HTML Body is empty!')
      return fallbackModerationInfo
    }

    console.log(`[Moderation] HTML Body length: ${body.length}`)
    console.log(`[Moderation] HTML Body snippet: ${body.substring(0, 400).replace(/\s+/g, ' ')}`)
    
    const reason = getModerationReason(body)
    const expiresAt = getModerationExpiresAt(body)
    console.log(`[Moderation] HTML Parsed Reason: "${reason}"`)
    console.log(`[Moderation] HTML Parsed ExpiresAt: "${expiresAt}"`)

    const result: ModerationInfo = {
      ...fallbackModerationInfo,
      reason,
      banExpiresAt: expiresAt
    }
    moderationCache.set(cookie, { info: result, fetchedAt: Date.now() })
    return result
  } catch (err: any) {
    console.error(`[Moderation] Strategy 2 failed: ${err.message}`)
    // Cache even fallback to prevent retrying on every poll
    moderationCache.set(cookie, { info: fallbackModerationInfo, fetchedAt: Date.now() })
    return fallbackModerationInfo
  }
}
