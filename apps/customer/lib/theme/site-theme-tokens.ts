import {
	BLACK,
	type RgbaColor,
	parseCssColor,
	parseSwiftDouble,
} from './rgba-color'

export type SiteColorScheme = 'light' | 'dark'

export const SITE_COLOR_SCHEMES: readonly SiteColorScheme[] = ['light', 'dark']

/**
 * Semantic color tokens used by the Sites design system
 * (`packages/common/src/site-theme.ts`, shadcn `--token` names).
 */
export const SITE_COLOR_TOKENS = [
	'background',
	'foreground',
	'card',
	'card-foreground',
	'popover',
	'popover-foreground',
	'primary',
	'primary-foreground',
	'secondary',
	'secondary-foreground',
	'muted',
	'muted-foreground',
	'accent',
	'accent-foreground',
	'destructive',
	'destructive-foreground',
	'border',
	'input',
	'ring',
] as const

export type SiteColorToken = (typeof SITE_COLOR_TOKENS)[number]

/**
 * The `--token: oklch(…)` map compiled by the App (`buildSiteThemeCss`). Any
 * custom property that parses as a color is kept, including names outside
 * `SITE_COLOR_TOKENS`.
 */
export interface SiteThemeTokens {
	readonly light: Readonly<Record<string, RgbaColor>>
	readonly dark: Readonly<Record<string, RgbaColor>>
	/** `--radius` in rem. */
	readonly radiusRem: number | null
}

export const EMPTY_SITE_THEME_TOKENS: SiteThemeTokens = {
	light: {},
	dark: {},
	radiusRem: null,
}

export function rawTokenColor(
	tokens: SiteThemeTokens,
	name: string,
	scheme: SiteColorScheme,
): RgbaColor | null {
	const map = scheme === 'light' ? tokens.light : tokens.dark
	return Object.prototype.hasOwnProperty.call(map, name)
		? (map[name] ?? null)
		: null
}

export function tokenColor(
	tokens: SiteThemeTokens,
	token: SiteColorToken,
	scheme: SiteColorScheme,
): RgbaColor {
	return (
		rawTokenColor(tokens, token, scheme) ?? siteThemeDefaultColor(token, scheme)
	)
}

/**
 * Parses the `html { … } html.dark { … }` stylesheet produced by
 * `buildSiteThemeCss()` in `packages/common/src/site-theme.ts`.
 *
 * Forgiving by design: an empty, partial or unknown-color-space theme keeps
 * whatever it can and the rest falls back to the neutral defaults.
 */
export function parseSiteThemeCss(css: string): SiteThemeTokens {
	if (css === '') return EMPTY_SITE_THEME_TOKENS
	const light: Record<string, RgbaColor> = {}
	const dark: Record<string, RgbaColor> = {}
	let radiusRem: number | null = null

	for (const block of cssRuleBlocks(css)) {
		const selector = block.selector.toLowerCase()
		if (!selector.includes('html') && !selector.includes(':root')) continue
		const scheme: SiteColorScheme =
			selector.includes('.dark') || selector.includes("[data-theme='dark']")
				? 'dark'
				: 'light'

		for (const [name, rawValue] of cssDeclarations(block.body)) {
			if (name === 'radius') {
				// The light block wins; a dark-only radius is used only when light has none.
				if (radiusRem === null || scheme === 'light') {
					radiusRem = remValue(rawValue) ?? radiusRem
				}
				continue
			}
			const color = parseCssColor(rawValue)
			if (!color) continue
			if (scheme === 'light') light[name] = color
			else dark[name] = color
		}
	}

	return { light, dark, radiusRem }
}

// MARK: - Lightweight CSS scanning

export interface CssRuleBlock {
	readonly selector: string
	readonly body: string
}

export function cssRuleBlocks(css: string): CssRuleBlock[] {
	const blocks: CssRuleBlock[] = []
	let bodyStart: number | null = null
	let selector = ''
	let depth = 0

	for (let index = 0; index < css.length; index += 1) {
		const character = css[index]
		if (character === '{') {
			if (depth === 0) {
				selector = previousBoundary(css, index)
				bodyStart = index + 1
			}
			depth += 1
		} else if (character === '}') {
			depth -= 1
			if (depth <= 0) {
				if (bodyStart !== null) {
					blocks.push({ selector, body: css.slice(bodyStart, index) })
				}
				bodyStart = null
				depth = 0
			}
		}
	}

	return blocks
}

/** The selector before a `{`: text back to the previous `}` or `;`. */
function previousBoundary(css: string, before: number): string {
	let cursor = before
	while (cursor > 0) {
		const previous = css[cursor - 1]
		if (previous === '}' || previous === ';') break
		cursor -= 1
	}
	return css.slice(cursor, before).trim()
}

export function cssDeclarations(body: string): Array<[string, string]> {
	const result: Array<[string, string]> = []
	for (const statement of body.split(';')) {
		const separator = statement.indexOf(':')
		if (separator < 0) continue
		const name = statement.slice(0, separator).trim().replaceAll('--', '')
		const value = statement.slice(separator + 1).trim()
		if (name === '' || value === '') continue
		result.push([name, value])
	}
	return result
}

/** `0.625rem` / `10px` / `0.625` → rem, or `null` for an invalid radius. */
export function remValue(raw: string): number | null {
	const value = raw.trim().toLowerCase()
	let rem: number | null
	if (value.endsWith('rem')) {
		rem = parseSwiftDouble(value.slice(0, -3))
	} else if (value.endsWith('px')) {
		const px = parseSwiftDouble(value.slice(0, -2))
		rem = px === null ? null : px / 16
	} else {
		rem = parseSwiftDouble(value)
	}
	if (rem === null || !Number.isFinite(rem) || rem < 0) return null
	return rem
}

/** Neutral shadcn defaults, used when an organization has no theme or a token is missing. */
export const SITE_THEME_DEFAULT_HEX: Readonly<
	Record<SiteColorScheme, Readonly<Record<SiteColorToken, string>>>
> = {
	light: {
		background: '#ffffff',
		foreground: '#0a0a0a',
		card: '#ffffff',
		'card-foreground': '#0a0a0a',
		popover: '#ffffff',
		'popover-foreground': '#0a0a0a',
		primary: '#171717',
		'primary-foreground': '#fafafa',
		secondary: '#f5f5f5',
		'secondary-foreground': '#171717',
		muted: '#f5f5f5',
		'muted-foreground': '#737373',
		accent: '#f5f5f5',
		'accent-foreground': '#171717',
		destructive: '#e7000b',
		'destructive-foreground': '#ffffff',
		border: '#e5e5e5',
		input: '#e5e5e5',
		ring: '#a1a1a1',
	},
	dark: {
		background: '#0a0a0a',
		foreground: '#fafafa',
		card: '#171717',
		'card-foreground': '#fafafa',
		popover: '#171717',
		'popover-foreground': '#fafafa',
		primary: '#e5e5e5',
		'primary-foreground': '#171717',
		secondary: '#262626',
		'secondary-foreground': '#fafafa',
		muted: '#262626',
		'muted-foreground': '#a1a1a1',
		accent: '#404040',
		'accent-foreground': '#fafafa',
		destructive: '#ff6467',
		'destructive-foreground': '#ffffff',
		border: '#ffffff1a',
		input: '#ffffff26',
		ring: '#737373',
	},
}

export function siteThemeDefaultColor(
	token: SiteColorToken,
	scheme: SiteColorScheme,
): RgbaColor {
	return parseCssColor(SITE_THEME_DEFAULT_HEX[scheme][token]) ?? BLACK
}
