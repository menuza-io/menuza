import { describe, expect, it } from 'vitest'
import { fontFaceCss } from './theme.ts'
import { type PublicSiteTheme } from './types.ts'

const theme = (over: Partial<PublicSiteTheme> = {}): PublicSiteTheme => ({
	baseColor: 'stone',
	theme: 't',
	radius: '1rem',
	mode: 'light',
	css: '',
	...over,
})

describe('fontFaceCss', () => {
	it('emits a font face for an uploaded font at an https address', () => {
		const css = fontFaceCss(
			theme({
				headingCustomFont: {
					url: 'https://cdn.example.com/h.woff2',
					format: 'woff2',
				},
			}),
		)
		expect(css).toContain("font-family:'SiteHeading'")
		expect(css).toContain("url('https://cdn.example.com/h.woff2')")
		expect(css).toContain("format('woff2')")
	})

	it('allows a path on the same host', () => {
		expect(
			fontFaceCss(
				theme({ bodyCustomFont: { url: '/uploads/b.woff', format: 'woff' } }),
			),
		).toContain("url('/uploads/b.woff')")
	})

	it('cannot be broken out of: whatever the URL holds stays inside one string literal', () => {
		const skeleton = (css: string) => css.replace(/'(?:[^'\\]|\\.)*'/g, 'S')
		const attacks = [
			"https://x.example/a.woff2');}body{display:none}@font-face{src:url('",
			"https://x.example/a'\n}x{",
			'https://x.example/a\\',
			"https://x.example/a\u2028'}",
		]
		for (const url of attacks) {
			const css = fontFaceCss(
				theme({ headingCustomFont: { url, format: 'woff2' } }),
			)
			// With every string literal masked, only the intended single rule is left.
			expect({ url, shape: skeleton(css) }).toEqual({
				url,
				shape:
					'@font-face{font-family:S;src:url(S) format(S);font-display:swap}',
			})
			expect(css).not.toContain('\n')
		}
	})

	it('refuses other schemes and protocol-relative addresses', () => {
		for (const url of [
			'javascript:alert(1)',
			'data:font/woff2;base64,AAAA',
			'file:///etc/passwd',
			'//evil.example/f.woff2',
			'ftp://x/f.woff2',
		]) {
			expect({
				url,
				css: fontFaceCss(
					theme({ headingCustomFont: { url, format: 'woff2' } }),
				),
			}).toEqual({ url, css: '' })
		}
	})

	it('refuses a format outside the known list', () => {
		expect(
			fontFaceCss(
				theme({
					headingCustomFont: {
						url: 'https://x.example/f',
						format: "woff2') x('",
					},
				}),
			),
		).toBe('')
	})

	it('is empty with no custom fonts', () => {
		expect(fontFaceCss(theme())).toBe('')
	})
})
