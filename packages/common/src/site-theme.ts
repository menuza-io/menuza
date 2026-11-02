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
