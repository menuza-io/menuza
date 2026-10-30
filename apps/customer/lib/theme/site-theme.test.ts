import { WHITE, relativeLuminance } from './rgba-color'
import {
	type PublicSiteTheme,
	FALLBACK_SITE_THEME,
	createSiteTheme,
	parsePublicSiteTheme,
	preferredColorScheme,
	resolveColorScheme,
	siteFontFamily,
	siteThemeColor,
	siteThemeFromPayload,
	siteThemeRadius,
} from './site-theme'
import {
	SITE_COLOR_TOKENS,
	parseSiteThemeCss,
	siteThemeDefaultColor,
	tokenColor,
} from './site-theme-tokens'

function expectClose(actual: number, expected: number, tolerance: number) {
	expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance)
}

/** Shape produced by `buildSiteThemeCss()` for an organization using the blue theme. */
const css = `html {
\t--background: oklch(1 0 0);
\t--foreground: oklch(0.145 0 0);
\t--primary: oklch(0.205 0 0);
\t--primary-foreground: oklch(0.985 0 0);
\t--border: oklch(0.922 0 0);
\t--radius: 0.625rem;
}

html.dark {
\t--background: oklch(0.145 0 0);
\t--foreground: oklch(0.985 0 0);
\t--primary: oklch(0.488 0.243 264.376);
\t--primary-foreground: oklch(0.97 0.014 254.604);
\t--radius: 0.625rem;
}`

function publicTheme(overrides: PublicSiteTheme): PublicSiteTheme {
	return {
		baseColor: 'neutral',
		theme: 'blue',
		radius: 'default',
		mode: 'system',
		headingFont: 'inter',
		bodyFont: 'inter',
		headingCustomFont: null,
		bodyCustomFont: null,
		css,
		...overrides,
	}
}

describe('parseSiteThemeCss (ported from SiteThemeTests.swift)', () => {
	it('parses light and dark tokens', () => {
		const tokens = parseSiteThemeCss(css)
		expectClose(tokens.light.background?.red ?? 0, 1, 0.002)
		expectClose(tokens.light.foreground?.red ?? 0, 0.039388, 0.002)
		expect(tokens.dark.primary).toBeDefined()
		expectClose(tokens.dark.foreground?.red ?? 0, 0.980256, 0.002)
		expectClose(tokens.radiusRem ?? 0, 0.625, 0.0001)
	})

	it('parses the radius in pixels', () => {
		expectClose(
			parseSiteThemeCss('html { --radius: 12px; }').radiusRem ?? 0,
			0.75,
			0.0001,
		)
	})

	it('rejects invalid radius values', () => {
		expect(parseSiteThemeCss('html { --radius: -5rem; }').radiusRem).toBeNull()
		expect(parseSiteThemeCss('html { --radius: nanrem; }').radiusRem).toBeNull()
		expect(parseSiteThemeCss('html { --radius: -8px; }').radiusRem).toBeNull()
		expect(parseSiteThemeCss('html { --radius: 0rem; }').radiusRem).toBe(0)
	})

	it('ignores unknown color spaces', () => {
		const tokens = parseSiteThemeCss(
			'html { --primary: color(display-p3 1 0 0); --ring: #ff0000; }',
		)
		expect(tokens.light.primary).toBeUndefined()
		expect(tokens.light.ring).toBeDefined()
	})
})

describe('parseSiteThemeCss details', () => {
	it('ignores selectors other than html and :root (Android test)', () => {
		expect(
			parseSiteThemeCss('body { --primary: #ff0000; }').light.primary,
		).toBeUndefined()
	})

	it('reads :root and [data-theme] dark blocks', () => {
		const tokens = parseSiteThemeCss(
			":root { --ring: #ff0000; } :root[data-theme='dark'] { --ring: #00ff00; }",
		)
		expect(tokens.light.ring?.red).toBe(1)
		expect(tokens.dark.ring?.green).toBe(1)
	})

	it('prefers the light radius and uses a dark radius only without one', () => {
		expect(
			parseSiteThemeCss(
				'html.dark { --radius: 1rem; } html { --radius: 0.5rem; }',
			).radiusRem,
		).toBe(0.5)
		expect(
			parseSiteThemeCss(
				'html { --radius: 0.5rem; } html.dark { --radius: 1rem; }',
			).radiusRem,
		).toBe(0.5)
		expect(parseSiteThemeCss('html.dark { --radius: 1rem; }').radiusRem).toBe(1)
		expect(parseSiteThemeCss('html { --radius: 0.5; }').radiusRem).toBe(0.5)
	})

	it('keeps the previous radius when a later one is invalid', () => {
		expect(
			parseSiteThemeCss('html { --radius: 0.5rem; } html { --radius: big; }')
				.radiusRem,
		).toBe(0.5)
	})

	it('skips nested blocks and tolerates broken css', () => {
		expect(parseSiteThemeCss('').radiusRem).toBeNull()
		expect(
			parseSiteThemeCss('}}} html { --ring: #fff').light.ring,
		).toBeUndefined()
		const nested = parseSiteThemeCss(
			'@media (prefers-color-scheme: dark) { html { --ring: #fff; } }',
		)
		expect(nested.light.ring).toBeUndefined()
	})

	it('falls back per token to the defaults', () => {
		const tokens = parseSiteThemeCss(css)
		expect(tokenColor(tokens, 'ring', 'light')).toEqual(
			siteThemeDefaultColor('ring', 'light'),
		)
	})
})

describe('SiteTheme (ported from SiteThemeTests.swift)', () => {
	it('falls back to neutral defaults', () => {
		const theme = createSiteTheme(null)
		expect(siteThemeColor(theme, 'background', 'light')).toEqual(WHITE)
		expect(
			relativeLuminance(siteThemeColor(theme, 'background', 'dark')),
		).toBeLessThan(0.2)
	})

	it('resolves the theme mode', () => {
		const dark = createSiteTheme(publicTheme({ mode: 'dark' }))
		expect(resolveColorScheme(dark, false)).toBe('dark')

		const system = createSiteTheme(publicTheme({ mode: 'system' }))
		expect(resolveColorScheme(system, false)).toBe('light')
		expect(resolveColorScheme(system, true)).toBe('dark')
		expect(preferredColorScheme(system)).toBeNull()
	})

	it('scales the radius like the Tailwind tokens', () => {
		const theme = createSiteTheme(
			publicTheme({ theme: 'neutral', mode: 'light' }),
		)
		expectClose(siteThemeRadius(theme), 10, 0.01)
		expectClose(siteThemeRadius(theme, 0.7), 7, 0.01)
	})

	it('maps Sites font ids to font families', () => {
		const theme = createSiteTheme(
			publicTheme({
				theme: 'neutral',
				mode: 'light',
				headingFont: 'space-grotesk',
				bodyFont: 'ibm-plex-sans',
			}),
		)
		expect(siteFontFamily(theme, 'heading')).toBe('Space Grotesk')
		expect(siteFontFamily(theme, 'body')).toBe('IBM Plex Sans')
	})
})

describe('SiteTheme details', () => {
	it('uses defaults for empty fields', () => {
		const theme = createSiteTheme({ mode: '', headingFont: '', bodyFont: '' })
		expect(theme.mode).toBe('system')
		expect(theme.headingFontId).toBe('inter')
		expect(theme.bodyFontId).toBe('inter')
		expect(FALLBACK_SITE_THEME.mode).toBe('system')
		expect(siteThemeRadius(FALLBACK_SITE_THEME)).toBe(10)
		expect(siteFontFamily(FALLBACK_SITE_THEME, 'body')).toBe('Inter')
	})

	it('resolves the mode case-insensitively and treats unknown modes as system', () => {
		expect(resolveColorScheme(createSiteTheme({ mode: 'DARK' }), false)).toBe(
			'dark',
		)
		expect(resolveColorScheme(createSiteTheme({ mode: 'Light' }), true)).toBe(
			'light',
		)
		expect(resolveColorScheme(createSiteTheme({ mode: 'sepia' }), true)).toBe(
			'dark',
		)
	})

	it('converts the radius to points (Android test)', () => {
		const theme = createSiteTheme({ css: 'html { --radius: 0.5rem; }' })
		expectClose(siteThemeRadius(theme), 8, 0.0001)
		expectClose(siteThemeRadius(theme, 0.7), 5.6, 0.0001)
	})

	it('returns null for unknown font ids', () => {
		const theme = createSiteTheme({
			headingFont: 'comic-sans',
			bodyFont: 'constructor',
		})
		expect(siteFontFamily(theme, 'heading')).toBeNull()
		expect(siteFontFamily(theme, 'body')).toBeNull()
	})

	it('keeps custom font urls only when not blank', () => {
		const theme = createSiteTheme({
			headingCustomFont: { url: 'https://cdn.test/a.woff2', format: 'woff2' },
			bodyCustomFont: { url: '   ', format: 'woff2' },
		})
		expect(theme.headingCustomFontUrl).toBe('https://cdn.test/a.woff2')
		expect(theme.bodyCustomFontUrl).toBeNull()
	})

	it('covers every token with a default in both schemes', () => {
		for (const token of SITE_COLOR_TOKENS) {
			expect(siteThemeColor(FALLBACK_SITE_THEME, token, 'light')).toEqual(
				siteThemeDefaultColor(token, 'light'),
			)
		}
	})
})

describe('parsePublicSiteTheme', () => {
	it('returns null for anything that is not an object', () => {
		for (const value of [undefined, null, 'theme', 42, true, [], [{ css }]]) {
			expect(parsePublicSiteTheme(value)).toBeNull()
		}
	})

	it('reads every field of a well-formed payload', () => {
		expect(
			parsePublicSiteTheme({
				baseColor: 'neutral',
				theme: 'blue',
				radius: 'default',
				mode: 'dark',
				headingFont: 'lora',
				bodyFont: 'inter',
				headingCustomFont: { url: 'https://cdn.test/h.woff2', format: 'woff2' },
				bodyCustomFont: null,
				css,
			}),
		).toEqual({
			baseColor: 'neutral',
			theme: 'blue',
			radius: 'default',
			mode: 'dark',
			headingFont: 'lora',
			bodyFont: 'inter',
			headingCustomFont: { url: 'https://cdn.test/h.woff2', format: 'woff2' },
			bodyCustomFont: null,
			css,
		})
	})

	it('treats fields of the wrong type as missing', () => {
		const parsed = parsePublicSiteTheme({
			mode: 5,
			css: { light: {} },
			headingFont: ['inter'],
			headingCustomFont: { url: 3 },
			bodyCustomFont: 'https://cdn.test/b.woff2',
		})
		expect(parsed).toEqual({
			baseColor: null,
			theme: null,
			radius: null,
			mode: null,
			headingFont: null,
			bodyFont: null,
			headingCustomFont: null,
			bodyCustomFont: null,
			css: null,
		})
		const theme = createSiteTheme(parsed)
		expect(theme).toEqual(FALLBACK_SITE_THEME)
	})

	it('defaults a missing custom font format', () => {
		expect(
			parsePublicSiteTheme({
				bodyCustomFont: { url: 'https://cdn.test/b.ttf' },
			})?.bodyCustomFont,
		).toEqual({ url: 'https://cdn.test/b.ttf', format: 'woff2' })
	})

	it('turns a payload straight into a theme', () => {
		expect(siteThemeFromPayload('nope')).toEqual(FALLBACK_SITE_THEME)
		const theme = siteThemeFromPayload({ mode: 'dark', css })
		expect(resolveColorScheme(theme, false)).toBe('dark')
		expectClose(theme.tokens.dark.foreground?.red ?? 0, 0.980256, 0.002)
	})
})
