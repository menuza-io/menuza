import { toCssHexString } from './rgba-color'
import {
	type SiteTheme,
	preferredColorScheme,
	siteFontFamily,
	siteThemeColor,
	siteThemeRadius,
} from './site-theme'
import {
	SITE_COLOR_TOKENS,
	type SiteColorScheme,
	type SiteColorToken,
} from './site-theme-tokens'

export type ThemeColorVariable = `--color-${SiteColorToken}`

export const THEME_COLOR_VARIABLES: readonly ThemeColorVariable[] =
	SITE_COLOR_TOKENS.map((token) => `--color-${token}` as const)

export type ThemeRadiusVariable =
	'--radius-sm' | '--radius-md' | '--radius-lg' | '--radius-xl'

export interface ThemeVariables {
	readonly light: Readonly<Record<ThemeColorVariable, string>>
	readonly dark: Readonly<Record<ThemeColorVariable, string>>
	/** Sites `--radius` in px (rem × 16); 10 when the theme has none. */
	readonly radius: number
	/** The `--radius-*` scale in `app/global.css`, derived like shadcn's. */
	readonly radii: Readonly<Record<ThemeRadiusVariable, number>>
	readonly fonts: {
		readonly heading: string | null
		readonly body: string | null
	}
	/** The scheme the organization forces, or `system` to follow the device. */
	readonly mode: SiteColorScheme | 'system'
}

function colorVariables(
	theme: SiteTheme,
	scheme: SiteColorScheme,
): Record<ThemeColorVariable, string> {
	const variables = {} as Record<ThemeColorVariable, string>
	for (const token of SITE_COLOR_TOKENS) {
		variables[`--color-${token}`] = toCssHexString(
			siteThemeColor(theme, token, scheme),
		)
	}
	return variables
}

export function radiusScale(
	radius: number,
): Record<ThemeRadiusVariable, number> {
	return {
		'--radius-sm': Math.max(radius - 4, 0),
		'--radius-md': Math.max(radius - 2, 0),
		'--radius-lg': radius,
		'--radius-xl': radius + 4,
	}
}

/**
 * Everything the app pushes into Uniwind for an organization theme. Tokens the
 * theme leaves out (or cannot be parsed) use the neutral defaults, which are
 * also the values in `app/global.css`.
 */
export function buildThemeVariables(theme: SiteTheme): ThemeVariables {
	const radius = siteThemeRadius(theme)
	return {
		light: colorVariables(theme, 'light'),
		dark: colorVariables(theme, 'dark'),
		radius,
		radii: radiusScale(radius),
		fonts: {
			heading: siteFontFamily(theme, 'heading'),
			body: siteFontFamily(theme, 'body'),
		},
		mode: preferredColorScheme(theme) ?? 'system',
	}
}
