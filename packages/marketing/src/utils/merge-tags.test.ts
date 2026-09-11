import { describe, expect, it } from 'vitest'

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
})
