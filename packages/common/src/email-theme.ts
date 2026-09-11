import {
	CUSTOM_BODY_FONT_FAMILY,
	CUSTOM_HEADING_FONT_FAMILY,
	CUSTOM_SITE_FONT_ID,
	isSiteFontId,
	parseSiteThemeConfig,
	resolveSiteThemeTokens,
	siteFontCssValue,
	type SiteThemeConfig,
	type SiteThemeMode,
} from './site-theme.ts'

/**
 * Email-safe theme derived from an organization's website theme.
 *
 * Email clients do not support CSS variables, `oklch()`, or Tailwind classes,
 * so every token is resolved to a literal color and applied inline. Values are
 * taken from the same source of truth the public sites use
 * (`resolveSiteThemeTokens`) and converted with `oklchToHex`.
 */

export type EmailTheme = {
	organizationName: string
	logoUrl: string | null
	appUrl: string | null
	background: string
	card: string
	foreground: string
	muted: string
	mutedForeground: string
	border: string
	primary: string
	primaryForeground: string
	accent: string
	accentForeground: string
	radius: number
	headingFont: string
	bodyFont: string
}

export type EmailThemeInput = {
	organizationName?: string | null
	logoUrl?: string | null
	appUrl?: string | null
	siteTheme?: SiteThemeConfig | string | null
	/** Force a light/dark variant regardless of the stored theme mode. */
	mode?: SiteThemeMode
}

const LIGHT_FALLBACKS = {
	background: '#F4F4F5',
	card: '#FFFFFF',
	foreground: '#18181B',
	muted: '#F4F4F5',
	mutedForeground: '#71717A',
	border: '#E4E4E7',
	primary: '#2563EB',
	primaryForeground: '#FFFFFF',
	accent: '#F4F4F5',
	accentForeground: '#18181B',
} as const

const OKLCH_PATTERN =
	/^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)(%?)\s+([\d.]+)(?:deg)?\s*(?:\/\s*([\d.]+)(%?)\s*)?\)$/i

function linearToGamma(value: number): number {
	return value <= 0.0031308
		? 12.92 * value
		: 1.055 * Math.pow(value, 1 / 2.4) - 0.055
}

function channelToByte(value: number): number {
	return Math.round(Math.min(1, Math.max(0, value)) * 255)
}

function toHexChannel(value: number): string {
	return channelToByte(value).toString(16).padStart(2, '0')
}

/**
 * Convert a CSS `oklch()` color to `#rrggbb` (or `rgba()` when it has alpha).
 * Returns `null` for anything that is not a parseable oklch color.
 */
export function oklchToHex(input: string): string | null {
	const match = OKLCH_PATTERN.exec(input.trim())
	if (!match) return null

	const lRaw = Number.parseFloat(match[1]!)
	const l = match[2] === '%' ? lRaw / 100 : lRaw
	const cRaw = Number.parseFloat(match[3]!)
	const c = match[4] === '%' ? (cRaw / 100) * 0.4 : cRaw
	const h = Number.parseFloat(match[5]!)
	if ([l, c, h].some((value) => Number.isNaN(value))) return null

	const hueRad = (h * Math.PI) / 180
	const a = c * Math.cos(hueRad)
	const b = c * Math.sin(hueRad)

	const lPrime = l + 0.3963377774 * a + 0.2158037573 * b
	const mPrime = l - 0.1055613458 * a - 0.0638541728 * b
	const sPrime = l - 0.0894841775 * a - 1.291485548 * b

	const lCubed = lPrime ** 3
	const mCubed = mPrime ** 3
	const sCubed = sPrime ** 3

	const red = linearToGamma(
		4.0767416621 * lCubed - 3.3077115913 * mCubed + 0.2309699292 * sCubed,
	)
	const green = linearToGamma(
		-1.2684380046 * lCubed + 2.6097574011 * mCubed - 0.3413193965 * sCubed,
	)
	const blue = linearToGamma(
		-0.0041960863 * lCubed - 0.7034186147 * mCubed + 1.707614701 * sCubed,
	)

	let alpha = 1
	if (match[6] != null) {
		const alphaRaw = Number.parseFloat(match[6])
		alpha = match[7] === '%' ? alphaRaw / 100 : alphaRaw
	}

	if (alpha < 1) {
		return `rgba(${channelToByte(red)}, ${channelToByte(green)}, ${channelToByte(blue)}, ${Number(alpha.toFixed(3))})`
	}
	return `#${toHexChannel(red)}${toHexChannel(green)}${toHexChannel(blue)}`
}

/** Resolve a CSS color to an email-safe literal, converting oklch and falling back. */
export function toEmailColor(
	value: string | null | undefined,
	fallback: string,
): string {
	if (!value) return fallback
	const trimmed = value.trim()
	if (trimmed.length === 0) return fallback
	if (/^oklch\(/i.test(trimmed)) {
		return oklchToHex(trimmed) ?? fallback
	}
	return trimmed
}

export function radiusToPx(
	value: string | null | undefined,
	fallback = 10,
): number {
	if (!value) return fallback
	const match = /^(-?[\d.]+)(px|rem|em)?$/.exec(value.trim())
	if (!match) return fallback
	const amount = Number.parseFloat(match[1]!)
	if (Number.isNaN(amount)) return fallback
	const unit = match[2] ?? 'px'
	if (unit === 'px') return Math.round(amount)
	return Math.round(amount * 16)
}

function emailFont(config: SiteThemeConfig, role: 'heading' | 'body'): string {
	const selection = role === 'heading' ? config.headingFont : config.bodyFont
	const custom =
		role === 'heading' ? config.headingCustomFont : config.bodyCustomFont
	if (selection === CUSTOM_SITE_FONT_ID && custom) {
		const family =
			role === 'heading' ? CUSTOM_HEADING_FONT_FAMILY : CUSTOM_BODY_FONT_FAMILY
		return `"${family}", "Inter", Helvetica, Arial, sans-serif`
	}
	if (isSiteFontId(selection)) return siteFontCssValue(selection)
	return '"Inter", Helvetica, Arial, sans-serif'
}

/** Make a stored asset URL absolute so it loads inside an email client. */
export function resolveEmailAssetUrl(
	url: string | null | undefined,
	appUrl?: string | null,
): string {
	if (!url) return ''
	const trimmed = url.trim()
	if (trimmed.length === 0) return ''
	if (/^(https?:|data:|mailto:|tel:)/i.test(trimmed)) return trimmed
	if (!appUrl) return trimmed
	const base = appUrl.endsWith('/') ? appUrl : `${appUrl}/`
	try {
		return new URL(trimmed, base).toString()
	} catch {
		return trimmed
	}
}

export function resolveEmailTheme(input: EmailThemeInput): EmailTheme {
	const config =
		typeof input.siteTheme === 'string' || input.siteTheme == null
			? parseSiteThemeConfig(input.siteTheme ?? null)
			: input.siteTheme
	const mode = input.mode ?? config.mode
	const { light, dark } = resolveSiteThemeTokens(config)
	const tokens = mode === 'dark' ? dark : light

	const pick = (key: string, fallback: string) =>
		toEmailColor(tokens[key], fallback)

	return {
		organizationName: input.organizationName?.trim() || '',
		logoUrl: input.logoUrl?.trim() || null,
		appUrl: input.appUrl ?? null,
		background: pick('--background', LIGHT_FALLBACKS.background),
		card: pick('--card', LIGHT_FALLBACKS.card),
		foreground: pick('--foreground', LIGHT_FALLBACKS.foreground),
		muted: pick('--muted', LIGHT_FALLBACKS.muted),
		mutedForeground: pick(
			'--muted-foreground',
			LIGHT_FALLBACKS.mutedForeground,
		),
		border: pick('--border', LIGHT_FALLBACKS.border),
		primary: pick('--primary', LIGHT_FALLBACKS.primary),
		primaryForeground: pick(
			'--primary-foreground',
			LIGHT_FALLBACKS.primaryForeground,
		),
		accent: pick('--accent', LIGHT_FALLBACKS.accent),
		accentForeground: pick(
			'--accent-foreground',
			LIGHT_FALLBACKS.accentForeground,
		),
		radius: radiusToPx(tokens['--radius']),
		headingFont: emailFont(config, 'heading'),
		bodyFont: emailFont(config, 'body'),
	}
}
