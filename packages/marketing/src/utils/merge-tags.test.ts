import { resolveEmailTheme } from '@repo/common/email-theme'
import { describe, expect, it } from 'vitest'

import { renderMarketingEmail } from '../server/email-render.server'
import {
	escapeHtml,
	interpolateMergeTags,
	interpolateMergeTagsHtml,
} from './merge-tags'

describe('merge tag interpolation', () => {
	it('substitutes raw values for plaintext', () => {
		expect(interpolateMergeTags('Hi {{name}}', { name: 'A & B' })).toBe(
			'Hi A & B',
		)
	})

	it('escapes substituted values for html', () => {
		expect(
			interpolateMergeTagsHtml('<p>Hi {{name}}</p>', {
				name: '<script>alert(1)</script>',
			}),
		).toBe('<p>Hi &lt;script&gt;alert(1)&lt;/script&gt;</p>')
	})

	it('leaves unknown tags empty', () => {
		expect(interpolateMergeTagsHtml('<p>{{missing}}</p>', {})).toBe('<p></p>')
	})

	it('escapes each dangerous character', () => {
		expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;')
	})

	it('uses a fallback when the value is missing', () => {
		expect(
			interpolateMergeTags('Hey {{firstName|there}}', { firstName: '' }),
		).toBe('Hey there')
		expect(
			interpolateMergeTags('Hey {{firstName|there}}', { firstName: 'Alex' }),
		).toBe('Hey Alex')
	})

	it('uses the fallback for unknown tags and clears them otherwise', () => {
		expect(interpolateMergeTags('{{missing|fallback}}', {})).toBe('fallback')
		expect(interpolateMergeTags('{{missing}}', {})).toBe('')
	})

	it('escapes both the value and the fallback in html output', () => {
		expect(
			interpolateMergeTagsHtml('<p>{{firstName|a<b}}</p>', { firstName: '' }),
		).toBe('<p>a&lt;b</p>')
		expect(
			interpolateMergeTagsHtml('<p>{{firstName|there}}</p>', {
				firstName: '<script>',
			}),
		).toBe('<p>&lt;script&gt;</p>')
	})

	it('escapes the fallback of a designed email once', async () => {
		// React escapes the fallback when the email is designed.
		const { html } = await renderMarketingEmail({
			blocks: [
				{
					id: 'block-1',
					type: 'body',
					config: { text: `Hey {{firstName|friend's & co}}` },
				},
			],
			theme: resolveEmailTheme({ organizationName: 'Acme' }),
		})
		expect(html).toContain('{{firstName|friend&#x27;s &amp; co}}')

		const sent = interpolateMergeTagsHtml(html, { firstName: '' })
		expect(sent).toContain('Hey friend&#39;s &amp; co')
		expect(sent).not.toContain('&amp;amp;')
		expect(sent).not.toContain('&amp;#x27;')
	})

	it('treats an escaped and a raw fallback alike', () => {
		const escaped = '<p>{{firstName|a &lt;b&gt; &amp; &quot;c&quot;}}</p>'
		const raw = '<p>{{firstName|a <b> & "c"}}</p>'
		const expected = '<p>a &lt;b&gt; &amp; &quot;c&quot;</p>'
		expect(interpolateMergeTagsHtml(escaped, { firstName: '' })).toBe(expected)
		expect(interpolateMergeTagsHtml(raw, { firstName: '' })).toBe(expected)
		expect(interpolateMergeTagsHtml('{{missing|&lt;i&gt;}}', {})).toBe(
			'&lt;i&gt;',
		)
	})

	it('escapes recipient values as they are, entities included', () => {
		expect(
			interpolateMergeTagsHtml('<p>{{firstName|friend}}</p>', {
				firstName: 'AT&amp;T <b>',
			}),
		).toBe('<p>AT&amp;amp;T &lt;b&gt;</p>')
	})

	it('decodes a double-encoded fallback only once', () => {
		// One unescape pass turns `&amp;lt;` into `&lt;` (text), which is then
		// escaped again, so the reader sees `&lt;script&gt;`, never a tag.
		expect(
			interpolateMergeTagsHtml('<p>{{firstName|&amp;lt;script&amp;gt;}}</p>', {
				firstName: '',
			}),
		).toBe('<p>&amp;lt;script&amp;gt;</p>')
		// Numeric references are not unescaped at all, so `&` is escaped.
		expect(
			interpolateMergeTagsHtml('<p>{{firstName|&#x3C;script&#x3E;}}</p>', {
				firstName: '',
			}),
		).toBe('<p>&amp;#x3C;script&amp;#x3E;</p>')
		expect(
			interpolateMergeTagsHtml('<p>{{firstName|&#60;script&#62;}}</p>', {
				firstName: '',
			}),
		).toBe('<p>&amp;#60;script&amp;#62;</p>')
		for (const fallback of [
			'&amp;lt;script&amp;gt;',
			'&#x3C;script&#x3E;',
			'&#60;script&#62;',
			'&amp;amp;lt;script&amp;amp;gt;',
		]) {
			const html = interpolateMergeTagsHtml(
				`<p>{{firstName|${fallback}}}</p>`,
				{
					firstName: '',
				},
			)
			expect(html).not.toMatch(/<script/i)
			expect(html.slice(3, -4)).not.toMatch(/[<>"']/)
		}
	})
})

describe('merge tags in URL attributes', () => {
	const unsafe = [
		'javascript:alert(1)',
		'JavaScript:alert(1)',
		'  javascript:alert(1)',
		'java\tscript:alert(1)',
		'java\nscript:alert(1)',
		'\u0001javascript:alert(1)',
		'data:text/html;base64,PHNjcmlwdD4=',
		'vbscript:msgbox(1)',
		'VBScript:msgbox(1)',
	]

	for (const value of unsafe) {
		it(`refuses ${JSON.stringify(value)} in href and src`, () => {
			const href = interpolateMergeTagsHtml('<a href="{{name}}">x</a>', {
				name: value,
			})
			expect(href).toBe('<a href="">x</a>')
			const src = interpolateMergeTagsHtml("<img src='{{name}}'>", {
				name: value,
			})
			expect(src).toBe("<img src=''>")
		})
	}

	it('refuses an unsafe fallback in a URL attribute', () => {
		// Decoded once, this fallback is the text `javascript&colon;...`, which
		// is escaped again: the browser reads a relative path, not a scheme.
		expect(
			interpolateMergeTagsHtml(
				'<a href="{{website|javascript&amp;colon;alert(1)}}">x</a>',
				{},
			),
		).toBe('<a href="javascript&amp;colon;alert(1)">x</a>')
		expect(
			interpolateMergeTagsHtml(
				'<a href="{{website|javascript:alert(1)}}">x</a>',
				{},
			),
		).toBe('<a href="">x</a>')
		expect(
			interpolateMergeTagsHtml(
				'<a href="{{website|jav&#x61;script:x}}">x</a>',
				{},
			),
		).toBe('<a href="">x</a>')
	})

	it('refuses a template whose own text makes the scheme unsafe', () => {
		expect(
			interpolateMergeTagsHtml('<a href="jav&#x61;script:{{name}}">x</a>', {
				name: 'alert(1)',
			}),
		).toBe('<a href="">x</a>')
		expect(
			interpolateMergeTagsHtml('<a href="javascript&colon;{{name}}">x</a>', {
				name: 'alert(1)',
			}),
		).toBe('<a href="">x</a>')
	})

	it('keeps http, https, mailto, tel and relative URLs', () => {
		expect(
			interpolateMergeTagsHtml('<a href="{{name}}">x</a>', {
				name: 'https://example.com/?a=1&b=2',
			}),
		).toBe('<a href="https://example.com/?a=1&amp;b=2">x</a>')
		expect(
			interpolateMergeTagsHtml('<a href="mailto:{{email}}">x</a>', {
				email: 'a@example.com',
			}),
		).toBe('<a href="mailto:a@example.com">x</a>')
		expect(
			interpolateMergeTagsHtml('<a href="TEL:{{phone}}">x</a>', {
				phone: '+1 555',
			}),
		).toBe('<a href="TEL:+1 555">x</a>')
		expect(
			interpolateMergeTagsHtml('<a href="https://x.test/u/{{name}}">x</a>', {
				name: 'javascript:alert(1)',
			}),
		).toBe('<a href="https://x.test/u/javascript:alert(1)">x</a>')
		expect(
			interpolateMergeTagsHtml('<img src="{{name}}">', { name: 'logo.png' }),
		).toBe('<img src="logo.png">')
	})

	it('fills a merge tag in a designed button URL', async () => {
		const { html } = await renderMarketingEmail({
			blocks: [
				{
					id: 'block-1',
					type: 'button',
					config: {
						label: 'Open',
						url: 'https://example.com/r?e={{email}}',
						variant: 'primary',
						align: 'center',
					},
				},
			],
			theme: resolveEmailTheme({ organizationName: 'Acme' }),
		})
		const sent = interpolateMergeTagsHtml(html, { email: 'a+b@example.com' })
		expect(sent).toContain('href="https://example.com/r?e=a+b@example.com"')
	})

	it('leaves text and non-URL attributes alone', () => {
		expect(
			interpolateMergeTagsHtml('<p title="{{name}}">{{name}}</p>', {
				name: 'javascript:alert(1)',
			}),
		).toBe('<p title="javascript:alert(1)">javascript:alert(1)</p>')
	})
})
