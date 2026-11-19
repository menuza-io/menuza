import { describe, expect, it } from 'vitest'
import {
	generateIndexNowKey,
	indexNowBody,
	isIndexNowKey,
	parseVerificationCode,
	selectIndexNowUrls,
} from './site-seo.ts'

describe('verification codes', () => {
	it('takes the bare code or a pasted meta tag', () => {
		expect(parseVerificationCode('google', 'abcDEF123_-xyz')).toBe(
			'abcDEF123_-xyz',
		)
		expect(
			parseVerificationCode(
				'google',
				'<meta name="google-site-verification" content="abcDEF123_-xyz" />',
			),
		).toBe('abcDEF123_-xyz')
		expect(
			parseVerificationCode('bing', '0123456789ABCDEF0123456789abcdef'),
		).toBe('0123456789ABCDEF0123456789abcdef')
	})

	it('refuses anything that could break out of the attribute', () => {
		expect(parseVerificationCode('google', '"><script>x</script>')).toBeNull()
		expect(parseVerificationCode('google', 'short')).toBeNull()
		expect(parseVerificationCode('bing', 'not-hex-not-hex')).toBeNull()
	})
})

describe('IndexNow', () => {
	it('generates valid keys', () => {
		const key = generateIndexNowKey()
		expect(isIndexNowKey(key)).toBe(true)
		expect(key).toHaveLength(32)
		expect(isIndexNowKey('../x')).toBe(false)
	})

	it('keeps unique URLs on the host not pinged in the last hour', () => {
		const now = Date.parse('2026-11-19T12:00:00Z')
		const urls = selectIndexNowUrls(
			[
				'https://acme.com/about',
				'https://acme.com/about',
				'https://acme.com/ar/about',
				'https://other.com/x',
				'https://acme.com/menu',
			],
			'acme.com',
			new Map([
				['https://acme.com/menu', now - 10 * 60_000],
				['https://acme.com/ar/about', now - 2 * 60 * 60_000],
			]),
			now,
		)
		expect(urls).toEqual([
			'https://acme.com/about',
			'https://acme.com/ar/about',
		])
	})

	it('builds the request body with the key location', () => {
		expect(
			indexNowBody({
				host: 'acme.com',
				key: 'k'.repeat(32),
				origin: 'https://acme.com',
				urls: ['https://acme.com/'],
			}),
		).toEqual({
			host: 'acme.com',
			key: 'k'.repeat(32),
			keyLocation: `https://acme.com/${'k'.repeat(32)}.txt`,
			urlList: ['https://acme.com/'],
		})
	})
})
