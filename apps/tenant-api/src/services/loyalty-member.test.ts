import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { type LoyaltyFeatures } from '@repo/loyalty'
import {
	destroyTenantDb,
	getTenantDb,
	customers,
	loyaltyApprovals,
	loyaltyAuditLog,
	loyaltyMemberBindings,
	loyaltyMemberCodes,
	loyaltyMembers,
	provisionTenantDb,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { withLoyaltyWrite } from '../lib/loyalty-write.ts'
import { postLedgerEntryInTx } from './loyalty-ledger.ts'
import {
	adjustMemberPoints,
	ensureMemberForCustomer,
	getMemberDetail,
	getMemberHistory,
	getWallet,
	getMemberForCustomer,
	setMemberStatus,
} from './loyalty-member-service.ts'
import {
	activateProgram,
	balanceOf,
	expectLoyaltyError,
	givePoints,
	insertCustomer,
	LOC_1,
	LOC_2,
	makeMember,
	makeReward,
	memberRow,
	NOW,
	reserveReward,
	saveDraftProgram,
} from './loyalty-test-fixture.ts'
import { erasePerson } from './person-erasure-service.ts'

const ORG = 'org_ll_member'

const FEATURES_ON: LoyaltyFeatures = {
	enabled: true,
	redemption: true,
}

let directory: string
let customerCounter = 0

async function newCustomer(
	input: { name?: string; phone?: string | null; verified?: boolean } = {},
): Promise<string> {
	const id = `cus_${++customerCounter}`
	await insertCustomer(ORG, { id, ...input })
	return id
}

beforeEach(async () => {
	directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loyalty-member-'))
	vi.stubEnv('TENANT_DB_DIR', directory)
	vi.stubEnv('DATA_REGION', 'us')
	vi.stubEnv('AUTH_HMAC_SECRET', 'test-hmac-secret-123456789')
	await provisionTenantDb(ORG)
	await activateProgram(ORG)
})

afterEach(async () => {
	await destroyTenantDb(ORG).catch(() => {})
	fs.rmSync(directory, { recursive: true, force: true })
	vi.unstubAllEnvs()
})

describe('ensureMemberForCustomer (the automatic link)', () => {
	it('opens one points account for a verified customer; asking again is the same account', async () => {
		const customerId = await newCustomer()
		const first = await ensureMemberForCustomer(ORG, { customerId, now: NOW })
		expect(first).toMatchObject({
			customerId,
			status: 'active',
			createdAt: NOW,
		})
		const second = await ensureMemberForCustomer(ORG, {
			customerId,
			now: NOW + 1000,
		})
		expect(second!.id).toBe(first!.id)
		// The day the account was opened is kept, not moved by the second call.
		expect(second!.createdAt).toBe(NOW)
		// The balance row exists from the start.
		expect(await balanceOf(ORG, first!.id)).toMatchObject({
			points: 0,
			reserved: 0,
		})
	})

	it('opens exactly one account under 20 concurrent calls', async () => {
		const customerId = await newCustomer()
		const results = await Promise.all(
			Array.from({ length: 20 }, () =>
				ensureMemberForCustomer(ORG, { customerId, now: NOW }),
			),
		)
		expect(new Set(results.map((member) => member!.id)).size).toBe(1)
		const db = await getTenantDb(ORG)
		const rows = await db
			.select()
			.from(loyaltyMembers)
			.where(eq(loyaltyMembers.customerId, customerId))
		expect(rows).toHaveLength(1)
	})

	it('never links a customer whose phone was not verified', async () => {
		const customerId = await newCustomer({ verified: false })
		expect(await ensureMemberForCustomer(ORG, { customerId })).toBeNull()
		const db = await getTenantDb(ORG)
		expect(await db.select().from(loyaltyMembers)).toHaveLength(0)
	})

	it('links nobody for a customer that does not exist', async () => {
		expect(
			await ensureMemberForCustomer(ORG, { customerId: 'cus_missing' }),
		).toBeNull()
	})

	it('opens nothing while the program is a draft or paused', async () => {
		const org = 'org_ll_member_draft'
		await provisionTenantDb(org)
		await saveDraftProgram(org)
		await insertCustomer(org, { id: 'cus_draft' })
		expect(
			await ensureMemberForCustomer(org, { customerId: 'cus_draft' }),
		).toBeNull()
		await destroyTenantDb(org).catch(() => {})

		const customerId = await newCustomer()
		const { setProgramStatus } = await import('./loyalty-program-service.ts')
		await setProgramStatus(ORG, {
			expectedVersion: 2,
			status: 'paused',
			actorId: 'op_test',
			now: NOW + 1000,
		})
		expect(await ensureMemberForCustomer(ORG, { customerId })).toBeNull()
		const db = await getTenantDb(ORG)
		expect(await db.select().from(loyaltyMembers)).toHaveLength(0)
	})

	it('opens nothing without a program at all', async () => {
		const org = 'org_ll_member_none'
		await provisionTenantDb(org)
		await insertCustomer(org, { id: 'cus_none' })
		expect(
			await ensureMemberForCustomer(org, { customerId: 'cus_none' }),
		).toBeNull()
		await destroyTenantDb(org).catch(() => {})
	})

	it('leaves a suspended account suspended', async () => {
		const customerId = await newCustomer()
		const memberId = await makeMember(ORG, { customerId })
		await setMemberStatus(ORG, {
			memberId,
			status: 'suspended',
			actorId: 'op_test',
			now: NOW + 1000,
		})
		const again = await ensureMemberForCustomer(ORG, {
			customerId,
			now: NOW + 2000,
		})
		expect(again).toMatchObject({ id: memberId, status: 'suspended' })
		expect((await memberRow(ORG, memberId)).status).toBe('suspended')
	})

	it('never recreates the account of an erased person', async () => {
		const customerId = await newCustomer({ name: 'Erased Person' })
		const memberId = await makeMember(ORG, { customerId })
		const db = await getTenantDb(ORG)
		await erasePerson(db, { customerId }, { actorId: 'op_test', now: NOW + 1 })
		expect((await memberRow(ORG, memberId)).status).toBe('erased')
		expect(await ensureMemberForCustomer(ORG, { customerId })).toBeNull()
		expect(await db.select().from(loyaltyMembers)).toHaveLength(1)
	})

	it('never touches marketing consent', async () => {
		const customerId = await newCustomer()
		const db = await getTenantDb(ORG)
		const before = await db
			.select()
			.from(customers)
			.where(eq(customers.id, customerId))
			.get()
		await ensureMemberForCustomer(ORG, { customerId })
		const after = await db
			.select()
			.from(customers)
			.where(eq(customers.id, customerId))
			.get()
		expect(after).toEqual(before)
	})
})

describe('getWallet', () => {
	it('is null while loyalty is off, and memberless until the account is opened', async () => {
		const db = await getTenantDb(ORG)
		const customerId = await newCustomer()
		expect(
			await getWallet(db, {
				customerId,
				features: { enabled: false, redemption: false },
				now: NOW,
			}),
		).toBeNull()
		const wallet = await getWallet(db, {
			customerId,
			features: FEATURES_ON,
			now: NOW,
		})
		expect(wallet).toMatchObject({ member: null, balance: null })
	})

	it('shows balance, next-reward progress and pending approvals', async () => {
		const customerId = await newCustomer()
		const memberId = await makeMember(ORG, { customerId })
		const reward = await makeReward(ORG) // 10 points
		await givePoints(ORG, memberId, 4)
		const db = await getTenantDb(ORG)
		await db.insert(loyaltyApprovals).values({
			memberId,
			deviceId: 'dev_1',
			saleId: 'sale_pending',
			rewardId: reward.id,
			rewardVersion: 1,
			rewardName: 'Five off',
			pointsCost: 10,
			currency: 'USD',
			discountMinor: 500,
			allocation: [],
			cart: { currency: 'USD', lines: [], otherDiscountMinor: 0 },
			cartHash: 'hash',
			status: 'pending',
			expiresAt: NOW + 60_000,
			createdAt: NOW,
			updatedAt: NOW,
		})
		const wallet = await getWallet(db, {
			customerId,
			features: FEATURES_ON,
			now: NOW,
		})
		expect(wallet!.member).toMatchObject({ id: memberId, status: 'active' })
		expect(wallet!.balance).toMatchObject({ points: 4, available: 4 })
		expect(wallet!.nextReward).toEqual({
			rewardId: reward.id,
			pointsNeeded: 6,
		})
		expect(wallet!.pendingApprovals).toBe(1)

		await givePoints(ORG, memberId, 6)
		const rich = await getWallet(db, {
			customerId,
			features: FEATURES_ON,
			now: NOW,
		})
		expect(rich!.nextReward).toBeNull()
	})
})

describe('getMemberHistory', () => {
	it('pages newest first with an opaque cursor', async () => {
		const customerId = await newCustomer()
		const memberId = await makeMember(ORG, { customerId })
		for (let i = 1; i <= 3; i++) {
			await adjustMemberPoints(ORG, {
				memberId,
				delta: i,
				reason: 'goodwill',
				note: `gift ${i}`,
				actorId: 'op_test',
				idempotencyKey: `hist-${i}`,
				now: NOW + i * 1000,
			})
		}
		const db = await getTenantDb(ORG)
		const page1 = await getMemberHistory(db, { memberId, limit: 2 })
		expect(page1.entries.map((e) => e.delta)).toEqual([3, 2])
		expect(page1.nextCursor).not.toBeNull()
		const page2 = await getMemberHistory(db, {
			memberId,
			cursor: page1.nextCursor,
			limit: 2,
		})
		expect(page2.entries.map((e) => e.delta)).toEqual([1])
		expect(page2.nextCursor).toBeNull()
		// Adjustment entries carry their reason.
		expect(page1.entries[0]).toMatchObject({
			type: 'adjust',
			reason: 'goodwill',
		})
	})

	it('rejects a malformed cursor', async () => {
		const customerId = await newCustomer()
		const memberId = await makeMember(ORG, { customerId })
		const db = await getTenantDb(ORG)
		await expectLoyaltyError(
			getMemberHistory(db, { memberId, cursor: '!!!nope' }),
			'invalid_request',
		)
	})
})

describe('adjustMemberPoints', () => {
	it('posts an audited adjustment, once per idempotency key', async () => {
		const customerId = await newCustomer()
		const memberId = await makeMember(ORG, { customerId })
		const input = {
			memberId,
			delta: 12,
			reason: 'service_recovery' as const,
			note: 'bad evening',
			actorId: 'op_test',
			idempotencyKey: 'adj-1',
			now: NOW,
		}
		const first = await adjustMemberPoints(ORG, input)
		expect(first.balance.points).toBe(12)
		const second = await adjustMemberPoints(ORG, input)
		expect(second.entry.id).toBe(first.entry.id)
		expect(second.balance.points).toBe(12)

		const db = await getTenantDb(ORG)
		const audits = await db
			.select()
			.from(loyaltyAuditLog)
			.where(eq(loyaltyAuditLog.entityId, memberId))
		expect(audits).toHaveLength(1)
		expect(audits[0]).toMatchObject({
			action: 'points.adjusted',
			actorKind: 'operator',
			actorId: 'op_test',
		})
		expect(audits[0]!.changes).toMatchObject({
			delta: 12,
			reason: 'service_recovery',
		})
		// The note never echoes member PII; it is the operator's own words.
		expect(first.entry).toMatchObject({
			type: 'adjust',
			delta: 12,
			note: 'bad evening',
		})
	})

	it('may take a member into points debt', async () => {
		const customerId = await newCustomer()
		const memberId = await makeMember(ORG, { customerId })
		const result = await adjustMemberPoints(ORG, {
			memberId,
			delta: -7,
			reason: 'correction',
			note: 'claw back',
			actorId: 'op_test',
			idempotencyKey: 'adj-debt',
			now: NOW,
		})
		expect(result.balance).toMatchObject({ points: -7, available: -7 })
	})

	it('refuses unknown members and zero deltas', async () => {
		await expectLoyaltyError(
			adjustMemberPoints(ORG, {
				memberId: 'member_missing',
				delta: 5,
				reason: 'other',
				note: 'nope',
				actorId: 'op_test',
				idempotencyKey: 'adj-x',
				now: NOW,
			}),
			'member_not_found',
		)
		const customerId = await newCustomer()
		const memberId = await makeMember(ORG, { customerId })
		await expectLoyaltyError(
			adjustMemberPoints(ORG, {
				memberId,
				delta: 0,
				reason: 'other',
				note: 'zero',
				actorId: 'op_test',
				idempotencyKey: 'adj-zero',
				now: NOW,
			}),
			'adjustment_invalid',
		)
	})
})

describe('setMemberStatus', () => {
	it('suspending closes codes, bindings, approvals and unbound holds', async () => {
		const customerId = await newCustomer()
		const memberId = await makeMember(ORG, { customerId })
		const reward = await makeReward(ORG)
		await givePoints(ORG, memberId, 30)
		const hold = await reserveReward(ORG, { memberId, rewardId: reward.id })
		expect((await balanceOf(ORG, memberId)).reserved).toBe(10)
		const db = await getTenantDb(ORG)
		await db.insert(loyaltyMemberCodes).values({
			memberId,
			codeHash: 'code-hash-1',
			expiresAt: NOW + 60_000,
			createdAt: NOW,
		})
		await db.insert(loyaltyMemberBindings).values({
			memberId,
			deviceId: 'dev_1',
			tokenHash: 'binding-hash-1',
			expiresAt: NOW + 60_000,
			createdAt: NOW,
		})
		await db.insert(loyaltyApprovals).values({
			memberId,
			deviceId: 'dev_1',
			saleId: 'sale_1',
			rewardId: reward.id,
			rewardVersion: 1,
			rewardName: 'Five off',
			pointsCost: 10,
			currency: 'USD',
			discountMinor: 500,
			allocation: [],
			cart: { currency: 'USD', lines: [], otherDiscountMinor: 0 },
			cartHash: 'hash',
			status: 'pending',
			expiresAt: NOW + 60_000,
			createdAt: NOW,
			updatedAt: NOW,
		})

		const suspended = await setMemberStatus(ORG, {
			memberId,
			status: 'suspended',
			actorId: 'op_test',
			now: NOW + 1000,
		})
		expect(suspended.status).toBe('suspended')
		expect(await balanceOf(ORG, memberId)).toMatchObject({
			points: 30,
			reserved: 0,
		})
		expect(
			await db
				.select()
				.from(loyaltyMemberCodes)
				.where(eq(loyaltyMemberCodes.memberId, memberId)),
		).toHaveLength(0)
		const bindings = await db
			.select()
			.from(loyaltyMemberBindings)
			.where(eq(loyaltyMemberBindings.memberId, memberId))
		expect(bindings[0]!.revokedAt).toBe(NOW + 1000)
		const approvals = await db
			.select()
			.from(loyaltyApprovals)
			.where(eq(loyaltyApprovals.memberId, memberId))
		expect(approvals[0]!.status).toBe('cancelled')
		const { readRedemptionInTx } =
			await import('./loyalty-redemption-service.ts')
		expect((await readRedemptionInTx(db, hold.id))!.state).toBe('released')

		// A suspended account stays suspended when the customer signs in again.
		expect(
			(await ensureMemberForCustomer(ORG, { customerId, now: NOW + 2000 }))!
				.status,
		).toBe('suspended')

		const reinstated = await setMemberStatus(ORG, {
			memberId,
			status: 'active',
			actorId: 'op_test',
			now: NOW + 3000,
		})
		expect(reinstated.status).toBe('active')
	})
})

describe('operator member views', () => {
	it('shows the account the customer page links to, with the customer id', async () => {
		const customerId = await newCustomer({
			name: 'Alice Nadir',
			phone: '+14155550111',
		})
		const memberId = await makeMember(ORG, { customerId, now: NOW })
		await givePoints(ORG, memberId, 5)
		const db = await getTenantDb(ORG)
		const summary = await getMemberForCustomer(db, customerId)
		expect(summary).toMatchObject({
			id: memberId,
			customerId,
			name: 'Alice Nadir',
			phoneLast4: '0111',
			status: 'active',
			createdAt: NOW,
			balance: { points: 5 },
		})
		// A customer with no account has none to show.
		const other = await newCustomer({ verified: false })
		expect(await getMemberForCustomer(db, other)).toBeNull()
		// The detail and its ledger entries carry the customer id too.
		const detail = await getMemberDetail(db, { memberId, locationIds: null })
		expect(detail!.member.customerId).toBe(customerId)
		expect(detail!.entries.every((e) => e.customerId === customerId)).toBe(true)
	})

	it('shows lifetime earned and redeemed in the member summary and detail', async () => {
		const customerId = await newCustomer()
		const memberId = await makeMember(ORG, { customerId })
		await withLoyaltyWrite({ orgId: ORG, now: NOW }, async (tx) => {
			await postLedgerEntryInTx(tx, {
				memberId,
				type: 'earn',
				delta: 30,
				eventKey: 'earn:lifetime',
				actorKind: 'system',
				at: NOW,
			})
			await postLedgerEntryInTx(tx, {
				memberId,
				type: 'redeem',
				delta: -10,
				eventKey: 'redeem:lifetime',
				actorKind: 'system',
				at: NOW + 1000,
			})
		})
		const db = await getTenantDb(ORG)
		const summary = await getMemberForCustomer(db, customerId)
		expect(summary!.balance).toEqual({
			points: 20,
			reserved: 0,
			available: 20,
			lifetimeEarned: 30,
			lifetimeRedeemed: 10,
		})
		const detail = await getMemberDetail(db, { memberId, locationIds: null })
		expect(detail!.member.balance).toMatchObject({
			lifetimeEarned: 30,
			lifetimeRedeemed: 10,
		})
		// An adjustment answers with the same operator figures (it moves points, not the lifetime totals).
		const adjusted = await adjustMemberPoints(ORG, {
			memberId,
			delta: 5,
			reason: 'goodwill',
			note: 'thanks',
			actorId: 'op_test',
			idempotencyKey: 'adj-lifetime',
			now: NOW + 2000,
		})
		expect(adjusted.balance).toMatchObject({
			points: 25,
			lifetimeEarned: 30,
			lifetimeRedeemed: 10,
		})
		// The wallet keeps its own, smaller shape.
		const wallet = await getWallet(db, {
			customerId,
			features: FEATURES_ON,
			now: NOW,
		})
		expect(wallet!.balance).not.toHaveProperty('lifetimeEarned')
	})

	it('hides activity at locations the operator cannot see, and says so', async () => {
		const customerId = await newCustomer()
		const memberId = await makeMember(ORG, { customerId })
		await withLoyaltyWrite({ orgId: ORG, now: NOW }, async (tx) => {
			await postLedgerEntryInTx(tx, {
				memberId,
				type: 'earn',
				delta: 5,
				eventKey: 'earn:loc1',
				locationId: LOC_1,
				actorKind: 'system',
				at: NOW,
			})
			await postLedgerEntryInTx(tx, {
				memberId,
				type: 'earn',
				delta: 7,
				eventKey: 'earn:loc2',
				locationId: LOC_2,
				actorKind: 'system',
				at: NOW,
			})
			// Organization-wide entries have no location and are always visible.
			await postLedgerEntryInTx(tx, {
				memberId,
				type: 'adjust',
				delta: 1,
				eventKey: 'adjust:org-wide',
				reason: 'goodwill',
				actorKind: 'operator',
				actorId: 'op_test',
				at: NOW,
			})
		})
		const db = await getTenantDb(ORG)
		const full = await getMemberDetail(db, { memberId, locationIds: null })
		expect(full!.entries).toHaveLength(3)
		expect(full!.filteredByLocation).toBe(false)

		const scoped = await getMemberDetail(db, {
			memberId,
			locationIds: [LOC_1],
		})
		expect(scoped!.entries.map((e) => e.eventKey ?? e.delta).sort()).toEqual([
			1, 5,
		])
		expect(scoped!.filteredByLocation).toBe(true)
		expect(scoped!.entries.every((e) => e.locationId !== LOC_2)).toBe(true)
	})

	it('returns null for an unknown member', async () => {
		const db = await getTenantDb(ORG)
		expect(
			await getMemberDetail(db, {
				memberId: 'member_missing',
				locationIds: null,
			}),
		).toBeNull()
	})
})
