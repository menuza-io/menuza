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
	it('demotes an editor h1 to h2 so the page keeps one h1', () => {
		const html = renderLexicalContent(
			doc({ type: 'heading', tag: 'h1', children: [{ text: 'Title' }] }),
		)

		expect(html).toMatch(/^<h2 /)
		expect(html).not.toContain('<h1')
	})

	it('keeps link text and only links to safe targets', () => {
		const link = (url: string) => ({
			type: 'link',
			url,
			children: [{ text: 'Read more' }],
		})
		const html = renderLexicalContent(
			doc(
				{ type: 'paragraph', children: [link('https://example.com/a?b="c')] },
				{ type: 'paragraph', children: [link('javascript:alert(1)')] },
			),
		)

		expect(html).toContain('href="https://example.com/a?b=&quot;c"')
		expect(html).not.toContain('javascript:')
		expect(html.match(/Read more/g)).toHaveLength(2)
	})

	it('escapes the label of a link whose target is rejected', () => {
		const html = renderLexicalContent(
			doc({
				type: 'paragraph',
				children: [
					{
						type: 'link',
						url: 'javascript:alert(1)',
						children: [{ text: '<img src=x onerror=alert(1)>' }],
					},
				],
			}),
		)

		expect(html).not.toContain('<img')
		expect(html).not.toContain('<a ')
		expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
	})

	it('returns nothing for content whose children are not arrays', () => {
		expect(renderLexicalContent({ root: { children: { a: 1 } } })).toBe('')
		expect(renderLexicalContent({ root: { children: 'x' } })).toBe('')
		expect(
			renderLexicalContent(doc({ type: 'paragraph', children: { a: 1 } })),
		).toContain('<p')
	})
})
