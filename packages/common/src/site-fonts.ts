export const SITE_FONT_IDS = [
	'geist',
	'inter',
	'noto-sans',
	'nunito-sans',
	'figtree',
	'roboto',
	'raleway',
	'dm-sans',
	'public-sans',
	'outfit',
	'oxanium',
	'manrope',
	'space-grotesk',
	'montserrat',
	'ibm-plex-sans',
	'source-sans-3',
	'instrument-sans',
	'noto-serif',
	'roboto-slab',
	'merriweather',
	'lora',
	'jetbrains-mono',
	'geist-mono',
] as const

export type SiteFontId = (typeof SITE_FONT_IDS)[number]
export const CUSTOM_SITE_FONT_ID = 'custom' as const
export type SiteFontSelection = SiteFontId | typeof CUSTOM_SITE_FONT_ID
export type SiteFontFallback = 'sans-serif' | 'serif' | 'monospace'

export const SITE_FONT_FORMATS = [
	'woff2',
	'woff',
	'truetype',
	'opentype',
] as const
export type SiteFontFormat = (typeof SITE_FONT_FORMATS)[number]

export type SiteCustomFont = {
	objectKey: string
	filename: string
	format: SiteFontFormat
}

export const CUSTOM_HEADING_FONT_FAMILY = 'SiteHeading'
export const CUSTOM_BODY_FONT_FAMILY = 'SiteBody'

const FONT_FORMAT_BY_EXTENSION: Record<string, SiteFontFormat> = {
	woff2: 'woff2',
	woff: 'woff',
	ttf: 'truetype',
	otf: 'opentype',
}

const EXTENSION_BY_FORMAT: Record<SiteFontFormat, string> = {
	woff2: 'woff2',
	woff: 'woff',
	truetype: 'ttf',
	opentype: 'otf',
}

export type SiteFont = {
	id: SiteFontId
	family: string
	fallback: SiteFontFallback
}

export const SITE_FONTS: readonly SiteFont[] = [
	{ id: 'geist', family: 'Geist', fallback: 'sans-serif' },
	{ id: 'inter', family: 'Inter', fallback: 'sans-serif' },
	{ id: 'noto-sans', family: 'Noto Sans', fallback: 'sans-serif' },
	{ id: 'nunito-sans', family: 'Nunito Sans', fallback: 'sans-serif' },
	{ id: 'figtree', family: 'Figtree', fallback: 'sans-serif' },
	{ id: 'roboto', family: 'Roboto', fallback: 'sans-serif' },
	{ id: 'raleway', family: 'Raleway', fallback: 'sans-serif' },
	{ id: 'dm-sans', family: 'DM Sans', fallback: 'sans-serif' },
	{ id: 'public-sans', family: 'Public Sans', fallback: 'sans-serif' },
	{ id: 'outfit', family: 'Outfit', fallback: 'sans-serif' },
	{ id: 'oxanium', family: 'Oxanium', fallback: 'sans-serif' },
	{ id: 'manrope', family: 'Manrope', fallback: 'sans-serif' },
	{ id: 'space-grotesk', family: 'Space Grotesk', fallback: 'sans-serif' },
	{ id: 'montserrat', family: 'Montserrat', fallback: 'sans-serif' },
	{ id: 'ibm-plex-sans', family: 'IBM Plex Sans', fallback: 'sans-serif' },
	{ id: 'source-sans-3', family: 'Source Sans 3', fallback: 'sans-serif' },
	{ id: 'instrument-sans', family: 'Instrument Sans', fallback: 'sans-serif' },
	{ id: 'noto-serif', family: 'Noto Serif', fallback: 'serif' },
	{ id: 'roboto-slab', family: 'Roboto Slab', fallback: 'serif' },
	{ id: 'merriweather', family: 'Merriweather', fallback: 'serif' },
	{ id: 'lora', family: 'Lora', fallback: 'serif' },
	{ id: 'jetbrains-mono', family: 'JetBrains Mono', fallback: 'monospace' },
	{ id: 'geist-mono', family: 'Geist Mono', fallback: 'monospace' },
]

const SITE_FONT_BY_ID = Object.fromEntries(
	SITE_FONTS.map((font) => [font.id, font]),
) as Record<SiteFontId, SiteFont>

const SITE_FONT_ALIASES: Record<string, SiteFontId> = {
	voutfit: 'outfit',
	'inter variable': 'inter',
}

export function isSiteFontId(value: unknown): value is SiteFontId {
	if (typeof value !== 'string') return false
	return (SITE_FONT_IDS as readonly string[]).includes(value)
}

export function getSiteFont(id: SiteFontId): SiteFont {
	return SITE_FONT_BY_ID[id]
}

export function siteFontCssValue(id: SiteFontId): string {
	const font = SITE_FONT_BY_ID[id]
	return `"${font.family}", ${font.fallback}`
}

/**
 * Literal `font-family` rules Fontless can scan at build time.
 * Runtime selection is via `data-heading-font` / `data-body-font` on `<html>`.
 */
export function buildSiteFontCatalogCss(): string {
	const headingTargets = ':is(h1, h2, h3, h4, h5, h6, .font-heading)'
	return SITE_FONTS.map((font) => {
		const family = siteFontCssValue(font.id)
		return [
			`html[data-body-font='${font.id}'],`,
			`html[data-body-font='${font.id}'] body {`,
			`\tfont-family: ${family};`,
			`}`,
			`html[data-heading-font='${font.id}'] ${headingTargets} {`,
			`\tfont-family: ${family};`,
			`}`,
		].join('\n')
	}).join('\n\n')
}

export function parseSiteFontId(
	value: unknown,
	fallback: SiteFontId,
): SiteFontId {
	if (typeof value !== 'string') return fallback
	const normalized = value.trim().toLowerCase()
	if (isSiteFontId(normalized)) return normalized
	return SITE_FONT_ALIASES[normalized] ?? fallback
}

export function isSiteFontSelection(
	value: unknown,
): value is SiteFontSelection {
	return value === CUSTOM_SITE_FONT_ID || isSiteFontId(value)
}

export function parseSiteFontSelection(
	value: unknown,
	fallback: SiteFontId,
): SiteFontSelection {
	if (value === CUSTOM_SITE_FONT_ID) return CUSTOM_SITE_FONT_ID
	return parseSiteFontId(value, fallback)
}

export function isSiteFontFormat(value: unknown): value is SiteFontFormat {
	return (
		typeof value === 'string' &&
		(SITE_FONT_FORMATS as readonly string[]).includes(value)
	)
}

export function siteFontFormatFromExtension(
	filename: string,
): SiteFontFormat | null {
	const ext = filename.split('.').pop()?.toLowerCase() ?? ''
	return FONT_FORMAT_BY_EXTENSION[ext] ?? null
}

export function siteFontExtension(format: SiteFontFormat): string {
	return EXTENSION_BY_FORMAT[format]
}

export function sniffSiteFontFormat(bytes: Uint8Array): SiteFontFormat | null {
	if (bytes.length < 4) return null
	const tag = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!)
	if (tag === 'wOF2') return 'woff2'
	if (tag === 'wOFF') return 'woff'
	if (tag === 'OTTO') return 'opentype'
	if (tag === 'true') return 'truetype'
	if (
		bytes[0] === 0x00 &&
		bytes[1] === 0x01 &&
		bytes[2] === 0x00 &&
		bytes[3] === 0x00
	) {
		return 'truetype'
	}
	return null
}

export function parseSiteCustomFont(value: unknown): SiteCustomFont | null {
	if (!value || typeof value !== 'object') return null
	const parsed = value as Record<string, unknown>
	if (typeof parsed.objectKey !== 'string') return null
	if (
		parsed.objectKey.length < 16 ||
		parsed.objectKey.includes('..') ||
		!/^org\/[a-zA-Z0-9_-]+\/site-fonts\//.test(parsed.objectKey)
	) {
		return null
	}
	if (typeof parsed.filename !== 'string' || parsed.filename.length === 0) {
		return null
	}
	if (!isSiteFontFormat(parsed.format)) return null
	return {
		objectKey: parsed.objectKey,
		filename: parsed.filename.slice(0, 180),
		format: parsed.format,
	}
}

export function siteFontDisplayName(filename: string): string {
	const base = filename.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/u, '')
	const named = base.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim()
	return named || 'Custom'
}

export function buildCustomSiteFontFaceCss(options: {
	headingUrl?: string | null
	headingFormat?: SiteFontFormat | null
	bodyUrl?: string | null
	bodyFormat?: SiteFontFormat | null
}): string {
	const faces: string[] = []
	if (options.headingUrl && options.headingFormat) {
		faces.push(
			buildFontFace(
				CUSTOM_HEADING_FONT_FAMILY,
				options.headingUrl,
				options.headingFormat,
			),
		)
	}
	if (options.bodyUrl && options.bodyFormat) {
		faces.push(
			buildFontFace(
				CUSTOM_BODY_FONT_FAMILY,
				options.bodyUrl,
				options.bodyFormat,
			),
		)
	}
	return faces.filter(Boolean).join('\n')
}

function buildFontFace(
	family: string,
	url: string,
	format: SiteFontFormat,
): string {
	// Preview payloads are caller-supplied, so neither value may be trusted: the
	// result lands in a raw-text <style>, where `</style>` ends the element.
	if (!isSiteFontFormat(format)) return ''
	const safeUrl = JSON.stringify(url).replace(/</g, '\\3c ')
	return [
		'@font-face {',
		`\tfont-family: ${family};`,
		`\tsrc: url(${safeUrl}) format("${format}");`,
		'\tfont-weight: 100 900;',
		'\tfont-style: normal;',
		'\tfont-display: swap;',
		'}',
	].join('\n')
}
