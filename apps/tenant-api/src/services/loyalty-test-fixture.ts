import { type PricedOrderLine } from '@repo/common/restaurant-orders'
import {
	hashLoyaltyCart,
	LoyaltyDomainError,
	type LoyaltyCart,
	type LoyaltyCartLine,
	type LoyaltyErrorCode,
	type LoyaltyProgramConfig,
	type LoyaltyPurchaseSource,
	type LoyaltyRewardDefinition,
} from '@repo/loyalty'
import {
	customers,
	getTenantDb,
	loyaltyBalances,
	posDevices,
	posOrders,
	qrTables,
	qrTabs,
	restaurantOrders,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { withLoyaltyWrite } from '../lib/loyalty-write.ts'
import { findBalanceMismatches, readBalanceViewInTx } from './loyalty-ledger.ts'
import {
	adjustMemberPoints,
	ensureMemberForCustomer,
	readMemberInTx,
	type MemberRow,
} from './loyalty-member-service.ts'
import {
	createReward,
	readRewardInTx,
	saveProgram,
	setProgramStatus,
} from './loyalty-program-service.ts'
import {
	claimPurchaseInTx,
	queueLoyaltySourceInTx,
	type LoyaltySourceRef,
	type PurchaseRow,
} from './loyalty-purchase-service.ts'
import {
	reserveRedemptionInTx,
	type RedemptionRow,
} from './loyalty-redemption-service.ts'

/**
 * Shared helpers for the loyalty service suites: a provisioned organization
 * with an active program, members with points, and direct rows for the order
 * channels. The suites create restaurant_orders / qr_tabs / pos_orders rows
 * themselves and drive claimPurchaseInTx / queueLoyaltySourceInTx inside
 * withLoyaltyWrite, so each service is tested without the routes around it.
 */

export const NOW = Date.UTC(2026, 0, 10, 12, 0, 0)
export const MINUTE = 60_000
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR

export const LOC_1 = 'loc_1'
export const LOC_2 = 'loc_2'

export const ACTOR = 'op_test'

export function programConfig(
	overrides: Partial<LoyaltyProgramConfig> = {},
): LoyaltyProgramConfig {
	return {
		name: 'Test Club',
		unitLabel: 'points',
		currency: 'USD',
		timeZone: 'UTC',
		minimumSpendMinor: 0,
		earning: { method: 'spend', points: 1, perMinor: 100 },
		terms: 'The terms.',
		labels: { items: {}, categories: {} },
		...overrides,
	}
}

export async function saveDraftProgram(
	orgId: string,
	config: LoyaltyProgramConfig = programConfig(),
	now: number = NOW,
) {
	return saveProgram(orgId, {
		expectedVersion: null,
		config,
		actorId: ACTOR,
		now,
	})
}

export async function activateProgram(
	orgId: string,
	config: LoyaltyProgramConfig = programConfig(),
	now: number = NOW,
) {
	const saved = await saveDraftProgram(orgId, config, now)
	return setProgramStatus(orgId, {
		expectedVersion: saved.version,
		status: 'active',
		actorId: ACTOR,
		now,
	})
}

export function rewardDefinition(
	overrides: Record<string, unknown> = {},
): LoyaltyRewardDefinition {
	return {
		kind: 'order',
		name: 'Five off',
		description: null,
		pointsCost: 10,
		discount: { type: 'fixed', amountMinor: 500 },
		labels: { items: {}, categories: {} },
		...overrides,
	} as LoyaltyRewardDefinition
}

export async function makeReward(
	orgId: string,
	definition: LoyaltyRewardDefinition = rewardDefinition(),
	now: number = NOW,
) {
	return createReward(orgId, { definition, actorId: ACTOR, now })
}

export async function insertCustomer(
	orgId: string,
	input: {
		id: string
		name?: string
		phone?: string | null
		verified?: boolean
	},
): Promise<string> {
	const db = await getTenantDb(orgId)
	await db.insert(customers).values({
		id: input.id,
		name: input.name ?? 'Test Customer',
		phone: input.phone ?? null,
		phoneVerified: input.verified ?? true,
	})
	return input.id
}

/**
 * The customer's points account, opened the way sign-in opens it. Throws when
 * the program is not active or the customer is not verified: no account.
 */
export async function makeMember(
	orgId: string,
	input: { customerId: string; now?: number },
): Promise<string> {
	const member = await ensureMemberForCustomer(orgId, {
		customerId: input.customerId,
		now: input.now ?? NOW,
	})
	if (!member) throw new Error('makeMember: no account was opened')
	return member.id
}

export async function memberRow(
	orgId: string,
	memberId: string,
): Promise<MemberRow> {
	const db = await getTenantDb(orgId)
	const row = await readMemberInTx(db, memberId)
	if (!row) throw new Error(`no member ${memberId}`)
	return row
}

let giveCounter = 0

export async function givePoints(
	orgId: string,
	memberId: string,
	points: number,
	now: number = NOW,
): Promise<void> {
	await adjustMemberPoints(orgId, {
		memberId,
		delta: points,
		reason: 'goodwill',
		note: 'test points',
		actorId: ACTOR,
		idempotencyKey: `give-${++giveCounter}`,
		now,
	})
}

export async function balanceOf(orgId: string, memberId: string) {
	const db = await getTenantDb(orgId)
	return readBalanceViewInTx(db, memberId)
}

export async function storedBalanceOf(orgId: string, memberId: string) {
	const db = await getTenantDb(orgId)
	return db
		.select()
		.from(loyaltyBalances)
		.where(eq(loyaltyBalances.memberId, memberId))
		.get()
}

// ---------------------------------------------------------------------------
// Carts and order-channel rows
// ---------------------------------------------------------------------------

export function cartLine(
	overrides: Partial<LoyaltyCartLine> = {},
): LoyaltyCartLine {
	return {
		lineId: '0',
		itemId: 'item_1',
		variantId: null,
		categoryIds: [],
		quantity: 1,
		unitBaseMinor: 1000,
		unitMinor: 1000,
		...overrides,
	}
}

export function loyaltyCart(
	lines: LoyaltyCartLine[] = [cartLine()],
	currency = 'USD',
): LoyaltyCart {
	return { currency, lines, otherDiscountMinor: 0 }
}

export function orderLine(
	overrides: Partial<PricedOrderLine> = {},
): PricedOrderLine {
	const merged = {
		itemId: 'item_1',
		itemName: 'Test item',
		variantId: null,
		quantity: 1,
		unitPriceCents: 1000,
		taxableUnitCents: 1000,
		instructions: null,
		options: [] as PricedOrderLine['options'],
		baseUnitCents: 1000,
		categoryIds: [] as string[],
		...overrides,
	}
	return {
		...merged,
		totalCents: overrides.totalCents ?? merged.unitPriceCents * merged.quantity,
		taxableCents:
			overrides.taxableCents ?? merged.taxableUnitCents * merged.quantity,
	}
}

let orderCounter = 0

export async function insertOrder(
	orgId: string,
	overrides: Partial<typeof restaurantOrders.$inferInsert> = {},
): Promise<string> {
	const db = await getTenantDb(orgId)
	const n = ++orderCounter
	const id = overrides.id ?? `ord_${n}`
	const subtotal = overrides.subtotalCents ?? 1000
	const loyaltyDiscount = overrides.loyaltyDiscountCents ?? 0
	await db.insert(restaurantOrders).values({
		orgId,
		number: `N-${n}`,
		status: 'completed',
		paymentMethod: 'online',
		paymentStatus: 'paid',
		fulfillment: 'pickup',
		locationId: LOC_1,
		locationName: 'Test location',
		contactName: 'Test',
		contactPhone: '+14155550100',
		currency: 'USD',
		subtotalCents: subtotal,
		taxCents: 0,
		totalCents: subtotal - loyaltyDiscount,
		lines: [orderLine()],
		idempotencyKey: `idem-${id}`,
		requestHash: `hash-${id}`,
		receiptTokenHash: `receipt-${id}`,
		paidAt: new Date(NOW),
		completedAt: new Date(NOW),
		...overrides,
		id,
	})
	return id
}

let tableCounter = 0

export async function insertQrTable(
	orgId: string,
	input: { id?: string; locationId?: string } = {},
): Promise<string> {
	const db = await getTenantDb(orgId)
	const id = input.id ?? `tbl_${++tableCounter}`
	await db
		.insert(qrTables)
		.values({ id, locationId: input.locationId ?? LOC_1, label: `Table ${id}` })
	return id
}

let tabCounter = 0

export async function insertTab(
	orgId: string,
	overrides: Partial<typeof qrTabs.$inferInsert> = {},
): Promise<string> {
	const db = await getTenantDb(orgId)
	const n = ++tabCounter
	const id = overrides.id ?? `tab_${n}`
	const tableId = overrides.tableId ?? (await insertQrTable(orgId))
	const subtotal = overrides.subtotalCents ?? 1000
	const loyaltyDiscount = overrides.loyaltyDiscountCents ?? 0
	await db.insert(qrTabs).values({
		tableId,
		locationId: LOC_1,
		tableLabel: 'Table',
		status: 'closed',
		tabNumber: `T-${n}`,
		openedDay: '2026-01-10',
		currency: 'USD',
		subtotalCents: subtotal,
		taxCents: 0,
		totalCents: subtotal - loyaltyDiscount,
		paymentMethod: 'online',
		paymentStatus: 'paid',
		openedAt: NOW - HOUR,
		paidAt: NOW,
		closedAt: NOW,
		updatedAt: NOW,
		...overrides,
		id,
	})
	return id
}

/** A round of a QR tab: a dine-in handoff order that belongs to the tab. */
export async function insertRound(
	orgId: string,
	tabId: string,
	overrides: Partial<typeof restaurantOrders.$inferInsert> = {},
): Promise<string> {
	return insertOrder(orgId, {
		tabId,
		status: 'completed',
		paymentMethod: 'handoff',
		paymentStatus: 'unpaid',
		fulfillment: 'dine_in',
		source: 'qr_table',
		paidAt: null,
		...overrides,
	})
}

let deviceCounter = 0

export async function insertPosDevice(
	orgId: string,
	input: { id?: string; locationId?: string } = {},
): Promise<string> {
	const db = await getTenantDb(orgId)
	const id = input.id ?? `dev_${++deviceCounter}`
	await db.insert(posDevices).values({
		id,
		label: `Till ${id}`,
		terminalCode: id.slice(-4).toUpperCase(),
		locationId: input.locationId ?? LOC_1,
		secretHash: `secret-${id}`,
		pairedBy: ACTOR,
	})
	return id
}

let saleCounter = 0

export async function insertPosSale(
	orgId: string,
	overrides: Partial<typeof posOrders.$inferInsert> = {},
): Promise<string> {
	const db = await getTenantDb(orgId)
	const n = ++saleCounter
	const id = overrides.id ?? `sale_${n}`
	const deviceId = overrides.deviceId ?? (await insertPosDevice(orgId))
	await db.insert(posOrders).values({
		deviceId,
		number: `P-${n}`,
		businessDate: '2026-01-10',
		revision: 1,
		status: 'paid',
		orderType: 'takeaway',
		locationId: LOC_1,
		currency: 'USD',
		subtotalCents: 1000,
		taxCents: 0,
		totalCents: 1000,
		lines: [],
		adjustments: [],
		rungUpAt: NOW,
		receivedAt: NOW,
		paidAt: NOW,
		...overrides,
		id,
	})
	return id
}

// ---------------------------------------------------------------------------
// Loyalty flows
// ---------------------------------------------------------------------------

export async function claimAndQueue(
	orgId: string,
	input: {
		memberId: string
		source: LoyaltySourceRef
		locationId?: string | null
		currency?: string
		at?: number
	},
): Promise<PurchaseRow> {
	return withLoyaltyWrite({ orgId, now: input.at ?? NOW }, async (tx, ctx) => {
		const member = await readMemberInTx(tx, input.memberId)
		if (!member) throw new Error(`no member ${input.memberId}`)
		const purchase = await claimPurchaseInTx(tx, {
			member,
			source: input.source,
			locationId: input.locationId === undefined ? LOC_1 : input.locationId,
			currency: input.currency ?? 'USD',
			at: ctx.now,
		})
		await queueLoyaltySourceInTx(tx, input.source, ctx.now)
		return purchase
	})
}

export async function reserveReward(
	orgId: string,
	input: {
		memberId: string
		rewardId: string
		cart?: LoyaltyCart
		source?: { type: LoyaltyPurchaseSource; id: string } | null
		channel?: 'web' | 'pos' | 'qr' | 'native'
		deviceId?: string | null
		locationId?: string | null
		at?: number
	},
): Promise<RedemptionRow> {
	return withLoyaltyWrite({ orgId, now: input.at ?? NOW }, async (tx, ctx) => {
		const member = await readMemberInTx(tx, input.memberId)
		if (!member) throw new Error(`no member ${input.memberId}`)
		const reward = await readRewardInTx(tx, input.rewardId)
		if (!reward) throw new Error(`no reward ${input.rewardId}`)
		const cart = input.cart ?? loyaltyCart()
		return reserveRedemptionInTx(tx, {
			member,
			reward: reward.snapshot,
			cart,
			cartHash: await hashLoyaltyCart(cart),
			targetLineId: null,
			channel: input.channel ?? 'web',
			source: input.source ?? null,
			deviceId: input.deviceId ?? null,
			locationId: input.locationId === undefined ? LOC_1 : input.locationId,
			at: ctx.now,
		})
	})
}

/**
 * Throws when any stored balance differs from its rebuild from the ledger and
 * the held redemptions. Scenario suites run it after every test.
 */
export async function assertBalancesMatchLedger(orgId: string): Promise<void> {
	const db = await getTenantDb(orgId)
	let afterMemberId: string | null = null
	do {
		const page: Awaited<ReturnType<typeof findBalanceMismatches>> =
			await findBalanceMismatches(db, { afterMemberId })
		if (page.mismatches.length > 0) {
			throw new Error(
				`balances differ from the ledger: ${JSON.stringify(page.mismatches)}`,
			)
		}
		afterMemberId = page.nextMemberId
	} while (afterMemberId)
}

/** Awaits a rejection and returns the loyalty error; anything else rethrows. */
export async function loyaltyError(
	promise: Promise<unknown>,
): Promise<LoyaltyDomainError> {
	try {
		await promise
	} catch (error) {
		if (error instanceof LoyaltyDomainError) return error
		throw error
	}
	throw new Error('expected a LoyaltyDomainError')
}

export async function expectLoyaltyError(
	promise: Promise<unknown>,
	code: LoyaltyErrorCode,
	details?: Record<string, unknown>,
): Promise<LoyaltyDomainError> {
	const error = await loyaltyError(promise)
	if (error.code !== code) {
		throw new Error(`expected ${code}, got ${error.code}`)
	}
	for (const [key, expected] of Object.entries(details ?? {})) {
		const actual: unknown = error.details?.[key]
		if (JSON.stringify(actual) !== JSON.stringify(expected)) {
			throw new Error(
				`expected ${code} with ${key} ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
			)
		}
	}
	return error
}
