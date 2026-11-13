import { describe, expect, it } from 'vitest'
import {
	UNSUBSCRIBE_PREVIEW_HREF,
	unsubscribeFooterHtml,
	withUnsubscribeFooter,
} from './email-unsubscribe.ts'

const url = 'https://tenant.example.com/subscriptions/unsubscribe?token=a.b'

describe('withUnsubscribeFooter', () => {
	it('puts the link just before </body> of a full document', () => {
		expect(
			withUnsubscribeFooter('<html><body><p>Hi</p></BODY></html>', url),
		).toBe(`<html><body><p>Hi</p>${unsubscribeFooterHtml(url)}</BODY></html>`)
	})

	it('matches a closing body tag with spaces before >', () => {
		expect(withUnsubscribeFooter('<body><p>Hi</p></body ></html>', url)).toBe(
			`<body><p>Hi</p>${unsubscribeFooterHtml(url)}</body ></html>`,
		)
	})

	it('is not shifted by text whose lowercase form is longer', () => {
		expect(
			withUnsubscribeFooter('<body><p>İİİ İstanbul</p></body></html>', url),
		).toBe(
			`<body><p>İİİ İstanbul</p>${unsubscribeFooterHtml(url)}</body></html>`,
		)
	})

	it('appends the link to a fragment', () => {
		expect(withUnsubscribeFooter('<p>Hi</p>', url)).toBe(
			`<p>Hi</p><p style="font-size:12px;color:#666"><a href="${url}">Unsubscribe</a></p>`,
		)
	})

	it('escapes the link attribute', () => {
		expect(unsubscribeFooterHtml('https://x.test/?a="b"&c')).toContain(
			'href="https://x.test/?a=&quot;b&quot;&amp;c"',
		)
	})

	it('the preview uses a placeholder, never a signed token', () => {
		expect(unsubscribeFooterHtml(UNSUBSCRIBE_PREVIEW_HREF)).toContain(
			'href="#unsubscribe"',
		)
	})
})
