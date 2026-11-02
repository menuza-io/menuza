import { describe, expect, it } from 'vitest'
import { buildSiteThemeCss, DEFAULT_SITE_THEME } from './site-theme'

describe('buildSiteThemeCss cssVars hardening', () => {
	it('drops overrides that could break out of the style element', () => {
		const css = buildSiteThemeCss({
			...DEFAULT_SITE_THEME,
			cssVars: {
				primary: 'oklch(0.5 0.1 200)',
				'x</style><script>alert(1)</script>': 'red',
				background: 'red;}</style><script>alert(1)</script>',
				foreground: 'url(https://evil.example/x)',
			},
		})
		expect(css).toContain('oklch(0.5 0.1 200)')
		expect(css).not.toContain('<script')
		expect(css).not.toContain('</style')
		expect(css).not.toContain('evil.example')
	})
})

describe('buildSiteThemeCss cssVars edge cases', () => {
	it('drops a value that smuggles a rule break after a newline', () => {
		const css = buildSiteThemeCss({
			...DEFAULT_SITE_THEME,
			cssVars: { primary: 'red\n}\nbody{display:none' },
		})
		expect(css).not.toContain('display:none')
	})

	it('drops keys that are not plain token names', () => {
		const css = buildSiteThemeCss({
			...DEFAULT_SITE_THEME,
			cssVars: { 'primary: red; --x': 'blue', 'a b': 'blue', '': 'blue' },
		})
		expect(css).not.toContain('--primary: red; --x')
		expect(css).not.toContain('--a b')
	})
})
