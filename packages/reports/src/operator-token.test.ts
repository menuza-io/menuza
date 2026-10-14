import { SignJWT } from 'jose'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
	mintOperatorAnalyticsToken,
	OPERATOR_TOKEN_AUD,
	OPERATOR_TOKEN_ISS,
	operatorTokenAllowsSubject,
	verifyOperatorAnalyticsToken,
} from './operator-token.ts'

const secret = 'dev-internal-command-token-do-not-use-in-prod'

describe('operator analytics token', () => {
	it('round-trips claims', async () => {
		const { token } = await mintOperatorAnalyticsToken({
			internalCommandToken: secret,
			userId: 'user_1',
			orgId: 'org_1',
			role: 'operator',
		})
		const claims = await verifyOperatorAnalyticsToken({
			internalCommandToken: secret,
			token,
		})
		expect(claims).toEqual({
			userId: 'user_1',
			orgId: 'org_1',
			role: 'operator',
			scope: 'analytics',
			subjects: [],
			scopeIds: null,
		})
	})

	it('rejects a token signed with a different secret', async () => {
		const { token } = await mintOperatorAnalyticsToken({
			internalCommandToken: secret,
			userId: 'user_1',
			orgId: 'org_1',
			role: 'operator',
		})
		const claims = await verifyOperatorAnalyticsToken({
			internalCommandToken: `${secret}-other`,
			token,
		})
		expect(claims).toBeNull()
	})

	it('carries granted restricted subjects', async () => {
		const { token } = await mintOperatorAnalyticsToken({
			internalCommandToken: secret,
			userId: 'user_1',
			orgId: 'org_1',
			role: 'operator',
			subjects: ['phone_calls'],
		})
		const claims = await verifyOperatorAnalyticsToken({
			internalCommandToken: secret,
			token,
		})
		expect(claims?.subjects).toEqual(['phone_calls'])
		expect(operatorTokenAllowsSubject(claims!, 'phone_calls')).toBe(true)
	})

	it('only allows restricted subjects the token grants', async () => {
		const { token } = await mintOperatorAnalyticsToken({
			internalCommandToken: secret,
			userId: 'user_1',
			orgId: 'org_1',
			role: 'operator',
		})
		const claims = await verifyOperatorAnalyticsToken({
			internalCommandToken: secret,
			token,
		})
		expect(operatorTokenAllowsSubject(claims!, 'phone_calls')).toBe(false)
		expect(operatorTokenAllowsSubject(claims!, 'customers')).toBe(true)
		expect(operatorTokenAllowsSubject(claims!, 'shop_orders')).toBe(true)
	})

	it('drops unknown subjects from a token', async () => {
		const key = createHash('sha256')
			.update('tenant-operator-analytics-v1:')
			.update(secret)
			.digest()
		const token = await new SignJWT({
			orgId: 'org_1',
			role: 'operator',
			scope: 'analytics',
			subjects: ['phone_calls', 'everything', 42],
		})
			.setProtectedHeader({ alg: 'HS256' })
			.setSubject('user_1')
			.setIssuer(OPERATOR_TOKEN_ISS)
			.setAudience(OPERATOR_TOKEN_AUD)
			.setExpirationTime('5m')
			.sign(key)
		const claims = await verifyOperatorAnalyticsToken({
			internalCommandToken: secret,
			token,
		})
		expect(claims?.subjects).toEqual(['phone_calls'])
	})

	describe('staff subjects', () => {
		const base = {
			internalCommandToken: secret,
			userId: 'user_1',
			orgId: 'org_1',
			role: 'operator' as const,
		}
		const verify = (token: string) =>
			verifyOperatorAnalyticsToken({ internalCommandToken: secret, token })

		it('carries staff subjects and the scope', async () => {
			const { token } = await mintOperatorAnalyticsToken({
				...base,
				subjects: ['time_entries', 'labor_daily'],
				scopeIds: ['loc-b', 'loc-a', 'loc-a'],
			})
			const claims = await verify(token)
			expect(claims?.subjects).toEqual(['time_entries', 'labor_daily'])
			expect(claims?.scopeIds).toEqual(['loc-b', 'loc-a'])
			expect(operatorTokenAllowsSubject(claims!, 'labor_daily')).toBe(true)
			expect(operatorTokenAllowsSubject(claims!, 'shifts')).toBe(false)
			expect(operatorTokenAllowsSubject(claims!, 'applications')).toBe(false)
			expect(operatorTokenAllowsSubject(claims!, 'staff_pay')).toBe(false)
		})

		it('uses null for every scope and keeps an empty list as none', async () => {
			const all = await mintOperatorAnalyticsToken({
				...base,
				subjects: ['shifts'],
				scopeIds: null,
			})
			expect((await verify(all.token))?.scopeIds).toBeNull()
			const none = await mintOperatorAnalyticsToken({
				...base,
				subjects: ['shifts'],
				scopeIds: [],
			})
			expect((await verify(none.token))?.scopeIds).toEqual([])
		})

		it('refuses to mint a staff subject without a scope', async () => {
			for (const subjects of [
				['time_entries'],
				['shifts'],
				['labor_daily'],
				['applications'],
				['staff_pay'],
			] as const) {
				await expect(
					mintOperatorAnalyticsToken({ ...base, subjects }),
				).rejects.toThrow(/scope/)
			}
			// Other subjects need none.
			await expect(
				mintOperatorAnalyticsToken({ ...base, subjects: ['orders'] }),
			).resolves.toBeTruthy()
		})

		it('gives a token with wages five minutes', async () => {
			const pay = await mintOperatorAnalyticsToken({
				...base,
				subjects: ['time_entries', 'staff_pay'],
				scopeIds: null,
			})
			const payLife = Date.parse(pay.expiresAt) - Date.now()
			expect(payLife).toBeLessThanOrEqual(5 * 60 * 1000)
			const plain = await mintOperatorAnalyticsToken({
				...base,
				subjects: ['time_entries'],
				scopeIds: null,
			})
			const plainLife = Date.parse(plain.expiresAt) - Date.now()
			expect(plainLife).toBeGreaterThan(10 * 60 * 1000)
		})

		function forged(
			claims: Record<string, unknown>,
			lifetime: string,
			iat = true,
		) {
			const key = createHash('sha256')
				.update('tenant-operator-analytics-v1:')
				.update(secret)
				.digest()
			const jwt = new SignJWT({
				orgId: 'org_1',
				role: 'operator',
				scope: 'analytics',
				...claims,
			})
				.setProtectedHeader({ alg: 'HS256' })
				.setSubject('user_1')
				.setIssuer(OPERATOR_TOKEN_ISS)
				.setAudience(OPERATOR_TOKEN_AUD)
				.setExpirationTime(lifetime)
			return (iat ? jwt.setIssuedAt() : jwt).sign(key)
		}

		it('rejects a wage token that lives longer than five minutes', async () => {
			const long = await forged(
				{ subjects: ['time_entries', 'staff_pay'], scopeIds: null },
				'15m',
			)
			expect(await verify(long)).toBeNull()
			const undated = await forged(
				{ subjects: ['time_entries', 'staff_pay'], scopeIds: null },
				'5m',
				false,
			)
			expect(await verify(undated)).toBeNull()
			const short = await forged(
				{ subjects: ['time_entries', 'staff_pay'], scopeIds: null },
				'5m',
			)
			expect(await verify(short)).not.toBeNull()
		})

		it('rejects any token that lives longer than fifteen minutes', async () => {
			const long = await forged({ subjects: [], scopeIds: null }, '1h')
			expect(await verify(long)).toBeNull()
		})

		it('reads a missing or malformed scope claim as no scopes', async () => {
			for (const scopeIds of [undefined, 'loc-1', 7, { 0: 'loc-1' }]) {
				const token = await forged(
					{
						subjects: ['time_entries'],
						...(scopeIds === undefined ? {} : { scopeIds }),
					},
					'10m',
				)
				expect((await verify(token))?.scopeIds, String(scopeIds)).toEqual([])
			}
			const mixed = await forged(
				{ subjects: ['time_entries'], scopeIds: ['loc-1', 3, '', null] },
				'10m',
			)
			expect((await verify(mixed))?.scopeIds).toEqual(['loc-1'])
		})
	})
})
