import crypto from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	deriveOrderLinkToken,
	buildOrderLinkUrl,
	ORDER_LINK_TTL_MS,
	orderLinkExpiresAt,
	verifyOrderLinkToken,
} from './order-link.ts'
import { hmacHash, syncEnvFromProcess } from './secrets.ts'

const ORG = 'org_link_1'
const ORDER = 'order_1'
const CREATED = Date.UTC(2026, 10, 1)

/** What `placeOrder` stores: SHA-256 of `deriveReceiptToken(ORG, ORDER)`. */
function liveHash() {
	return crypto
		.createHash('sha256')
		.update(hmacHash(`restaurant-receipt:${ORG}:${ORDER}`))
		.digest('hex')
}

describe('order link tokens', () => {
	beforeEach(() => {
		vi.stubEnv('AUTH_HMAC_SECRET', 'test-hmac-secret-123456789')
		syncEnvFromProcess()
	})
	afterEach(() => {
		vi.unstubAllEnvs()
	})

	const verify = (
		presented: string,
		overrides: Partial<Parameters<typeof verifyOrderLinkToken>[0]> = {},
	) =>
		verifyOrderLinkToken({
			orgId: ORG,
			orderId: ORDER,
			presented,
			createdAt: CREATED,
			receiptTokenHash: liveHash(),
			now: CREATED + 1000,
			...overrides,
		})

	it('is deterministic per order and verifies within 90 days', () => {
		const token = deriveOrderLinkToken(ORG, ORDER)
		expect(token).toBe(deriveOrderLinkToken(ORG, ORDER))
		expect(token).toMatch(/^[0-9a-f]{64}$/)
		expect(verify(token)).toBe(true)
		expect(verify(token, { now: CREATED + ORDER_LINK_TTL_MS })).toBe(true)
		expect(orderLinkExpiresAt(new Date(CREATED))).toBe(
			CREATED + ORDER_LINK_TTL_MS,
		)
	})

	it('refuses an expired link, and one without a creation time', () => {
		const token = deriveOrderLinkToken(ORG, ORDER)
		expect(verify(token, { now: CREATED + ORDER_LINK_TTL_MS + 1 })).toBe(false)
		expect(verify(token, { createdAt: null })).toBe(false)
	})

	it('refuses a token for another order or another organization', () => {
		expect(verify(deriveOrderLinkToken(ORG, 'order_2'))).toBe(false)
		expect(verify(deriveOrderLinkToken('org_other', ORDER))).toBe(false)
		expect(
			verify(deriveOrderLinkToken(ORG, ORDER), { orgId: 'org_other' }),
		).toBe(false)
	})

	it('is not interchangeable with the receipt or payment token (other purposes)', () => {
		const receipt = hmacHash(`restaurant-receipt:${ORG}:${ORDER}`)
		const payment = hmacHash(`restaurant-payment:${ORG}:${ORDER}`)
		expect(verify(receipt)).toBe(false)
		expect(verify(payment)).toBe(false)
		expect(verify(hmacHash(`order-link:v2:${ORG}:${ORDER}`))).toBe(false)
	})

	it('dies with an erased order (its receipt token hash was replaced)', () => {
		const token = deriveOrderLinkToken(ORG, ORDER)
		expect(verify(token, { receiptTokenHash: crypto.randomUUID() })).toBe(false)
	})

	it('refuses a tampered or malformed token', () => {
		const token = deriveOrderLinkToken(ORG, ORDER)
		const flipped = `${token.slice(0, -1)}${token.endsWith('0') ? '1' : '0'}`
		expect(verify(flipped)).toBe(false)
		expect(verify(token.toUpperCase())).toBe(false)
		expect(verify(`${token}00`)).toBe(false)
		expect(verify('')).toBe(false)
	})

	it('builds the success page link with the token in the fragment only', () => {
		const url = buildOrderLinkUrl({
			siteOrigin: 'https://acme.example.com/',
			orgId: ORG,
			orderId: ORDER,
		})
		const token = deriveOrderLinkToken(ORG, ORDER)
		expect(url).toBe(
			`https://acme.example.com/menu/success?order=${ORDER}#link=${token}`,
		)
		expect(new URL(url!).search).not.toContain(token)
		expect(
			buildOrderLinkUrl({ siteOrigin: null, orgId: ORG, orderId: ORDER }),
		).toBeNull()
		expect(
			buildOrderLinkUrl({
				siteOrigin: 'javascript:alert(1)',
				orgId: ORG,
				orderId: ORDER,
			}),
		).toBeNull()
	})
})
