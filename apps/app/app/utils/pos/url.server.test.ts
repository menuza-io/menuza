import { getLocalDomain } from '@repo/config/brand'
import { describe, expect, it } from 'vitest'
import { resolvePosUrl } from './url.server.ts'

describe('resolvePosUrl', () => {
	it.each([undefined, ''])(
		'defaults %s to the local HTTPS POS origin in development',
		(posUrl) => {
			expect(resolvePosUrl(posUrl, 'development')).toBe(
				`https://pos.${getLocalDomain()}:2999`,
			)
		},
	)

	it.each(['development', 'production'])(
		'keeps an explicit POS_URL in %s',
		(mode) => {
			expect(resolvePosUrl('https://till.example.com', mode)).toBe(
				'https://till.example.com',
			)
		},
	)

	it.each(['production', 'test', undefined])(
		'never uses the development fallback in %s',
		(mode) => {
			expect(resolvePosUrl(undefined, mode)).toBe('')
			expect(resolvePosUrl('', mode)).toBe('')
		},
	)
})
