import { describe, expect, it } from 'vitest'

import { renderLexicalContent } from '../src/lib/lexical-html'

const doc = (...children: unknown[]) => ({ root: { children } })

describe('renderLexicalContent', () => {
	it('escapes markup in paragraph text so it renders as text', () => {
		const html = renderLexicalContent(
			doc({
				type: 'paragraph',
				children: [{ text: '<img src=x onerror=alert(1)>' }],
			}),
		)

		expect(html).not.toContain('<img')
		expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
	})

	it('escapes formatted, heading, list and quote text', () => {
		const payload = '"><script>alert(1)</script>'
		const html = renderLexicalContent(
			doc(
				{ type: 'paragraph', children: [{ text: payload, format: 3 }] },
				{ type: 'heading', tag: 'h2', children: [{ text: payload }] },
				{
					type: 'list',
					listType: 'bullet',
					children: [{ type: 'listitem', children: [{ text: payload }] }],
				},
				{ type: 'quote', children: [{ text: payload }] },
			),
		)

		expect(html).not.toContain('<script')
		expect(html.match(/&lt;script&gt;/g)).toHaveLength(4)
	})

	it('limits the heading tag to h1-h6', () => {
		const html = renderLexicalContent(
			doc({
				type: 'heading',
				tag: 'img src=x onerror=alert(1)',
				children: [{ text: 'Title' }],
			}),
		)

		expect(html).toMatch(/^<h2 /)
		expect(html).not.toContain('onerror')
	})

	it('keeps bold and italic formatting', () => {
		const html = renderLexicalContent(
			doc({ type: 'paragraph', children: [{ text: 'Hi', format: 3 }] }),
		)

		expect(html).toContain('<strong')
		expect(html).toContain('<em')
		expect(html).toContain('Hi')
	})
})
