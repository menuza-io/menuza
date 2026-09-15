import { describe, expect, it } from 'vitest'
import { sanitizeContentBody } from './sanitize.ts'

describe('sanitizeContentBody', () => {
	it('strips dangerous script tags', () => {
		const dirty = '<p>Hello <script>alert("xss")</script>world</p>'
		expect(sanitizeContentBody(dirty)).toBe('<p>Hello world</p>')
	})

	it('strips onerror and onclick handlers', () => {
		const dirty =
			'<img src="x" onerror="alert(1)">Click <a href="javascript:alert(1)">here</a>'
		expect(sanitizeContentBody(dirty)).toBe('Click <a>here</a>')
	})

	it('preserves valid safe formatting and links', () => {
		const clean =
			'<h2>Title</h2><p>This is <strong>bold</strong> and <a href="https://example.com">a link</a>.</p>'
		expect(sanitizeContentBody(clean)).toBe(clean)
	})

	it('handles null and undefined', () => {
		expect(sanitizeContentBody(null)).toBe('')
		expect(sanitizeContentBody(undefined)).toBe('')
		expect(sanitizeContentBody('')).toBe('')
	})
})
