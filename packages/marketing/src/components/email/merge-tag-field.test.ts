// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'

import { mergeHtmlToValue, mergeValueToHtml } from './merge-tag-field.tsx'

function editorWithHtml(html: string): HTMLElement {
	const editor = document.createElement('div')
	editor.innerHTML = html
	return editor
}

describe('mergeTagField serialization', () => {
	it('renders tokens as chips and escapes surrounding text', () => {
		const html = mergeValueToHtml('Hey {{firstName|there}}, <b>welcome</b>')
		expect(html).toContain('data-merge-tag="firstName"')
		expect(html).toContain('data-merge-fallback="there"')
		expect(html).toContain('&lt;b&gt;welcome&lt;/b&gt;')
		expect(html).not.toContain('<b>')
	})

	it('labels a chip with the human tag name', () => {
		expect(mergeValueToHtml('{{firstName}}')).toContain('>First name<')
		expect(mergeValueToHtml('{{customKey}}')).toContain('>customKey<')
	})

	it('round-trips chips back to tokens', () => {
		const value = 'Hey {{firstName|there}}, welcome to {{organizationName}}!'
		const editor = editorWithHtml(mergeValueToHtml(value))
		expect(mergeHtmlToValue(editor)).toBe(value)
	})

	it('preserves plain text and newlines', () => {
		const editor = editorWithHtml(
			`${mergeValueToHtml('line one')}<br>${mergeValueToHtml('line two')}`,
		)
		expect(mergeHtmlToValue(editor)).toBe('line one\nline two')
	})

	it('ignores formatting elements and keeps their text', () => {
		const editor = editorWithHtml('<span>bold <b>text</b></span>')
		expect(mergeHtmlToValue(editor)).toBe('bold text')
	})

	it('handles an empty editor', () => {
		expect(mergeHtmlToValue(editorWithHtml(''))).toBe('')
		expect(mergeValueToHtml('')).toBe('')
	})
})
