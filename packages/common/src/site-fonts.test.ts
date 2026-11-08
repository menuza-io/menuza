import { describe, expect, it } from 'vitest'
import { buildCustomSiteFontFaceCss } from './site-fonts.ts'

describe('buildCustomSiteFontFaceCss', () => {
	it('builds a face for a valid url and format', () => {
		const css = buildCustomSiteFontFaceCss({
			headingUrl: '/resources/fonts?objectKey=org/a/site-fonts/x.woff2',
			headingFormat: 'woff2',
		})
		expect(css).toContain('format("woff2")')
	})

	it('cannot close the raw-text <style> element through the url', () => {
		const css = buildCustomSiteFontFaceCss({
			headingUrl: '</style><b id=x>',
			headingFormat: 'woff2',
			bodyUrl: '</STYLE><script>',
			bodyFormat: 'woff2',
		})
		expect(css).not.toContain('<')
	})

	it('drops a face whose format is not a known font format', () => {
		const css = buildCustomSiteFontFaceCss({
			headingUrl: '/f.woff2',
			headingFormat: 'woff2"); </style><b id=x>' as never,
		})
		expect(css).toBe('')
	})
})
