import { toCssHexString } from './rgba-color'
import {
	FALLBACK_SITE_THEME,
	type SiteTheme,
	resolveColorScheme,
	siteFontFamily,
	siteThemeColor,
	siteThemeRadius,
} from './site-theme'
import { type SiteColorScheme, type SiteColorToken } from './site-theme-tokens'

/**
 * The organization theme resolved for one color scheme, as React Native color
 * strings (`#rrggbb` or `#rrggbbaa`). Use it where a class name cannot reach,
 * for example navigation options, the status bar or icon colors.
 */
export interface ThemePalette {
	readonly scheme: SiteColorScheme
	readonly background: string
	readonly foreground: string
	readonly card: string
	readonly cardForeground: string
	readonly muted: string
	readonly mutedForeground: string
	readonly primary: string
	readonly primaryForeground: string
	readonly accent: string
	readonly accentForeground: string
	readonly destructive: string
	readonly destructiveForeground: string
	readonly border: string
	readonly radius: number
	readonly headingFontFamily: string | null
	readonly bodyFontFamily: string | null
}

export type FontAvailability = (family: string) => boolean

export function createThemePalette(
	theme: SiteTheme,
	scheme: SiteColorScheme,
	isFontAvailable: FontAvailability = () => true,
): ThemePalette {
	const color = (token: SiteColorToken) =>
		toCssHexString(siteThemeColor(theme, token, scheme))
	const font = (family: string | null) =>
		family !== null && isFontAvailable(family) ? family : null

	return {
		scheme,
		background: color('background'),
		foreground: color('foreground'),
		card: color('card'),
		cardForeground: color('card-foreground'),
		muted: color('muted'),
		mutedForeground: color('muted-foreground'),
		primary: color('primary'),
		primaryForeground: color('primary-foreground'),
		accent: color('accent'),
		accentForeground: color('accent-foreground'),
		destructive: color('destructive'),
		destructiveForeground: color('destructive-foreground'),
		border: color('border'),
		radius: siteThemeRadius(theme),
		headingFontFamily: font(siteFontFamily(theme, 'heading')),
		bodyFontFamily: font(siteFontFamily(theme, 'body')),
	}
}

/** Resolves the organization theme against the device's current appearance. */
export function resolveThemePalette(
	theme: SiteTheme,
	systemIsDark: boolean,
	isFontAvailable?: FontAvailability,
): ThemePalette {
	return createThemePalette(
		theme,
		resolveColorScheme(theme, systemIsDark),
		isFontAvailable,
	)
}

/** Shown before branding loads. */
export const FALLBACK_THEME_PALETTE: ThemePalette = createThemePalette(
	FALLBACK_SITE_THEME,
	'light',
)
