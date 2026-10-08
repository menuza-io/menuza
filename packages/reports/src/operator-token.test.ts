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
})
