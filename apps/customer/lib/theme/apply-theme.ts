import { Uniwind } from 'uniwind'
import { type SiteTheme } from './site-theme'
import { SITE_COLOR_SCHEMES } from './site-theme-tokens'
import { type ThemeVariables, buildThemeVariables } from './theme-variables'

/** The part of Uniwind's runtime API the theme needs; injectable for tests. */
export interface UniwindThemeRuntime {
	updateCSSVariables(
		theme: 'light' | 'dark',
		variables: Record<string, string | number>,
	): void
	setTheme(theme: 'light' | 'dark' | 'system'): void
}

/**
 * Pushes the organization's colors and radii into both Uniwind themes, then
 * selects the theme the organization forces (or the system appearance).
 */
export function applySiteTheme(
	theme: SiteTheme,
	runtime: UniwindThemeRuntime = Uniwind,
): ThemeVariables {
	const variables = buildThemeVariables(theme)
	for (const scheme of SITE_COLOR_SCHEMES) {
		runtime.updateCSSVariables(scheme, {
			...variables[scheme],
			...variables.radii,
		})
	}
	runtime.setTheme(variables.mode)
	return variables
}
