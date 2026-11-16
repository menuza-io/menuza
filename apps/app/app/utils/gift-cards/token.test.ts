import { brand } from '@repo/config/brand'
import {
	GIFT_CARD_PERMISSIONS,
	GIFT_CARD_TOKEN_AUDIENCE,
	GIFT_CARD_TOKEN_TYP,
	giftCardTokenClaimsSchema,
} from '@repo/common/gift-cards'
import { decodeJwt, decodeProtectedHeader, jwtVerify } from 'jose'
import { describe, expect, it } from 'vitest'
import { mintGiftCardToken } from './token.server.ts'

const SECRET = 'gift-card-token-test-secret-0123456789abcdef'
const FEATURES = { enabled: true, online: true, pos: false }
const ALL = [
	GIFT_CARD_PERMISSIONS.READ_GIFT_CARD,
	GIFT_CARD_PERMISSIONS.UPDATE_GIFT_CARD,
	GIFT_CARD_PERMISSIONS.UPDATE_GIFT_CARD_CHARGE,
]

function mint(overrides: Partial<Parameters<typeof mintGiftCardToken>[0]> = {}) {
	return mintGiftCardToken({
		organizationId: 'org_1',
		userId: 'user_1',
		actorName: 'Pat Manager',
		dataRegion: 'us',
		scope: 'write',
		grants: ALL,
		locationIds: null,
		features: FEATURES,
		impersonated: false,
		nowSeconds: 1_800_000_000,
		secret: SECRET,
		...overrides,
	})
}

describe('mintGiftCardToken', () => {
	it('signs a gft+jwt with its own audience, type and issuer', async () => {
		const minted = await mint()
		expect(decodeProtectedHeader(minted.jwt).typ).toBe(GIFT_CARD_TOKEN_TYP)
		const { payload } = await jwtVerify(minted.jwt, new TextEncoder().encode(SECRET), {
			audience: GIFT_CARD_TOKEN_AUDIENCE,
			issuer: brand.shortName,
			currentDate: new Date(1_800_000_100_000),
		})
		expect(payload.sub).toBe('user_1')
		expect(payload.actorName).toBe('Pat Manager')
		expect(giftCardTokenClaimsSchema.safeParse(payload).success).toBe(true)
		// Ids, grants and flags only: no card, code, balance or person.
		expect(Object.keys(payload).sort()).toEqual(
			['actorName', 'aud', 'exp', 'features', 'grants', 'iat', 'impersonated', 'iss', 'locationIds', 'orgId', 'region', 'role', 'scope', 'sub'].sort(),
		)
		expect(minted.ttlSeconds).toBe(900)
	})

	it('a read token carries only the read grant', async () => {
		const minted = await mint({ scope: 'read' })
		expect(minted.grants).toEqual([GIFT_CARD_PERMISSIONS.READ_GIFT_CARD])
	})

	it('a member with only the charge grant gets read and charge, never update', async () => {
		const minted = await mint({ grants: [GIFT_CARD_PERMISSIONS.UPDATE_GIFT_CARD_CHARGE] })
		expect(minted.grants).toEqual([
			GIFT_CARD_PERMISSIONS.READ_GIFT_CARD,
			GIFT_CARD_PERMISSIONS.UPDATE_GIFT_CARD_CHARGE,
		])
	})

	it('an impersonated token is read-only and short-lived', async () => {
		const minted = await mint({ impersonated: true })
		expect(minted.grants).toEqual([GIFT_CARD_PERMISSIONS.READ_GIFT_CARD])
		expect(minted.ttlSeconds).toBe(300)
		expect(decodeJwt(minted.jwt).impersonated).toBe(true)
	})

	it('refuses a member with no grants and a missing secret', async () => {
		await expect(mint({ grants: [] })).rejects.toBeInstanceOf(Response)
		await expect(mint({ secret: 'short' })).rejects.toBeInstanceOf(Response)
	})

	it('routes a KSA organization to its own node', async () => {
		const minted = await mint({ dataRegion: 'ksa' })
		expect(decodeJwt(minted.jwt).region).toBe('ksa')
	})
})
