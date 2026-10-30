import { FALLBACK_SITE_THEME, createSiteTheme } from './site-theme'
import {
	FALLBACK_THEME_PALETTE,
	createThemePalette,
	resolveThemePalette,
} from './theme-palette'

describe('ThemePalette', () => {
	it('falls back to the neutral light palette', () => {
		expect(FALLBACK_THEME_PALETTE).toEqual({
			scheme: 'light',
			background: '#ffffff',
			foreground: '#0a0a0a',
			card: '#ffffff',
			cardForeground: '#0a0a0a',
			muted: '#f5f5f5',
			mutedForeground: '#737373',
			primary: '#171717',
			primaryForeground: '#fafafa',
			accent: '#f5f5f5',
			accentForeground: '#171717',
			destructive: '#e7000b',
			destructiveForeground: '#ffffff',
			border: '#e5e5e5',
			radius: 10,
			headingFontFamily: 'Inter',
			bodyFontFamily: 'Inter',
		})
	})

	it('keeps alpha in the dark border', () => {
		expect(createThemePalette(FALLBACK_SITE_THEME, 'dark').border).toBe(
			'#ffffff1a',
		)
	})

	it('resolves the scheme from the theme mode and the system appearance', () => {
		const system = createSiteTheme({ css: 'html.dark { --primary: #ff0000; }' })
		expect(resolveThemePalette(system, true).primary).toBe('#ff0000')
		expect(resolveThemePalette(system, false).primary).toBe('#171717')
		const light = createSiteTheme({ mode: 'light' })
		expect(resolveThemePalette(light, true).scheme).toBe('light')
	})

	it('drops fonts that are not available', () => {
		const theme = createSiteTheme({ headingFont: 'lora', bodyFont: 'inter' })
		const palette = createThemePalette(
			theme,
			'light',
			(family) => family === 'Lora',
		)
		expect(palette.headingFontFamily).toBe('Lora')
		expect(palette.bodyFontFamily).toBeNull()
		expect(
			createThemePalette(createSiteTheme({ bodyFont: 'x' }), 'light')
				.bodyFontFamily,
		).toBeNull()
	})

	it('uses the theme radius', () => {
		expect(
			createThemePalette(
				createSiteTheme({ css: 'html { --radius: 1rem; }' }),
				'light',
			).radius,
		).toBe(16)
	})
})
