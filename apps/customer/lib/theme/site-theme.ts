import { type RgbaColor } from './rgba-color'
import {
	type SiteColorScheme,
	type SiteColorToken,
	type SiteThemeTokens,
	parseSiteThemeCss,
	tokenColor,
} from './site-theme-tokens'

export interface PublicSiteCustomFont {
	readonly url: string
	readonly format: string
}

/**
 * Mirrors `PublicSiteTheme` in `apps/sites/src/lib/org.ts`. `css` is the
 * organization's compiled shadcn theme (CSS custom properties in `oklch()`).
 */
export interface PublicSiteTheme {
	readonly baseColor?: string | null
	readonly theme?: string | null
	readonly radius?: string | null
	readonly mode?: string | null
	readonly headingFont?: string | null
	readonly bodyFont?: string | null
	readonly headingCustomFont?: PublicSiteCustomFont | null
	readonly bodyCustomFont?: PublicSiteCustomFont | null
	readonly css?: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringField(
	record: Record<string, unknown>,
	key: string,
): string | null {
	const value = record[key]
	return typeof value === 'string' ? value : null
}

function parseCustomFont(value: unknown): PublicSiteCustomFont | null {
	if (!isRecord(value)) return null
	const url = stringField(value, 'url')
	if (url === null) return null
	return { url, format: stringField(value, 'format') ?? 'woff2' }
}

/**
 * Decodes the `theme` field of the `GET /resources/sites` payload. Never
 * throws: a non-object is `null` (no theme) and a field of the wrong type is
 * treated as missing, so it falls back to its default.
 */
export function parsePublicSiteTheme(value: unknown): PublicSiteTheme | null {
	if (!isRecord(value)) return null
	return {
		baseColor: stringField(value, 'baseColor'),
		theme: stringField(value, 'theme'),
		radius: stringField(value, 'radius'),
		mode: stringField(value, 'mode'),
		headingFont: stringField(value, 'headingFont'),
		bodyFont: stringField(value, 'bodyFont'),
		headingCustomFont: parseCustomFont(value.headingCustomFont),
		bodyCustomFont: parseCustomFont(value.bodyCustomFont),
		css: stringField(value, 'css'),
	}
}

export type SiteFontRole = 'heading' | 'body'

/**
 * The organization's resolved branding: colors, corner radius and typography.
 * The native equivalent of the `data-site-theme` attributes and `--token` CSS
 * variables that `apps/sites` injects into every page.
 */
export interface SiteTheme {
	readonly tokens: SiteThemeTokens
	/** `light` | `dark` | `system`, as published (not normalized). */
	readonly mode: string
	readonly baseColor: string | null
	readonly themeName: string | null
	readonly headingFontId: string
	readonly bodyFontId: string
	readonly headingCustomFontUrl: string | null
	readonly bodyCustomFontUrl: string | null
}

function nonEmpty(value: string | null | undefined): string | null {
	return value ? value : null
}

function customFontUrl(font: PublicSiteCustomFont | null | undefined) {
	const url = font?.url
	return url && url.trim() !== '' ? url : null
}

export function createSiteTheme(
	theme: PublicSiteTheme | null | undefined,
): SiteTheme {
	return {
		tokens: parseSiteThemeCss(theme?.css ?? ''),
		mode: nonEmpty(theme?.mode) ?? 'system',
		baseColor: theme?.baseColor ?? null,
		themeName: theme?.theme ?? null,
		headingFontId: nonEmpty(theme?.headingFont) ?? 'inter',
		bodyFontId: nonEmpty(theme?.bodyFont) ?? 'inter',
		headingCustomFontUrl: customFontUrl(theme?.headingCustomFont),
		bodyCustomFontUrl: customFontUrl(theme?.bodyCustomFont),
	}
}

/** The `theme` value of the organization payload, straight to a `SiteTheme`. */
export function siteThemeFromPayload(value: unknown): SiteTheme {
	return createSiteTheme(parsePublicSiteTheme(value))
}

export const FALLBACK_SITE_THEME: SiteTheme = createSiteTheme(null)

export function resolveColorScheme(
	theme: SiteTheme,
	systemIsDark: boolean,
): SiteColorScheme {
	return preferredColorScheme(theme) ?? (systemIsDark ? 'dark' : 'light')
}

/** `light` / `dark`, or `null` to follow the system. */
export function preferredColorScheme(theme: SiteTheme): SiteColorScheme | null {
	switch (theme.mode.toLowerCase()) {
		case 'dark':
			return 'dark'
		case 'light':
			return 'light'
		default:
			return null
	}
}

export function siteThemeColor(
	theme: SiteTheme,
	token: SiteColorToken,
	scheme: SiteColorScheme,
): RgbaColor {
	return tokenColor(theme.tokens, token, scheme)
}

export const DEFAULT_RADIUS_REM = 0.625

/**
 * CSS `--radius` (rem) → points at 16 per rem. `scale` mirrors
 * `rounded-[calc(var(--radius)*0.7)]` in the Astro components.
 */
export function siteThemeRadius(theme: SiteTheme, scale = 1): number {
	return (theme.tokens.radiusRem ?? DEFAULT_RADIUS_REM) * 16 * scale
}

export const KNOWN_FONT_FAMILIES: Readonly<Record<string, string>> = {
	geist: 'Geist',
	inter: 'Inter',
	'noto-sans': 'Noto Sans',
	'nunito-sans': 'Nunito Sans',
	figtree: 'Figtree',
	roboto: 'Roboto',
	raleway: 'Raleway',
	'dm-sans': 'DM Sans',
	'public-sans': 'Public Sans',
	outfit: 'Outfit',
	oxanium: 'Oxanium',
	manrope: 'Manrope',
	'space-grotesk': 'Space Grotesk',
	montserrat: 'Montserrat',
	'ibm-plex-sans': 'IBM Plex Sans',
	'source-sans-3': 'Source Sans 3',
	'instrument-sans': 'Instrument Sans',
	'noto-serif': 'Noto Serif',
	'roboto-slab': 'Roboto Slab',
	merriweather: 'Merriweather',
	lora: 'Lora',
	'jetbrains-mono': 'JetBrains Mono',
	'geist-mono': 'Geist Mono',
}

/**
 * Font family name for a Sites font id, or `null` for an unknown id (render
 * with the system font). Remote custom fonts are never downloaded.
 */
export function siteFontFamily(
	theme: SiteTheme,
	role: SiteFontRole,
): string | null {
	const id = role === 'heading' ? theme.headingFontId : theme.bodyFontId
	return Object.prototype.hasOwnProperty.call(KNOWN_FONT_FAMILIES, id)
		? (KNOWN_FONT_FAMILIES[id] ?? null)
		: null
}
