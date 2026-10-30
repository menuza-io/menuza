import { decodeJwt, isJwtExpired } from './jwt'
import { makeAccessToken } from '@/test/support'

describe('decodeJwt', () => {
	it('reads the access token claims', () => {
		const claims = decodeJwt(
			makeAccessToken({
				customerId: 'cust_9',
				orgId: 'org_9',
				name: 'Ada Lovelace',
			}),
		)

		expect(claims?.customerId).toBe('cust_9')
		expect(claims?.orgId).toBe('org_9')
		expect(claims?.name).toBe('Ada Lovelace')
		expect(claims && isJwtExpired(claims)).toBe(false)
	})

	it('decodes non-ASCII names', () => {
		const claims = decodeJwt(makeAccessToken({ name: 'عائشة الفارسي' }))
		expect(claims?.name).toBe('عائشة الفارسي')
	})

	it('detects expired tokens', () => {
		const claims = decodeJwt(makeAccessToken({ expiresIn: -60 }))
		expect(claims && isJwtExpired(claims)).toBe(true)
	})

	it('rejects malformed tokens', () => {
		expect(decodeJwt('not-a-jwt')).toBeNull()
		expect(decodeJwt('a.b.c')).toBeNull()
		expect(decodeJwt('a.W10.c')).toBeNull()
	})
})
