import { describe, expect, it } from 'vitest'
import {
	hasAppCredentials,
	providerUsesMerchantOAuth,
	resolveDoorDashJwtCredentials,
} from '../../src/pos/credentials.ts'
import { mintDoorDashJwt } from '../../src/pos/doordash-jwt.ts'

describe('DoorDash JWT credentials', () => {
	it('does not use merchant OAuth', () => {
		expect(providerUsesMerchantOAuth('doordash')).toBe(false)
		expect(providerUsesMerchantOAuth('square')).toBe(true)
	})

	it('detects JWT env vars', () => {
		process.env.DOORDASH_DEVELOPER_ID = 'dev-uuid'
		process.env.DOORDASH_KEY_ID = 'key-uuid'
		process.env.DOORDASH_SIGNING_SECRET = 'c2VjcmV0' // base64 "secret"
		expect(hasAppCredentials('doordash')).toBe(true)
		expect(resolveDoorDashJwtCredentials()?.developerId).toBe('dev-uuid')
		delete process.env.DOORDASH_DEVELOPER_ID
		delete process.env.DOORDASH_KEY_ID
		delete process.env.DOORDASH_SIGNING_SECRET
	})

	it('mints a three-part JWT with dd-ver header', () => {
		const token = mintDoorDashJwt({
			developerId: '582e4f20-0f48-4bc2-99c2-e094675e2919',
			keyId: '585698aa-2aa6-4bb4-8b3f-dd9d3f47dc28',
			signingSecret: Buffer.from('signing-secret-bytes').toString('base64'),
		})
		const [header, payload, signature] = token.split('.')
		expect(signature.length).toBeGreaterThan(10)
		const decodedHeader = JSON.parse(
			Buffer.from(header!, 'base64url').toString('utf8'),
		)
		const decodedPayload = JSON.parse(
			Buffer.from(payload!, 'base64url').toString('utf8'),
		)
		expect(decodedHeader['dd-ver']).toBe('DD-JWT-V1')
		expect(decodedPayload.aud).toBe('doordash')
		expect(decodedPayload.iss).toBe('582e4f20-0f48-4bc2-99c2-e094675e2919')
		expect(decodedPayload.kid).toBe('585698aa-2aa6-4bb4-8b3f-dd9d3f47dc28')
	})
})
