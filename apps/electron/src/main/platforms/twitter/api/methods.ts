/**
 * HTML/script parsing helpers used by TwitterClient bootstrap flow.
 */

const metaTagRegex = /<meta\s+http-equiv=["']refresh["']\s+content=["'][^;]+;\s*url\s*=\s*([^"']+)["']\s*\/?>/i
const migrateFormDataRegex = /<form[^>]* action="([^"]+)"[^>]*>[\s\S]*?<input[^>]* name="tok" value="([^"]+)"[^>]*>[\s\S]*?<input[^>]* name="data" value="([^"]+)"[^>]*>/i
const mainScriptURLRegex = /https:\/\/(?:[A-Za-z0-9.-]+)\/responsive-web\/client-web\/main\.[0-9A-Za-z]+\.js/
const bearerTokenRegex = /Bearer\s[A-Za-z0-9%]{16,}/g
const guestTokenRegex = /gt=([0-9]+)/
// Matches meta[name^=tw] for verification token extraction
const verificationTokenRegex = /meta\s+name=["']tw[^"']*["']\s+content=["']([^"']+)["']/i
const countryCodeRegex = /"country":\s*"([A-Z]{2})"/
const ondemandSRegex = /"ondemand\.s":"([a-f0-9]+)"/
const variableIndexesRegex = /\[.+?\(\w{1,2}\[(\d{1,2})],16\).+?\(\w{1,2}\[(\d{1,2})],16\).+?\(\w{1,2}\[(\d{1,2})],16\).+?\(\w{1,2}\[(\d{1,2})],16\)/

export function parseMigrateURL(html: string): string | null {
  const match = html.match(metaTagRegex)
  return match?.[1] ?? null
}

export function parseMigrateRequestData(
  html: string
): { action: string; tok: string; data: string } | null {
  const match = html.match(migrateFormDataRegex)
  if (!match || match.length < 4) return null
  return {
    action: match[1],
    tok: match[2],
    data: match[3],
  }
}

export function parseMainScriptURL(html: string): string | null {
  const match = html.match(mainScriptURLRegex)
  return match?.[0] ?? null
}

export function parseBearerTokens(script: string): string[] {
  return script.match(bearerTokenRegex) ?? []
}

export function parseVariableIndexes(script: string): [number, number, number, number] | null {
  const match = script.match(variableIndexesRegex)
  if (!match || match.length < 5) return null

  const values = match.slice(1, 5).map((item) => Number.parseInt(item, 10))
  if (values.some((item) => Number.isNaN(item))) {
    return null
  }

  return [values[0], values[1], values[2], values[3]]
}

export function parseGuestToken(html: string): string | null {
  const match = html.match(guestTokenRegex)
  return match?.[1] ?? null
}

export function parseVerificationToken(html: string): string | null {
  const match = html.match(verificationTokenRegex)
  return match?.[1] ?? null
}

export function parseCountry(html: string): string | null {
  const match = html.match(countryCodeRegex)
  return match?.[1] ?? null
}

export function parseOndemandS(html: string): string | null {
  const match = html.match(ondemandSRegex)
  return match?.[1] ?? null
}

/**
 * Parse loading animations from SVG elements in HTML.
 * Each SVG has a second <path> with a "d" attribute containing animation data.
 * Returns a 4x16x11 int array or null if not found.
 */
const svgAnimRegex = /<svg[^>]*id=["']loading-x-anim-\d["'][^>]*>([\s\S]*?)<\/svg>/gi
const pathDRegex = /<path[^>]*\bd=["']([^"']+)["'][^>]*\/?>/gi
const nonNumbersRegex = /\D+/g

export function parseLoadingAnimations(html: string): number[][][] | null {
  const svgMatches = [...html.matchAll(svgAnimRegex)]
  if (svgMatches.length < 4) {
    return null
  }

  const result: number[][][] = []

  for (let svgIdx = 0; svgIdx < 4; svgIdx++) {
    const svgContent = svgMatches[svgIdx][1]

    // Find all path d attributes; take the second one (index 1)
    const paths = [...svgContent.matchAll(pathDRegex)]
    if (paths.length < 2) {
      return null
    }

    const pathVal = paths[1][1]
    // Skip SVG path prefix then split by "C" into cubic bezier segments
    const sets = pathVal.slice(9).split('C')
    if (sets.length !== 16) {
      return null
    }

    const numSets: number[][] = []
    for (const set of sets) {
      const cleaned = set.trim().replace(nonNumbersRegex, ' ').trim()
      const numbers = cleaned.split(' ')
      if (numbers.length !== 11) {
        return null
      }

      const parsed = numbers.map((n) => Number.parseInt(n, 10))
      if (parsed.some((v) => Number.isNaN(v))) {
        return null
      }

      numSets.push(parsed)
    }

    result.push(numSets)
  }

  return result
}
