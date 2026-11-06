import { describe, expect, it } from 'vitest'
import { sanitizeInlineHtml, sanitizeSvg } from './sanitize-markup'

describe('sanitizeSvg', () => {
	it('keeps drawing markup, case included', () => {
		const icon =
			'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M13 2L3 14h8" /><linearGradient id="g"><stop offset="0" stop-color="#fff" /></linearGradient></svg>'
		const clean = sanitizeSvg(icon)
		expect(clean).toContain('viewBox="0 0 24 24"')
		expect(clean).toContain('<linearGradient id="g">')
		expect(clean).toContain('d="M13 2L3 14h8"')
	})

	it('strips script, handlers, foreignObject and links', () => {
		const clean = sanitizeSvg(
			'<svg onload="alert(1)"><script>alert(2)</script><foreignObject><img src=x onerror=alert(3)></foreignObject><a href="javascript:alert(4)"><path d="M0 0" onclick="x()" /></a><use href="https://evil.example/x.svg#a" /></svg>',
		)
		expect(clean).not.toMatch(
			/script|onload|onclick|onerror|foreignObject|javascript|<use|<img|href/i,
		)
		expect(clean).toBe('<svg><path d="M0 0"></path></svg>')
	})

	it('returns nothing for empty input', () => {
		expect(sanitizeSvg(undefined)).toBe('')
		expect(sanitizeSvg('  ')).toBe('')
	})
})

describe('sanitizeInlineHtml', () => {
	it('keeps inline formatting and safe links', () => {
		const clean = sanitizeInlineHtml(
			'<strong>New</strong> <a href="https://example.com/x">docs</a>',
		)
		expect(clean).toContain('<strong>New</strong>')
		expect(clean).toContain('href="https://example.com/x"')
		expect(clean).toContain('rel="noopener noreferrer"')
	})

	it('drops scripts, event handlers and javascript: links', () => {
		const clean = sanitizeInlineHtml(
			'<img src=x onerror=alert(1)><script>alert(2)</script><a href="javascript:alert(3)" onclick="x()">x</a><svg onload=alert(4)>',
		)
		expect(clean).not.toMatch(
			/script|onerror|onclick|onload|javascript|<img|<svg/i,
		)
	})
})
