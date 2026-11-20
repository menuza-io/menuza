/**
 * Org site themes sourced from shadcn ui create presets
 * (apps/v4/registry/themes.ts) with the same base+theme merge as
 * ui.shadcn.com/create.
 */

import shadcnThemes from './shadcn-themes.json' with { type: 'json' }
import {
	CUSTOM_SITE_FONT_ID,
	parseSiteCustomFont,
	parseSiteFontSelection,
	type SiteCustomFont,
	type SiteFontSelection,
} from './site-fonts.ts'

export {
	CUSTOM_BODY_FONT_FAMILY,
	CUSTOM_HEADING_FONT_FAMILY,
	CUSTOM_SITE_FONT_ID,
	SITE_FONT_FORMATS,
	SITE_FONT_IDS,
	SITE_FONTS,
	buildCustomSiteFontFaceCss,
	buildSiteFontCatalogCss,
	getSiteFont,
	isSiteFontId,
	isSiteFontSelection,
	parseSiteCustomFont,
	parseSiteFontSelection,
	siteFontCssValue,
	siteFontDisplayName,
	siteFontExtension,
	siteFontFormatFromExtension,
	sniffSiteFontFormat,
	type SiteCustomFont,
	type SiteFont,
	type SiteFontFallback,
	type SiteFontFormat,
	type SiteFontId,
	type SiteFontSelection,
} from './site-fonts.ts'

export const SITE_BASE_COLORS = [
	'neutral',
	'stone',
	'zinc',
	'mauve',
	'olive',
	'mist',
	'taupe',
] as const

export const SITE_THEME_COLORS = [
	'neutral',
	'stone',
	'zinc',
	'mauve',
	'olive',
	'mist',
	'taupe',
	'amber',
	'blue',
	'cyan',
	'emerald',
	'fuchsia',
	'green',
	'indigo',
	'lime',
	'orange',
	'pink',
	'purple',
	'red',
	'rose',
	'sky',
	'teal',
	'violet',
	'yellow',
] as const

/** Matches shadcn create RADII names → rem values. */
export const SITE_THEME_RADII = [
	'default',
	'none',
	'small',
	'medium',
	'large',
	'full',
] as const

export const SITE_THEME_RADIUS_VALUES: Record<SiteThemeRadius, string> = {
	default: '0.625rem',
	none: '0',
	small: '0.45rem',
	medium: '0.625rem',
	large: '0.875rem',
	full: '1.2rem',
}

export const SITE_THEME_MODES = ['light', 'dark'] as const

export type SiteBaseColor = (typeof SITE_BASE_COLORS)[number]
export type SiteThemeColor = (typeof SITE_THEME_COLORS)[number]
export type SiteThemeRadius = (typeof SITE_THEME_RADII)[number]
export type SiteThemeMode = (typeof SITE_THEME_MODES)[number]

export type SiteThemeConfig = {
	baseColor: SiteBaseColor
	theme: SiteThemeColor
	radius: SiteThemeRadius
	mode: SiteThemeMode
	headingFont: SiteFontSelection
	bodyFont: SiteFontSelection
	headingCustomFont: SiteCustomFont | null
	bodyCustomFont: SiteCustomFont | null
	cssVars?: Record<string, string> | null
}

export const DEFAULT_SITE_THEME: SiteThemeConfig = {
	baseColor: 'neutral',
	theme: 'neutral',
	radius: 'default',
	mode: 'light',
	headingFont: 'inter',
	bodyFont: 'inter',
	headingCustomFont: null,
	bodyCustomFont: null,
	cssVars: null,
}

type ThemeTokens = Record<string, string>

type ShadcnTheme = {
	name: string
	title: string
	cssVars: {
		light: ThemeTokens
		dark: ThemeTokens
	}
}

const THEMES = shadcnThemes as ShadcnTheme[]

const THEME_BY_NAME = Object.fromEntries(
	THEMES.map((theme) => [theme.name, theme]),
) as Record<string, ShadcnTheme>

function toCssVarMap(tokens: ThemeTokens): ThemeTokens {
	const result: ThemeTokens = {}
	for (const [key, value] of Object.entries(tokens)) {
		result[key.startsWith('--') ? key : `--${key}`] = value
	}
	return result
}

export function getBaseColorMeta(baseColor: SiteBaseColor): {
	label: string
	swatch: string
} {
	const theme = THEME_BY_NAME[baseColor]
	return {
		label: theme?.title ?? baseColor,
		swatch:
			theme?.cssVars.dark['muted-foreground'] ??
			theme?.cssVars.dark.primary ??
			'oklch(0.5 0 0)',
	}
}

export function getThemeColorMeta(themeName: SiteThemeColor): {
	label: string
	swatch: string
} {
	const theme = THEME_BY_NAME[themeName]
	const isBase = (SITE_BASE_COLORS as readonly string[]).includes(themeName)
	return {
		label: theme?.title ?? themeName,
		swatch: isBase
			? (theme?.cssVars.dark['muted-foreground'] ??
				theme?.cssVars.dark.primary ??
				'oklch(0.5 0 0)')
			: (theme?.cssVars.dark.primary ?? 'oklch(0.5 0 0)'),
	}
}

export function isSiteBaseColor(value: unknown): value is SiteBaseColor {
	return (
		typeof value === 'string' &&
		(SITE_BASE_COLORS as readonly string[]).includes(value)
	)
}

export function isSiteThemeColor(value: unknown): value is SiteThemeColor {
	return (
		typeof value === 'string' &&
		(SITE_THEME_COLORS as readonly string[]).includes(value)
	)
}

/** @deprecated Prefer isSiteThemeColor */
export const isSiteThemeId = isSiteThemeColor

export function isSiteThemeRadius(value: unknown): value is SiteThemeRadius {
	return (
		typeof value === 'string' &&
		(SITE_THEME_RADII as readonly string[]).includes(value)
	)
}

export function isSiteThemeMode(value: unknown): value is SiteThemeMode {
	return (
		typeof value === 'string' &&
		(SITE_THEME_MODES as readonly string[]).includes(value)
	)
}

function migrateLegacyRadius(value: unknown): SiteThemeRadius {
	if (isSiteThemeRadius(value)) return value
	if (typeof value !== 'string') return DEFAULT_SITE_THEME.radius

	switch (value) {
		case '0':
			return 'none'
		case '0.3':
		case '0.45':
			return 'small'
		case '0.5':
		case '0.625':
			return 'default'
		case '0.75':
		case '0.875':
			return 'large'
		case '1.0':
		case '1':
			return 'large'
		case '1.2':
			return 'full'
		default:
			return DEFAULT_SITE_THEME.radius
	}
}

/**
 * Migrate legacy configs and parse stored JSON.
 */
export function parseSiteThemeConfig(
	raw: string | null | undefined,
): SiteThemeConfig {
	if (!raw) return { ...DEFAULT_SITE_THEME }

	try {
		const parsed = JSON.parse(raw) as Record<string, unknown>
		const legacyTheme =
			typeof parsed.theme === 'string' ? parsed.theme : undefined

		let baseColor = isSiteBaseColor(parsed.baseColor)
			? parsed.baseColor
			: DEFAULT_SITE_THEME.baseColor
		let theme = isSiteThemeColor(parsed.theme)
			? parsed.theme
			: DEFAULT_SITE_THEME.theme

		// Legacy single-theme configs / removed "gray" base.
		if (!isSiteBaseColor(parsed.baseColor) && legacyTheme) {
			if (legacyTheme === 'slate' || legacyTheme === 'gray') {
				baseColor = 'zinc'
				theme = 'zinc'
			} else if (isSiteBaseColor(legacyTheme)) {
				baseColor = legacyTheme
				theme = legacyTheme
			} else if (isSiteThemeColor(legacyTheme)) {
				baseColor = 'neutral'
				theme = legacyTheme
			}
		} else if (
			typeof parsed.baseColor === 'string' &&
			parsed.baseColor === 'gray'
		) {
			baseColor = 'zinc'
			if (
				typeof parsed.theme === 'string' &&
				(parsed.theme === 'gray' || !isSiteThemeColor(parsed.theme))
			) {
				theme = 'zinc'
			}
		}

		const headingCustomFont = parseSiteCustomFont(parsed.headingCustomFont)
		const bodyCustomFont = parseSiteCustomFont(parsed.bodyCustomFont)
		const headingFont = parseSiteFontSelection(parsed.headingFont, 'inter')
		const bodyFont = parseSiteFontSelection(parsed.bodyFont, 'inter')

		return {
			baseColor,
			theme,
			radius: migrateLegacyRadius(parsed.radius),
			mode: isSiteThemeMode(parsed.mode)
				? parsed.mode
				: DEFAULT_SITE_THEME.mode,
			headingFont:
				headingFont === CUSTOM_SITE_FONT_ID && !headingCustomFont
					? DEFAULT_SITE_THEME.headingFont
					: headingFont,
			bodyFont:
				bodyFont === CUSTOM_SITE_FONT_ID && !bodyCustomFont
					? DEFAULT_SITE_THEME.bodyFont
					: bodyFont,
			headingCustomFont,
			bodyCustomFont,
			cssVars: parsed.cssVars as SiteThemeConfig['cssVars'],
		}
	} catch {
		return { ...DEFAULT_SITE_THEME }
	}
}

export function serializeSiteThemeConfig(config: SiteThemeConfig): string {
	return JSON.stringify(config)
}

/**
 * The theme is emitted inside an inline `<style>` element, and `cssVars` comes
 * from stored JSON. A value that closes the element (`</style><script>`), the
 * declaration (`;`) or the rule (`}`) would turn a color override into markup
 * or arbitrary CSS, so only plain token names and values pass.
 */
function sanitizeCssVarOverrides(
	cssVars: Record<string, string> | null | undefined,
): Record<string, string> {
	const out: Record<string, string> = {}
	for (const [key, value] of Object.entries(cssVars ?? {})) {
		if (!/^[a-zA-Z0-9-]{1,64}$/.test(key)) continue
		if (typeof value !== 'string' || value.length > 200) continue
		if (/[<>{};\\]|\/\*|@import|url\s*\(/i.test(value)) continue
		out[key] = value
	}
	return out
}

/**
 * Same merge as shadcn create: base color tokens, then theme overrides.
 */
export function resolveSiteThemeTokens(config: SiteThemeConfig): {
	light: ThemeTokens
	dark: ThemeTokens
} {
	const base = THEME_BY_NAME[config.baseColor] ?? THEME_BY_NAME.neutral!
	const theme = THEME_BY_NAME[config.theme] ?? THEME_BY_NAME.neutral!
	const radius = SITE_THEME_RADIUS_VALUES[config.radius]

	const overrides = sanitizeCssVarOverrides(config.cssVars)
	const lightRaw: ThemeTokens = {
		...base.cssVars.light,
		...theme.cssVars.light,
		radius,
		...overrides,
	}
	const darkRaw: ThemeTokens = {
		...base.cssVars.dark,
		...theme.cssVars.dark,
		radius,
		...overrides,
	}

	return {
		light: toCssVarMap(lightRaw),
		dark: toCssVarMap(darkRaw),
	}
}

/**
 * Resolve only the base+theme+radius preset tokens for the current config,
 * without applying any user `cssVars` overrides. Useful for pre-filling an
 * editor with the active preset value or for showing a "preset" hint next
 * to an overridden token. Returns the variant for the current `config.mode`
 * (light or dark) so the editor reflects what the user is actually previewing.
 * Keys are unprefixed (e.g. `primary`) to match the `SiteThemeConfig.cssVars`
 * shape; the radius token is included as `radius`.
 */
export function resolveSiteThemePresetTokens(
	config: SiteThemeConfig,
): ThemeTokens {
	const base = THEME_BY_NAME[config.baseColor] ?? THEME_BY_NAME.neutral!
	const theme = THEME_BY_NAME[config.theme] ?? THEME_BY_NAME.neutral!
	const radius = SITE_THEME_RADIUS_VALUES[config.radius]
	const variant = config.mode === 'dark' ? 'dark' : 'light'

	return {
		...base.cssVars[variant],
		...theme.cssVars[variant],
		radius,
	}
}

function tokensToCss(selector: string, tokens: ThemeTokens): string {
	const body = Object.entries(tokens)
		.map(([key, value]) => `\t${key}: ${value};`)
		.join('\n')
	return `${selector} {\n${body}\n}`
}

/**
 * Build CSS variable overrides for a site theme (injected into public sites).
 */
export function buildSiteThemeCss(config: SiteThemeConfig): string {
	const { light, dark } = resolveSiteThemeTokens(config)
	return [tokensToCss('html', light), tokensToCss('html.dark', dark)].join(
		'\n\n',
	)
}

/**
 * A palette drawn from a logo (#396). The same helper is what "Create my
 * site with AI" applies when a logo exists. Colors are hex so they pass the
 * theme CSS sanitizer. Text pairs are adjusted until contrast is at least
 * 4.5:1 (WCAG AA body text).
 */
export type Rgb = { r: number; g: number; b: number }

const WHITE: Rgb = { r: 255, g: 255, b: 255 }
const BLACK: Rgb = { r: 17, g: 17, b: 17 }
const MIN_TEXT_CONTRAST = 4.5

function channelLuma(value: number) {
	const s = value / 255
	return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}

export function relativeLuminance(color: Rgb) {
	return (
		0.2126 * channelLuma(color.r) +
		0.7152 * channelLuma(color.g) +
		0.0722 * channelLuma(color.b)
	)
}

export function contrastRatio(a: Rgb, b: Rgb) {
	const left = relativeLuminance(a)
	const right = relativeLuminance(b)
	const [hi, lo] = left > right ? [left, right] : [right, left]
	return (hi + 0.05) / (lo + 0.05)
}

function clampByte(value: number) {
	return Math.max(0, Math.min(255, Math.round(value)))
}

function mix(a: Rgb, b: Rgb, towardB: number): Rgb {
	const t = Math.max(0, Math.min(1, towardB))
	return {
		r: clampByte(a.r + (b.r - a.r) * t),
		g: clampByte(a.g + (b.g - a.g) * t),
		b: clampByte(a.b + (b.b - a.b) * t),
	}
}

function toHex(color: Rgb) {
	const byte = (value: number) => clampByte(value).toString(16).padStart(2, '0')
	return `#${byte(color.r)}${byte(color.g)}${byte(color.b)}`
}

function readablePair(brand: Rgb): { background: Rgb; foreground: Rgb } {
	let background = brand
	for (let step = 0; step < 28; step += 1) {
		const onWhite = contrastRatio(background, WHITE)
		const onBlack = contrastRatio(background, BLACK)
		if (onWhite >= MIN_TEXT_CONTRAST && onWhite >= onBlack) {
			return { background, foreground: WHITE }
		}
		if (onBlack >= MIN_TEXT_CONTRAST) return { background, foreground: BLACK }
		background = mix(background, onWhite >= onBlack ? BLACK : WHITE, 0.14)
	}
	return { background: { r: 30, g: 30, b: 30 }, foreground: WHITE }
}

function pagePair(brand: Rgb): { background: Rgb; foreground: Rgb } {
	let background = mix(brand, WHITE, 0.9)
	let foreground = BLACK
	for (let step = 0; step < 12; step += 1) {
		if (contrastRatio(background, foreground) >= MIN_TEXT_CONTRAST) break
		background = mix(background, WHITE, 0.25)
	}
	if (contrastRatio(background, foreground) < MIN_TEXT_CONTRAST) {
		background = WHITE
	}
	return { background, foreground }
}

function dominantBrand(samples: readonly Rgb[]): Rgb {
	const usable = samples.filter((sample) => {
		const luma = relativeLuminance(sample)
		return luma > 0.04 && luma < 0.94
	})
	const pool = usable.length > 0 ? usable : samples
	if (pool.length === 0) return { r: 30, g: 64, b: 175 }
	const buckets = new Map<number, { total: Rgb; count: number }>()
	for (const sample of pool) {
		const hue = Math.round(hueOf(sample) / 30) * 30
		const bucket = buckets.get(hue) ?? { total: { r: 0, g: 0, b: 0 }, count: 0 }
		bucket.total = {
			r: bucket.total.r + sample.r,
			g: bucket.total.g + sample.g,
			b: bucket.total.b + sample.b,
		}
		bucket.count += 1
		buckets.set(hue, bucket)
	}
	let best = pool[0]!
	let bestCount = -1
	for (const bucket of buckets.values()) {
		if (bucket.count > bestCount) {
			bestCount = bucket.count
			best = {
				r: bucket.total.r / bucket.count,
				g: bucket.total.g / bucket.count,
				b: bucket.total.b / bucket.count,
			}
		}
	}
	return {
		r: clampByte(best.r),
		g: clampByte(best.g),
		b: clampByte(best.b),
	}
}

function hueOf(color: Rgb) {
	const r = color.r / 255
	const g = color.g / 255
	const b = color.b / 255
	const max = Math.max(r, g, b)
	const min = Math.min(r, g, b)
	const delta = max - min
	if (delta === 0) return 0
	let hue = 0
	if (max === r) hue = ((g - b) / delta) % 6
	else if (max === g) hue = (b - r) / delta + 2
	else hue = (r - g) / delta + 4
	return (hue * 60 + 360) % 360
}

export type LogoPalette = {
	cssVars: Record<string, string>
	/** Contrast of the button label on the button, and body text on the page. */
	contrast: { primaryText: number; bodyText: number }
}

export function suggestLogoPalette(samples: readonly Rgb[]): LogoPalette {
	const brand = dominantBrand(samples)
	const button = readablePair(brand)
	const page = pagePair(brand)
	const muted = mix(page.background, brand, 0.08)
	const primaryText = contrastRatio(button.background, button.foreground)
	const bodyText = contrastRatio(page.background, page.foreground)
	return {
		cssVars: {
			primary: toHex(button.background),
			'primary-foreground': toHex(button.foreground),
			background: toHex(page.background),
			foreground: toHex(page.foreground),
			card: toHex(page.background),
			'card-foreground': toHex(page.foreground),
			popover: toHex(page.background),
			'popover-foreground': toHex(page.foreground),
			secondary: toHex(mix(page.background, brand, 0.16)),
			'secondary-foreground': toHex(page.foreground),
			muted: toHex(muted),
			'muted-foreground': toHex(mix(page.foreground, page.background, 0.35)),
			accent: toHex(mix(page.background, brand, 0.2)),
			'accent-foreground': toHex(page.foreground),
			border: toHex(mix(page.background, brand, 0.28)),
			ring: toHex(button.background),
		},
		contrast: { primaryText, bodyText },
	}
}

export function paletteMeetsContrast(palette: LogoPalette) {
	return (
		palette.contrast.primaryText >= MIN_TEXT_CONTRAST &&
		palette.contrast.bodyText >= MIN_TEXT_CONTRAST
	)
}

/**
 * A new theme config with the logo palette in `cssVars`. Does not publish:
 * callers write it with the draft theme save.
 */
export function themeWithLogoPalette(
	theme: SiteThemeConfig,
	samples: readonly Rgb[],
): SiteThemeConfig {
	const palette = suggestLogoPalette(samples)
	return {
		...theme,
		cssVars: { ...theme.cssVars, ...palette.cssVars },
	}
}
