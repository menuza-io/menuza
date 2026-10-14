import { describe, expect, it } from 'vitest'
import { sanitizeJobDescription } from './job-description-sanitize.server.ts'

describe('sanitizeJobDescription', () => {
	it('keeps the formatting a posting needs', () => {
		const html =
			'<h2>About</h2><p>We <strong>cook</strong> and <em>serve</em>.</p><ul><li>Fast</li></ul><ol><li>Fun</li></ol>'
		expect(sanitizeJobDescription(html)).toBe(html)
	})

	it('removes scripts, event handlers, styles, iframes and images', () => {
		const dirty =
			'<p onclick="x()">Hi<script>alert(1)</script></p><img src=x onerror=alert(1)><iframe src="https://evil.example"></iframe><p style="color:red">Red</p><style>p{}</style>'
		const clean = sanitizeJobDescription(dirty)
		expect(clean).toBe('<p>Hi</p><p>Red</p>')
	})

	it('drops unsafe link schemes and forces safe link attributes', () => {
		const clean = sanitizeJobDescription(
			'<p><a href="javascript:alert(1)">bad</a> <a href="https://acme.example/apply" onclick="x()" target="_self" rel="opener">good</a> <a href="data:text/html;base64,AAAA">data</a> <a href="//evil.example">proto</a></p>',
		)
		expect(clean).not.toMatch(/javascript:|data:|onclick|\/\/evil/)
		expect(clean).toContain(
			'<a href="https://acme.example/apply" target="_blank" rel="noopener noreferrer nofollow">good</a>',
		)
	})

	it('folds large headings into the two sizes pages style', () => {
		expect(sanitizeJobDescription('<h1>Big</h1><h4>Small</h4>')).toBe(
			'<h2>Big</h2><h3>Small</h3>',
		)
	})

	it('drops empty paragraphs and handles empty or non-string input', () => {
		expect(sanitizeJobDescription('<p></p><p> <br></p><p>Hi</p>')).toBe(
			'<p>Hi</p>',
		)
		expect(sanitizeJobDescription(null)).toBe('')
		expect(sanitizeJobDescription(undefined)).toBe('')
		expect(sanitizeJobDescription(42 as unknown as string)).toBe('')
	})

	it('survives nested and malformed markup', () => {
		const clean = sanitizeJobDescription(
			'<p><b><i>ok</p></i><scr<script>ipt>alert(1)</scr</script>ipt>',
		)
		expect(clean).not.toMatch(/<script|alert\(1\)<\//i)
	})
})
