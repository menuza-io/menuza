import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
	canonicalLoyaltyCart,
	hashLoyaltyCart,
	type LoyaltyCart,
} from './cart.ts'
import {
	formatMemberCode,
	generateBindingToken,
	generateMemberCode,
	generateOtp,
	isBindingToken,
	LOYALTY_CODE_ALPHABET,
	LOYALTY_MEMBER_CODE_LENGTH,
	normalizeMemberCode,
	normalizeOtp,
} from './codes.ts'
import { LOYALTY_ERROR_CODES, LOYALTY_ERROR_HTTP_STATUS } from './errors.ts'
import { foldLoyaltyFeatures, readLoyaltyFeatures } from './flags.ts'
import {
	applyLedgerEntry,
	availableLoyaltyPoints,
	canSpendLoyaltyPoints,
	EMPTY_LOYALTY_BALANCE,
	isValidLedgerDelta,
	LOYALTY_LEDGER_TYPES,
	type LoyaltyLedgerType,
	rebuildLoyaltyBalance,
} from './ledger.ts'
import {
	expandLoyaltyGrants,
	hasLoyaltyGrant,
	LOYALTY_PERMISSIONS,
	restrictLoyaltyGrantsForImpersonation,
} from './permissions.ts'
import {
	classifySaleTime,
	programVersionAt,
} from './program.ts'
import { loyaltyOutboxBackoffMs } from './reconciliation.ts'
import {
	canTransitionRedemption,
	isTerminalRedemptionState,
	LOYALTY_REDEMPTION_STATES,
	redemptionHoldsPoints,
	redemptionOccupiesOrder,
} from './redemption.ts'
import {
	LOYALTY_TOKEN_AUDIENCE,
	loyaltyAllowsLocation,
	loyaltyScopeGrantsFor,
	loyaltyTokenClaimsSchema,
	loyaltyTokenTtlSeconds,
} from './token.ts'

describe('flags', () => {
	it('counts only a literal true and forces children off without the master', () => {
		expect(foldLoyaltyFeatures({ enabled: 'true', redemption: true })).toEqual({
			enabled: false,
			redemption: false,
		})
		expect(foldLoyaltyFeatures({ enabled: true, redemption: 1 })).toEqual({
			enabled: true,
			redemption: false,
		})
		expect(foldLoyaltyFeatures({ enabled: true, redemption: true })).toEqual({
			enabled: true,
			redemption: true,
		})
	})

	it('reads a malformed payload as all off', () => {
		expect(readLoyaltyFeatures(null)).toEqual({
			enabled: false,
			redemption: false,
		})
		expect(
			readLoyaltyFeatures({ enabled: true, redemption: true, x: 1 }),
		).toEqual({ enabled: false, redemption: false })
		expect(readLoyaltyFeatures({ enabled: false, redemption: true })).toEqual({
			enabled: false,
			redemption: false,
		})
	})
})

describe('permissions', () => {
	it('adds the implied read and drops unrelated grants', () => {
		expect(
			expandLoyaltyGrants([
				LOYALTY_PERMISSIONS.UPDATE_LOYALTY_POINTS,
				'read:reservation:any',
			]),
		).toEqual([
			LOYALTY_PERMISSIONS.READ_LOYALTY,
			LOYALTY_PERMISSIONS.UPDATE_LOYALTY_POINTS,
		])
		expect(
			hasLoyaltyGrant(
				[LOYALTY_PERMISSIONS.UPDATE_LOYALTY_PROGRAM],
				LOYALTY_PERMISSIONS.READ_LOYALTY,
			),
		).toBe(true)
		expect(
			hasLoyaltyGrant(
				[LOYALTY_PERMISSIONS.READ_LOYALTY],
				LOYALTY_PERMISSIONS.READ_LOYALTY_REPORT,
			),
		).toBe(false)
	})

	it('leaves impersonation read-only', () => {
		const all = expandLoyaltyGrants(Object.values(LOYALTY_PERMISSIONS))
		expect(restrictLoyaltyGrantsForImpersonation(all, true)).toEqual([
			LOYALTY_PERMISSIONS.READ_LOYALTY,
			LOYALTY_PERMISSIONS.READ_LOYALTY_REPORT,
		])
		expect(restrictLoyaltyGrantsForImpersonation(all, false)).toEqual(all)
	})
})

describe('operator token', () => {
	const now = 1_800_000_000
	const claims = (overrides: Record<string, unknown> = {}) => ({
		aud: LOYALTY_TOKEN_AUDIENCE,
		role: 'operator',
		region: 'us',
		orgId: 'org_1',
		sub: 'user_1',
		scope: 'members',
		grants: [
			LOYALTY_PERMISSIONS.READ_LOYALTY,
			LOYALTY_PERMISSIONS.UPDATE_LOYALTY_POINTS,
		],
		locationIds: null,
		features: { enabled: true, redemption: false },
		impersonated: false,
		iat: now,
		exp: now + 300,
		...overrides,
	})

	it('accepts a well-formed token', () => {
		expect(loyaltyTokenClaimsSchema.safeParse(claims()).success).toBe(true)
	})

	it('caps the lifetime: 5 minutes with a points grant, 15 otherwise', () => {
		expect(
			loyaltyTokenClaimsSchema.safeParse(claims({ exp: now + 301 })).success,
		).toBe(false)
		expect(
			loyaltyTokenClaimsSchema.safeParse(
				claims({
					scope: 'read',
					grants: [LOYALTY_PERMISSIONS.READ_LOYALTY],
					exp: now + 900,
				}),
			).success,
		).toBe(true)
		expect(
			loyaltyTokenClaimsSchema.safeParse(
				claims({
					scope: 'read',
					grants: [LOYALTY_PERMISSIONS.READ_LOYALTY],
					exp: now + 901,
				}),
			).success,
		).toBe(false)
		expect(
			loyaltyTokenTtlSeconds([LOYALTY_PERMISSIONS.READ_LOYALTY], true),
		).toBe(300)
	})

	it('refuses write grants on impersonated tokens, grants outside the scope and extra claims', () => {
		expect(
			loyaltyTokenClaimsSchema.safeParse(claims({ impersonated: true }))
				.success,
		).toBe(false)
		expect(
			loyaltyTokenClaimsSchema.safeParse(
				claims({
					scope: 'read',
					grants: [
						LOYALTY_PERMISSIONS.READ_LOYALTY,
						LOYALTY_PERMISSIONS.UPDATE_LOYALTY_POINTS,
					],
				}),
			).success,
		).toBe(false)
		expect(
			loyaltyTokenClaimsSchema.safeParse(claims({ customerId: 'c_1' })).success,
		).toBe(false)
		expect(
			loyaltyTokenClaimsSchema.safeParse(claims({ aud: 'tenant-api-operator' }))
				.success,
		).toBe(false)
	})

	it('derives scope grants from what the member holds', () => {
		expect(
			loyaltyScopeGrantsFor('setup', [
				LOYALTY_PERMISSIONS.UPDATE_LOYALTY_PROGRAM,
			]),
		).toEqual([
			LOYALTY_PERMISSIONS.READ_LOYALTY,
			LOYALTY_PERMISSIONS.UPDATE_LOYALTY_PROGRAM,
		])
		expect(
			loyaltyScopeGrantsFor('members', [LOYALTY_PERMISSIONS.READ_LOYALTY]),
		).toEqual([LOYALTY_PERMISSIONS.READ_LOYALTY])
		expect(
			loyaltyScopeGrantsFor(
				'members',
				[LOYALTY_PERMISSIONS.UPDATE_LOYALTY_POINTS],
				true,
			),
		).toEqual([LOYALTY_PERMISSIONS.READ_LOYALTY])
		expect(
			loyaltyScopeGrantsFor('reports', [LOYALTY_PERMISSIONS.READ_LOYALTY]),
		).toEqual([])
	})

	it('reads null locations as all and [] as none', () => {
		expect(loyaltyAllowsLocation(null, 'loc_1')).toBe(true)
		expect(loyaltyAllowsLocation([], 'loc_1')).toBe(false)
		expect(loyaltyAllowsLocation(['loc_2'], 'loc_1')).toBe(false)
	})
})

describe('redemption state machine', () => {
	it('allows exactly the planned transitions', () => {
		const allowed = new Set([
			'reserved>bound',
			'reserved>released',
			'bound>consumed',
			'bound>released',
			'bound>review',
			'review>consumed',
			'review>released',
			'consumed>restored',
		])
		for (const from of LOYALTY_REDEMPTION_STATES) {
			for (const to of LOYALTY_REDEMPTION_STATES) {
				expect(canTransitionRedemption(from, to), `${from}>${to}`).toBe(
					allowed.has(`${from}>${to}`),
				)
			}
		}
	})

	it('holds points only while undecided and frees the order slot only on release', () => {
		expect(LOYALTY_REDEMPTION_STATES.filter(redemptionHoldsPoints)).toEqual([
			'reserved',
			'bound',
			'review',
		])
		expect(
			LOYALTY_REDEMPTION_STATES.filter(
				(state) => !redemptionOccupiesOrder(state),
			),
		).toEqual(['released'])
		expect(LOYALTY_REDEMPTION_STATES.filter(isTerminalRedemptionState)).toEqual(
			['released', 'restored'],
		)
	})
})

describe('ledger', () => {
	it('enforces the sign of each entry type', () => {
		expect(isValidLedgerDelta('earn', 5)).toBe(true)
		expect(isValidLedgerDelta('earn', -5)).toBe(false)
		expect(isValidLedgerDelta('earn_reversal', 5)).toBe(false)
		expect(isValidLedgerDelta('redeem', -100)).toBe(true)
		expect(isValidLedgerDelta('redeem_restore', 100)).toBe(true)
		expect(isValidLedgerDelta('adjust', -3)).toBe(true)
		expect(isValidLedgerDelta('adjust', 0)).toBe(false)
		expect(isValidLedgerDelta('adjust', 1.5)).toBe(false)
	})

	it('allows points debt and blocks spending while in debt', () => {
		let balance = applyLedgerEntry(EMPTY_LOYALTY_BALANCE, {
			type: 'earn',
			delta: 100,
		})
		balance = applyLedgerEntry(balance, { type: 'redeem', delta: -100 })
		balance = applyLedgerEntry(balance, { type: 'earn_reversal', delta: -40 })
		expect(balance).toEqual({
			points: -40,
			reserved: 0,
			lifetimeEarned: 60,
			lifetimeRedeemed: 100,
		})
		expect(availableLoyaltyPoints(balance)).toBe(-40)
		expect(canSpendLoyaltyPoints(balance, 1)).toBe(false)
		balance = applyLedgerEntry(balance, { type: 'earn', delta: 50 })
		expect(canSpendLoyaltyPoints(balance, 10)).toBe(true)
		expect(canSpendLoyaltyPoints({ points: 50, reserved: 45 }, 10)).toBe(false)
	})

	it('rebuilds the same balance as applying entries one by one', () => {
		const entry = fc.oneof(
			fc.record({
				type: fc.constantFrom<LoyaltyLedgerType>('earn', 'redeem_restore'),
				delta: fc.integer({ min: 1, max: 10_000 }),
			}),
			fc.record({
				type: fc.constantFrom<LoyaltyLedgerType>('earn_reversal', 'redeem'),
				delta: fc.integer({ min: -10_000, max: -1 }),
			}),
			fc.record({
				type: fc.constant<LoyaltyLedgerType>('adjust'),
				delta: fc.integer({ min: -10_000, max: 10_000 }).filter((d) => d !== 0),
			}),
		)
		fc.assert(
			fc.property(
				fc.array(entry, { maxLength: 60 }),
				fc.array(fc.integer({ min: 1, max: 5_000 }), { maxLength: 4 }),
				(entries, held) => {
					let incremental = { ...EMPTY_LOYALTY_BALANCE }
					for (const item of entries) {
						expect(isValidLedgerDelta(item.type, item.delta)).toBe(true)
						incremental = applyLedgerEntry(incremental, item)
					}
					const rebuilt = rebuildLoyaltyBalance(entries, held)
					expect(rebuilt.points).toBe(incremental.points)
					expect(rebuilt.lifetimeEarned).toBe(incremental.lifetimeEarned)
					expect(rebuilt.lifetimeRedeemed).toBe(incremental.lifetimeRedeemed)
					expect(rebuilt.reserved).toBe(held.reduce((a, b) => a + b, 0))
					expect(rebuilt.points).toBe(
						entries.reduce((sum, item) => sum + item.delta, 0),
					)
				},
			),
		)
		expect(LOYALTY_LEDGER_TYPES).toHaveLength(5)
	})
})

describe('member codes, bindings and one-time codes', () => {
	it('generates codes from the unambiguous alphabet', () => {
		for (let index = 0; index < 200; index++) {
			const code = generateMemberCode()
			expect(code).toHaveLength(LOYALTY_MEMBER_CODE_LENGTH)
			for (const char of code) expect(LOYALTY_CODE_ALPHABET).toContain(char)
			expect(normalizeMemberCode(formatMemberCode(code))).toBe(code)
		}
	})

	it('reads typed codes forgivingly and refuses everything else', () => {
		expect(normalizeMemberCode('abcd-efgh')).toBe('ABCDEFGH')
		expect(normalizeMemberCode(' 0o1l 2345 ')).toBe('00112345')
		expect(normalizeMemberCode('ABCD-EFG')).toBeNull()
		expect(normalizeMemberCode('ABCD-EFGU')).toBeNull()
		expect(normalizeMemberCode('x'.repeat(40))).toBeNull()
		expect(normalizeMemberCode(12345678)).toBeNull()
	})

	it('generates opaque bindings and six-digit one-time codes', () => {
		const binding = generateBindingToken()
		expect(isBindingToken(binding)).toBe(true)
		expect(isBindingToken(`${binding}x`)).toBe(false)
		expect(isBindingToken('lmb1.short')).toBe(false)
		expect(isBindingToken('+15551234567')).toBe(false)
		expect(generateBindingToken()).not.toBe(binding)
		const otp = generateOtp()
		expect(otp).toMatch(/^\d{6}$/)
		expect(normalizeOtp(' 123 456 ')).toBe('123456')
		expect(normalizeOtp('12345')).toBeNull()
	})
})

describe('program versions and sale times', () => {
	const versions = [
		{ version: 1, status: 'active' as const, effectiveAt: 1_000 },
		{ version: 2, status: 'active' as const, effectiveAt: 5_000 },
		{ version: 3, status: 'paused' as const, effectiveAt: 9_000 },
	]

	it('picks the version in force at the sale time', () => {
		expect(programVersionAt(versions, 500)).toBeNull()
		expect(programVersionAt(versions, 1_000)?.version).toBe(1)
		expect(programVersionAt(versions, 8_999)?.version).toBe(2)
		expect(programVersionAt(versions, 10_000)?.version).toBe(3)
	})

	it('sends future and very old offline sale times to review', () => {
		const received = 100 * 24 * 60 * 60_000
		expect(classifySaleTime(received - 60_000, received)).toBe('ok')
		expect(classifySaleTime(received + 6 * 60_000, received)).toBe('future')
		expect(classifySaleTime(received - 31 * 24 * 60 * 60_000, received)).toBe(
			'stale',
		)
	})
})

describe('reconciliation backoff', () => {
	it('doubles from 30 seconds and stops at an hour', () => {
		expect(loyaltyOutboxBackoffMs(1)).toBe(30_000)
		expect(loyaltyOutboxBackoffMs(2)).toBe(60_000)
		expect(loyaltyOutboxBackoffMs(7)).toBe(1_920_000)
		expect(loyaltyOutboxBackoffMs(8)).toBe(3_600_000)
		expect(loyaltyOutboxBackoffMs(50)).toBe(3_600_000)
		expect(loyaltyOutboxBackoffMs(0)).toBe(30_000)
	})
})

describe('cart binding', () => {
	const cart: LoyaltyCart = {
		currency: 'USD',
		otherDiscountMinor: 0,
		lines: [
			{
				lineId: 'l1',
				itemId: 'burger',
				variantId: null,
				categoryIds: ['mains', 'beef'],
				quantity: 1,
				unitBaseMinor: 1000,
				unitMinor: 1200,
			},
		],
	}

	it('hashes the same cart the same way whatever the category order', async () => {
		const reordered: LoyaltyCart = {
			...cart,
			lines: [{ ...cart.lines[0]!, categoryIds: ['beef', 'mains'] }],
		}
		expect(canonicalLoyaltyCart(reordered)).toBe(canonicalLoyaltyCart(cart))
		expect(await hashLoyaltyCart(reordered)).toBe(await hashLoyaltyCart(cart))
	})

	it('changes the hash when a price or quantity changes', async () => {
		const pricier: LoyaltyCart = {
			...cart,
			lines: [{ ...cart.lines[0]!, unitMinor: 1300 }],
		}
		expect(await hashLoyaltyCart(pricier)).not.toBe(await hashLoyaltyCart(cart))
		expect(await hashLoyaltyCart(cart)).toMatch(/^[0-9a-f]{64}$/)
	})
})

describe('error codes', () => {
	it('has an HTTP status for every code', () => {
		for (const code of LOYALTY_ERROR_CODES) {
			expect(LOYALTY_ERROR_HTTP_STATUS[code]).toBeGreaterThanOrEqual(400)
		}
	})
})
