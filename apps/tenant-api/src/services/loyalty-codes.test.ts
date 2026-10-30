import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
	LOYALTY_APPROVAL_TTL_MS,
	LOYALTY_BINDING_TTL_MS,
	LOYALTY_MEMBER_CODE_TTL_MS,
	LOYALTY_OTP_MAX_ATTEMPTS,
} from '@repo/loyalty'
import { sendSms } from '@repo/sms'
import {
	destroyTenantDb,
	getTenantDb,
	loyaltyApprovals,
	loyaltyMemberCodes,
	loyaltyMembers,
	provisionTenantDb,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { withLoyaltyWrite } from '../lib/loyalty-write.ts'
import {
	cancelTillApproval,
	decideCustomerApproval,
	expireLoyaltyApprovalsInTx,
	identifyMemberByCode,
	issueMemberCode,
	listCustomerApprovals,
	purgeLoyaltyAccessInTx,
	quoteForTill,
	readTillApproval,
	readTillMember,
	requestTillApproval,
	resolveBindingInTx,
	revokeTillBinding,
	sendTillApprovalOtp,
	verifyTillApprovalOtp,
	type TillDevice,
} from './loyalty-code-service.ts'
import { setMemberStatus } from './loyalty-member-service.ts'
import {
	readProgramInTx,
	saveProgram,
	updateReward,
} from './loyalty-program-service.ts'
import { readRedemptionInTx } from './loyalty-redemption-service.ts'
import { revokeDevice } from './pos-service.ts'
import {
	activateProgram,
	balanceOf,
	expectLoyaltyError,
	givePoints,
	insertCustomer,
	insertPosDevice,
	insertPosSale,
	LOC_1,
	loyaltyCart,
	makeMember,
	makeReward,
	NOW,
	programConfig,
	rewardDefinition,
} from './loyalty-test-fixture.ts'

vi.mock('@repo/sms', () => ({ sendSms: vi.fn() }))

const sms = vi.mocked(sendSms)

const ORG = 'org_ll_codes'
const ACTOR = 'op_test'
const FEATURES = { enabled: true, redemption: true }

let directory: string
let customerCounter = 0
let device: TillDevice

async function member(
	points = 0,
): Promise<{ memberId: string; customerId: string }> {
	const customerId = `cus_${++customerCounter}`
	await insertCustomer(ORG, {
		id: customerId,
		name: 'Ada Lovelace',
		phone: `+155500${String(customerCounter).padStart(5, '0')}`,
		verified: true,
	})
	const memberId = await makeMember(ORG, { customerId })
	if (points > 0) await givePoints(ORG, memberId, points)
	return { memberId, customerId }
}

/** A member identified at the till: code issued, read, binding in hand. */
async function identify(points = 0) {
	const { memberId, customerId } = await member(points)
	const { code } = await issueMemberCode(ORG, {
		customerId,
		features: FEATURES,
		now: NOW,
	})
	const till = await identifyMemberByCode(ORG, {
		code,
		device,
		features: FEATURES,
		now: NOW,
	})
	return { memberId, customerId, binding: till.member.binding, till }
}

/** A member at the till with a pending spend request for `sale_1`. */
async function requestedSale(memberPoints = 10, saleId = 'sale_1') {
	const identified = await identify(memberPoints)
	const reward = await makeReward(ORG)
	const approval = await requestTillApproval(ORG, {
		binding: identified.binding,
		device,
		rewardId: reward.id,
		rewardVersion: 1,
		saleId,
		cart: loyaltyCart(),
		targetLineId: null,
		features: FEATURES,
		now: NOW,
	})
	return { ...identified, reward, approval }
}

async function approvalRow(id: string) {
	const db = await getTenantDb(ORG)
	return db
		.select()
		.from(loyaltyApprovals)
		.where(eq(loyaltyApprovals.id, id))
		.get()
}

async function redemptionRow(id: string | null) {
	if (!id) return null
	const db = await getTenantDb(ORG)
	return readRedemptionInTx(db, id)
}

beforeEach(async () => {
	directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loyalty-codes-'))
	vi.stubEnv('TENANT_DB_DIR', directory)
	vi.stubEnv('DATA_REGION', 'us')
	vi.stubEnv('AUTH_HMAC_SECRET', 'test-hmac-secret-123456789')
	await provisionTenantDb(ORG)
	await activateProgram(ORG)
	device = { id: await insertPosDevice(ORG), locationId: LOC_1 }
	sms.mockReset()
	sms.mockResolvedValue(undefined as never)
})

afterEach(async () => {
	await destroyTenantDb(ORG).catch(() => {})
	fs.rmSync(directory, { recursive: true, force: true })
	vi.unstubAllEnvs()
})

describe('member codes', () => {
	it('a member has one live code: asking again kills the previous one', async () => {
		const { customerId } = await member()
		const first = await issueMemberCode(ORG, {
			customerId,
			features: FEATURES,
			now: NOW,
		})
		expect(first.expiresAt).toBe(NOW + LOYALTY_MEMBER_CODE_TTL_MS)
		const second = await issueMemberCode(ORG, {
			customerId,
			features: FEATURES,
			now: NOW,
		})
		expect(second.code).not.toBe(first.code)
		await expectLoyaltyError(
			identifyMemberByCode(ORG, {
				code: first.code,
				device,
				features: FEATURES,
				now: NOW,
			}),
			'code_invalid',
		)
		const till = await identifyMemberByCode(ORG, {
			code: second.code,
			device,
			features: FEATURES,
			now: NOW,
		})
		expect(till.member.firstName).toBe('Ada')
	})

	it('needs a customer who can have a points account, behind an enabled program', async () => {
		await expectLoyaltyError(
			issueMemberCode(ORG, {
				customerId: 'cus_nobody',
				features: FEATURES,
				now: NOW,
			}),
			'member_not_found',
		)
		// A phone nobody verified never gets an account, so never a code.
		await insertCustomer(ORG, { id: 'cus_unverified', verified: false })
		await expectLoyaltyError(
			issueMemberCode(ORG, {
				customerId: 'cus_unverified',
				features: FEATURES,
				now: NOW,
			}),
			'member_not_found',
		)
		await expectLoyaltyError(
			issueMemberCode(ORG, {
				customerId: 'cus_nobody',
				features: { enabled: false, redemption: true },
				now: NOW,
			}),
			'loyalty_disabled',
		)
	})

	it('opens the account of a verified customer who has none yet, then issues the code', async () => {
		await insertCustomer(ORG, { id: 'cus_early', name: 'Early' })
		const { code } = await issueMemberCode(ORG, {
			customerId: 'cus_early',
			features: FEATURES,
			now: NOW,
		})
		expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/)
		const db = await getTenantDb(ORG)
		const rows = await db
			.select()
			.from(loyaltyMembers)
			.where(eq(loyaltyMembers.customerId, 'cus_early'))
		expect(rows).toHaveLength(1)
	})

	it('reading a code uses it up; unknown, used, expired and suspended codes all answer the same', async () => {
		const { memberId, customerId } = await member()
		const { code } = await issueMemberCode(ORG, {
			customerId,
			features: FEATURES,
			now: NOW,
		})
		const till = await identifyMemberByCode(ORG, {
			code,
			device,
			features: FEATURES,
			now: NOW,
		})
		expect(till.member.binding).toMatch(/^lmb1\./)
		expect(till.member.bindingExpiresAt).toBe(NOW + LOYALTY_BINDING_TTL_MS)

		// Second read: the code is spent.
		await expectLoyaltyError(
			identifyMemberByCode(ORG, {
				code,
				device,
				features: FEATURES,
				now: NOW,
			}),
			'code_invalid',
		)
		// A code that never existed.
		await expectLoyaltyError(
			identifyMemberByCode(ORG, {
				code: 'AAAA-AAAA',
				device,
				features: FEATURES,
				now: NOW,
			}),
			'code_invalid',
		)
		// Garbage input.
		await expectLoyaltyError(
			identifyMemberByCode(ORG, {
				code: '!!!',
				device,
				features: FEATURES,
				now: NOW,
			}),
			'code_invalid',
		)
		// Expired.
		const fresh = await issueMemberCode(ORG, {
			customerId,
			features: FEATURES,
			now: NOW,
		})
		await expectLoyaltyError(
			identifyMemberByCode(ORG, {
				code: fresh.code,
				device,
				features: FEATURES,
				now: NOW + LOYALTY_MEMBER_CODE_TTL_MS,
			}),
			'code_invalid',
		)
		// A suspended member's unused code dies too.
		const last = await issueMemberCode(ORG, {
			customerId,
			features: FEATURES,
			now: NOW,
		})
		await setMemberStatus(ORG, {
			memberId,
			status: 'suspended',
			note: 'check',
			actorId: ACTOR,
			now: NOW,
		})
		await expectLoyaltyError(
			identifyMemberByCode(ORG, {
				code: last.code,
				device,
				features: FEATURES,
				now: NOW,
			}),
			'code_invalid',
		)
	})
})

describe('till bindings', () => {
	it('resolves only for the same terminal, inside its lifetime', async () => {
		const { memberId, binding } = await identify()
		const db = await getTenantDb(ORG)
		const resolved = await resolveBindingInTx(db, ORG, {
			binding,
			deviceId: device.id,
			at: NOW,
		})
		expect(resolved.member.id).toBe(memberId)

		// Another terminal cannot use it.
		await expectLoyaltyError(
			resolveBindingInTx(db, ORG, {
				binding,
				deviceId: 'dev_other',
				at: NOW,
			}),
			'binding_invalid',
		)
		// Not before it existed, not after it ends.
		await expectLoyaltyError(
			resolveBindingInTx(db, ORG, {
				binding,
				deviceId: device.id,
				at: NOW - 1,
			}),
			'binding_invalid',
		)
		await expectLoyaltyError(
			resolveBindingInTx(db, ORG, {
				binding,
				deviceId: device.id,
				at: NOW + LOYALTY_BINDING_TTL_MS,
			}),
			'binding_invalid',
		)
		// Not a binding token at all.
		await expectLoyaltyError(
			resolveBindingInTx(db, ORG, {
				binding: 'not-a-binding',
				deviceId: device.id,
				at: NOW,
			}),
			'binding_invalid',
		)
		// Revoked by the till.
		await revokeTillBinding(ORG, { binding, device, now: NOW + 1000 })
		await expectLoyaltyError(
			resolveBindingInTx(db, ORG, {
				binding,
				deviceId: device.id,
				at: NOW + 1000,
			}),
			'binding_invalid',
		)
	})

	it('suspending the member revokes their bindings', async () => {
		const { memberId, binding } = await identify()
		await setMemberStatus(ORG, {
			memberId,
			status: 'suspended',
			note: 'check',
			actorId: ACTOR,
			now: NOW,
		})
		const db = await getTenantDb(ORG)
		await expectLoyaltyError(
			resolveBindingInTx(db, ORG, { binding, deviceId: device.id, at: NOW }),
			'binding_invalid',
		)
	})

	it('readTillMember reports the live balance and rewards', async () => {
		const { binding } = await identify(25)
		await makeReward(ORG)
		const till = await readTillMember(ORG, {
			binding,
			device,
			features: FEATURES,
			now: NOW,
		})
		expect(till.member.balance).toMatchObject({ points: 25, available: 25 })
		expect(till.member.firstName).toBe('Ada')
		expect(till.rewards).toHaveLength(1)
		expect(till.redemptionEnabled).toBe(true)
	})

	it('quoteForTill never binds points and reports what would remain', async () => {
		const { binding } = await identify(7)
		const reward = await makeReward(ORG)
		const quoted = await quoteForTill(ORG, {
			binding,
			device,
			rewardId: reward.id,
			cart: loyaltyCart(),
			targetLineId: null,
			features: FEATURES,
			now: NOW,
		})
		expect(quoted.quote).toMatchObject({
			applicable: true,
			affordable: false,
			discountMinor: 500,
		})
		expect(quoted.availableAfter).toBe(7)
		await expectLoyaltyError(
			quoteForTill(ORG, {
				binding,
				device,
				rewardId: reward.id,
				cart: loyaltyCart(),
				targetLineId: null,
				features: { enabled: true, redemption: false },
				now: NOW,
			}),
			'redemption_disabled',
		)
	})
})

describe('till approvals', () => {
	it('request -> approve binds the points to the till’s sale id', async () => {
		const { customerId, memberId, approval } = await requestedSale(10)
		expect(approval).toMatchObject({
			status: 'pending',
			saleId: 'sale_1',
			pointsCost: 10,
			discountMinor: 500,
			redemptionId: null,
			otpAvailable: true,
		})
		expect(approval.expiresAt).toBe(NOW + LOYALTY_APPROVAL_TTL_MS)

		const approved = await decideCustomerApproval(ORG, {
			customerId,
			approvalId: approval.id,
			decision: 'approve',
			features: FEATURES,
			now: NOW + 1000,
		})
		expect(approved.status).toBe('approved')
		const row = (await approvalRow(approval.id))!
		expect(row.method).toBe('wallet')
		const redemption = (await redemptionRow(row.redemptionId))!
		expect(redemption).toMatchObject({
			state: 'bound',
			sourceType: 'pos_order',
			sourceId: 'sale_1',
			approvalId: approval.id,
			points: 10,
		})
		expect(await balanceOf(ORG, memberId)).toMatchObject({
			points: 10,
			reserved: 10,
		})
	})

	it('the same terminal asking again for one sale replaces the pending request', async () => {
		const { binding } = await identify(10)
		const reward = await makeReward(ORG)
		const first = await requestTillApproval(ORG, {
			binding,
			device,
			rewardId: reward.id,
			rewardVersion: 1,
			saleId: 'sale_1',
			cart: loyaltyCart(),
			targetLineId: null,
			features: FEATURES,
			now: NOW,
		})
		const second = await requestTillApproval(ORG, {
			binding,
			device,
			rewardId: reward.id,
			rewardVersion: 1,
			saleId: 'sale_1',
			cart: loyaltyCart(),
			targetLineId: null,
			features: FEATURES,
			now: NOW + 500,
		})
		expect(second.id).not.toBe(first.id)
		expect((await approvalRow(first.id))!.status).toBe('cancelled')
		expect((await approvalRow(second.id))!.status).toBe('pending')
	})

	it('a sale id belongs to the terminal that made it', async () => {
		await requestedSale(10)
		const otherDevice = { id: await insertPosDevice(ORG), locationId: LOC_1 }
		// Another member identifies at a second terminal and asks about sale_1.
		const { memberId: otherMember, customerId: otherCustomer } =
			await member(10)
		void otherMember
		const { code } = await issueMemberCode(ORG, {
			customerId: otherCustomer,
			features: FEATURES,
			now: NOW,
		})
		const till = await identifyMemberByCode(ORG, {
			code,
			device: otherDevice,
			features: FEATURES,
			now: NOW,
		})
		const reward = await makeReward(ORG)
		await expectLoyaltyError(
			requestTillApproval(ORG, {
				binding: till.member.binding,
				device: otherDevice,
				rewardId: reward.id,
				rewardVersion: 1,
				saleId: 'sale_1',
				cart: loyaltyCart(),
				targetLineId: null,
				features: FEATURES,
				now: NOW,
			}),
			'approval_closed',
		)
	})

	it('a sale the region already holds belongs to the terminal that uploaded it', async () => {
		const { binding } = await identify(50)
		const reward = await makeReward(ORG)
		const otherDevice = { id: await insertPosDevice(ORG), locationId: LOC_1 }
		// The other terminal already uploaded this sale; no approvals exist yet.
		await insertPosSale(ORG, { id: 'sale_stored', deviceId: otherDevice.id })
		await expectLoyaltyError(
			requestTillApproval(ORG, {
				binding,
				device,
				rewardId: reward.id,
				rewardVersion: 1,
				saleId: 'sale_stored',
				cart: loyaltyCart(),
				targetLineId: null,
				features: FEATURES,
				now: NOW,
			}),
			'approval_closed',
		)
		// The terminal that uploaded the sale can still ask for it.
		const owner = await member(50)
		const { code } = await issueMemberCode(ORG, {
			customerId: owner.customerId,
			features: FEATURES,
			now: NOW,
		})
		const ownerTill = await identifyMemberByCode(ORG, {
			code,
			device: otherDevice,
			features: FEATURES,
			now: NOW,
		})
		const own = await requestTillApproval(ORG, {
			binding: ownerTill.member.binding,
			device: otherDevice,
			rewardId: reward.id,
			rewardVersion: 1,
			saleId: 'sale_stored',
			cart: loyaltyCart(),
			targetLineId: null,
			features: FEATURES,
			now: NOW,
		})
		expect((await approvalRow(own.id))!.status).toBe('pending')
	})

	it('a request checks balance and reward version; an approval holds the slot', async () => {
		const { binding } = await identify(5)
		const reward = await makeReward(ORG)
		await expectLoyaltyError(
			requestTillApproval(ORG, {
				binding,
				device,
				rewardId: reward.id,
				rewardVersion: 1,
				saleId: 'sale_poor',
				cart: loyaltyCart(),
				targetLineId: null,
				features: FEATURES,
				now: NOW,
			}),
			'insufficient_points',
			{ available: 5, pointsCost: 10 },
		)
		await expectLoyaltyError(
			requestTillApproval(ORG, {
				binding,
				device,
				rewardId: reward.id,
				rewardVersion: 2,
				saleId: 'sale_poor',
				cart: loyaltyCart(),
				targetLineId: null,
				features: FEATURES,
				now: NOW,
			}),
			'stale_version',
			{ currentVersion: 1 },
		)

		// An approved request occupies the sale's reward slot.
		const { binding: richBinding, customerId: richCustomer } =
			await identify(20)
		const approved = await requestTillApproval(ORG, {
			binding: richBinding,
			device,
			rewardId: reward.id,
			rewardVersion: 1,
			saleId: 'sale_taken',
			cart: loyaltyCart(),
			targetLineId: null,
			features: FEATURES,
			now: NOW,
		})
		await decideCustomerApproval(ORG, {
			customerId: richCustomer,
			approvalId: approved.id,
			decision: 'approve',
			features: FEATURES,
			now: NOW + 100,
		})
		await expectLoyaltyError(
			requestTillApproval(ORG, {
				binding: richBinding,
				device,
				rewardId: reward.id,
				rewardVersion: 1,
				saleId: 'sale_taken',
				cart: loyaltyCart(),
				targetLineId: null,
				features: FEATURES,
				now: NOW + 200,
			}),
			'one_reward_per_order',
		)
	})

	it('approving a reward edited since the request fails', async () => {
		const { customerId, approval } = await requestedSale(10)
		await updateReward(ORG, {
			rewardId: approval.rewardId,
			expectedVersion: 1,
			definition: rewardDefinition({ pointsCost: 12 }),
			actorId: ACTOR,
			now: NOW + 500,
		})
		await expectLoyaltyError(
			decideCustomerApproval(ORG, {
				customerId,
				approvalId: approval.id,
				decision: 'approve',
				features: FEATURES,
				now: NOW + 1000,
			}),
			'reward_unavailable',
		)
	})

	it('decisions are idempotent, and an expired request cannot be decided', async () => {
		const { customerId, approval } = await requestedSale(10)
		const declined = await decideCustomerApproval(ORG, {
			customerId,
			approvalId: approval.id,
			decision: 'decline',
			features: FEATURES,
			now: NOW,
		})
		expect(declined.status).toBe('declined')
		const again = await decideCustomerApproval(ORG, {
			customerId,
			approvalId: approval.id,
			decision: 'decline',
			features: FEATURES,
			now: NOW,
		})
		expect(again.status).toBe('declined')
		await expectLoyaltyError(
			decideCustomerApproval(ORG, {
				customerId,
				approvalId: approval.id,
				decision: 'approve',
				features: FEATURES,
				now: NOW,
			}),
			'approval_closed',
		)
		// Somebody else's request is invisible.
		const { customerId: stranger } = await member(10)
		await expectLoyaltyError(
			decideCustomerApproval(ORG, {
				customerId: stranger,
				approvalId: approval.id,
				decision: 'approve',
				features: FEATURES,
				now: NOW,
			}),
			'approval_not_found',
		)

		const later = await requestedSale(10, 'sale_late')
		await expectLoyaltyError(
			decideCustomerApproval(ORG, {
				customerId: later.customerId,
				approvalId: later.approval.id,
				decision: 'approve',
				features: FEATURES,
				now: NOW + LOYALTY_APPROVAL_TTL_MS,
			}),
			'approval_expired',
		)
	})

	it('cancelling an approved request gives the points back', async () => {
		const { customerId, memberId, approval } = await requestedSale(10)
		await decideCustomerApproval(ORG, {
			customerId,
			approvalId: approval.id,
			decision: 'approve',
			features: FEATURES,
			now: NOW + 100,
		})
		const cancelled = await cancelTillApproval(ORG, {
			approvalId: approval.id,
			device,
			now: NOW + 200,
		})
		expect(cancelled.status).toBe('cancelled')
		const after = (await approvalRow(approval.id))!
		expect((await redemptionRow(after.redemptionId))!).toMatchObject({
			state: 'released',
			releaseReason: 'till_cancelled',
		})
		expect(await balanceOf(ORG, memberId)).toMatchObject({
			points: 10,
			reserved: 0,
		})
	})

	it('forgetting the member withdraws the till’s requests waiting for them', async () => {
		const { customerId, memberId, binding, approval } = await requestedSale(10)
		// Another member's request on the same terminal is not theirs to withdraw.
		const other = await requestedSale(10, 'sale_2')
		await revokeTillBinding(ORG, { binding, device, now: NOW + 100 })
		expect((await approvalRow(approval.id))!.status).toBe('cancelled')
		expect((await approvalRow(other.approval.id))!.status).toBe('pending')
		await expectLoyaltyError(
			decideCustomerApproval(ORG, {
				customerId,
				approvalId: approval.id,
				decision: 'approve',
				features: FEATURES,
				now: NOW + 200,
			}),
			'approval_closed',
		)
		expect(await balanceOf(ORG, memberId)).toMatchObject({ reserved: 0 })
	})

	it('removing the terminal withdraws all of its pending requests', async () => {
		const first = await requestedSale(10)
		const second = await requestedSale(10, 'sale_2')
		// Already approved: it stays with its sale.
		await decideCustomerApproval(ORG, {
			customerId: second.customerId,
			approvalId: second.approval.id,
			decision: 'approve',
			features: FEATURES,
			now: NOW + 100,
		})
		const db = await getTenantDb(ORG)
		expect(await revokeDevice(db, device.id, ACTOR, NOW + 200)).toBe(true)
		expect((await approvalRow(first.approval.id))!.status).toBe('cancelled')
		expect((await approvalRow(second.approval.id))!.status).toBe('approved')
		await expectLoyaltyError(
			decideCustomerApproval(ORG, {
				customerId: first.customerId,
				approvalId: first.approval.id,
				decision: 'approve',
				features: FEATURES,
				now: NOW + 300,
			}),
			'approval_closed',
		)
	})

	it('the till reads and expires requests', async () => {
		const { approval } = await requestedSale(10)
		const read = await readTillApproval(ORG, {
			approvalId: approval.id,
			device,
			now: NOW,
		})
		expect(read.status).toBe('pending')
		// Another terminal cannot see it.
		await expectLoyaltyError(
			readTillApproval(ORG, {
				approvalId: approval.id,
				device: { id: 'dev_other', locationId: LOC_1 },
				now: NOW,
			}),
			'approval_not_found',
		)
		// Past its time, reading it expires it.
		const expired = await readTillApproval(ORG, {
			approvalId: approval.id,
			device,
			now: NOW + LOYALTY_APPROVAL_TTL_MS,
		})
		expect(expired.status).toBe('expired')
	})

	it('listCustomerApprovals shows only live pending requests, newest first', async () => {
		const { binding, customerId } = await identify(30)
		const reward = await makeReward(ORG)
		for (const [index, at] of [NOW, NOW + 100].entries()) {
			await requestTillApproval(ORG, {
				binding,
				device,
				rewardId: reward.id,
				rewardVersion: 1,
				saleId: `sale_${index}`,
				cart: loyaltyCart(),
				targetLineId: null,
				features: FEATURES,
				now: at,
			})
		}
		const db = await getTenantDb(ORG)
		const list = await listCustomerApprovals(db, { customerId, now: NOW })
		expect(list).toHaveLength(2)
		expect(list[0]!.createdAt).toBeGreaterThan(list[1]!.createdAt)
		// The second request was made 100ms later, so it outlives the first.
		const stale = await listCustomerApprovals(db, {
			customerId,
			now: NOW + LOYALTY_APPROVAL_TTL_MS + 200,
		})
		expect(stale).toHaveLength(0)
	})
})

describe('one-time codes at the till', () => {
	async function requestWithOtp(memberPoints = 10) {
		const sale = await requestedSale(memberPoints)
		const sent = await sendTillApprovalOtp(ORG, {
			approvalId: sale.approval.id,
			device,
			features: FEATURES,
			now: NOW,
		})
		expect(sent.otpSentAt).toBe(NOW)
		expect(sms).toHaveBeenCalledTimes(1)
		const message = sms.mock.calls[0]![0] as { to: string; message: string }
		const otp = message.message.match(/: (\d{6}) is your code/)![1]!
		return { ...sale, otp }
	}

	it('send -> wrong codes count -> the right code approves and binds', async () => {
		const { approval, otp } = await requestWithOtp()
		const wrong = otp === '000000' ? '000001' : '000000'
		await expectLoyaltyError(
			verifyTillApprovalOtp(ORG, {
				approvalId: approval.id,
				device,
				features: FEATURES,
				otp: wrong,
				now: NOW + 1000,
			}),
			'otp_invalid',
			{ attemptsLeft: LOYALTY_OTP_MAX_ATTEMPTS - 1 },
		)
		const approved = await verifyTillApprovalOtp(ORG, {
			approvalId: approval.id,
			device,
			features: FEATURES,
			otp,
			now: NOW + 2000,
		})
		expect(approved.status).toBe('approved')
		const row = (await approvalRow(approval.id))!
		expect(row.method).toBe('otp')
		expect((await redemptionRow(row.redemptionId))!).toMatchObject({
			state: 'bound',
			sourceType: 'pos_order',
		})
		// Verifying again returns the same approval.
		const replay = await verifyTillApprovalOtp(ORG, {
			approvalId: approval.id,
			device,
			features: FEATURES,
			otp,
			now: NOW + 3000,
		})
		expect(replay.status).toBe('approved')
	})

	it('five wrong codes lock the request', async () => {
		const { approval, otp } = await requestWithOtp()
		const wrong = otp === '111111' ? '111112' : '111111'
		for (let attempt = 1; attempt < LOYALTY_OTP_MAX_ATTEMPTS; attempt++) {
			await expectLoyaltyError(
				verifyTillApprovalOtp(ORG, {
					approvalId: approval.id,
					device,
					features: FEATURES,
					otp: wrong,
					now: NOW + attempt,
				}),
				'otp_invalid',
				{ attemptsLeft: LOYALTY_OTP_MAX_ATTEMPTS - attempt },
			)
		}
		await expectLoyaltyError(
			verifyTillApprovalOtp(ORG, {
				approvalId: approval.id,
				device,
				features: FEATURES,
				otp: wrong,
				now: NOW + LOYALTY_OTP_MAX_ATTEMPTS,
			}),
			'otp_locked',
		)
		// Even the right code is refused once locked.
		await expectLoyaltyError(
			verifyTillApprovalOtp(ORG, {
				approvalId: approval.id,
				device,
				features: FEATURES,
				otp,
				now: NOW + LOYALTY_OTP_MAX_ATTEMPTS + 1,
			}),
			'otp_locked',
		)
	})

	it('sending again replaces the code and resets the attempts', async () => {
		const { approval, otp } = await requestWithOtp()
		const wrong = otp === '222222' ? '222223' : '222222'
		await expectLoyaltyError(
			verifyTillApprovalOtp(ORG, {
				approvalId: approval.id,
				device,
				features: FEATURES,
				otp: wrong,
				now: NOW + 100,
			}),
			'otp_invalid',
			{ attemptsLeft: LOYALTY_OTP_MAX_ATTEMPTS - 1 },
		)
		await sendTillApprovalOtp(ORG, {
			approvalId: approval.id,
			device,
			features: FEATURES,
			now: NOW + 200,
		})
		expect(sms).toHaveBeenCalledTimes(2)
		const row = (await approvalRow(approval.id))!
		expect(row.otpAttempts).toBe(0)
		// The first code no longer works.
		await expectLoyaltyError(
			verifyTillApprovalOtp(ORG, {
				approvalId: approval.id,
				device,
				features: FEATURES,
				otp,
				now: NOW + 300,
			}),
			'otp_invalid',
			{ attemptsLeft: LOYALTY_OTP_MAX_ATTEMPTS - 1 },
		)
	})

	it('no verified phone, no SMS route, no code', async () => {
		// A member without a verified phone.
		const { customerId } = await member(10)
		const db = await getTenantDb(ORG)
		const { customers } = await import('@repo/tenant-db')
		await db
			.update(customers)
			.set({ phoneVerified: false })
			.where(eq(customers.id, customerId))
		const { code } = await issueMemberCode(ORG, {
			customerId,
			features: FEATURES,
			now: NOW,
		})
		const till = await identifyMemberByCode(ORG, {
			code,
			device,
			features: FEATURES,
			now: NOW,
		})
		const reward = await makeReward(ORG)
		const approval = await requestTillApproval(ORG, {
			binding: till.member.binding,
			device,
			rewardId: reward.id,
			rewardVersion: 1,
			saleId: 'sale_nophone',
			cart: loyaltyCart(),
			targetLineId: null,
			features: FEATURES,
			now: NOW,
		})
		expect(approval.otpAvailable).toBe(false)
		await expectLoyaltyError(
			sendTillApprovalOtp(ORG, {
				approvalId: approval.id,
				device,
				features: FEATURES,
				now: NOW,
			}),
			'otp_unavailable',
		)

		// The SMS route being down turns into the same refusal.
		const withPhone = await requestedSale(10, 'sale_brokensms')
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
		sms.mockRejectedValueOnce(
			Object.assign(new Error('twilio down for +15550001111'), {
				code: 'ETIMEDOUT',
			}),
		)
		await expectLoyaltyError(
			sendTillApprovalOtp(ORG, {
				approvalId: withPhone.approval.id,
				device,
				features: FEATURES,
				now: NOW + 1000,
			}),
			'otp_unavailable',
		)
		// The failure is logged with ids and codes, never the number or text.
		expect(logged).toHaveBeenCalledWith(
			expect.stringContaining('approval code'),
			expect.objectContaining({
				approvalId: withPhone.approval.id,
				errorCode: 'ETIMEDOUT',
			}),
		)
		expect(JSON.stringify(logged.mock.calls)).not.toMatch(/\+1555|twilio down/)
		logged.mockRestore()
	})

	it('OTP is US-only: the KSA node refuses to send', async () => {
		vi.stubEnv('DATA_REGION', 'ksa')
		const { approval } = await requestedSale(10)
		await expectLoyaltyError(
			sendTillApprovalOtp(ORG, {
				approvalId: approval.id,
				device,
				features: FEATURES,
				now: NOW,
			}),
			'otp_unavailable',
		)
		expect(sms).not.toHaveBeenCalled()
	})

	it('sends no code and approves nothing while redemption is off', async () => {
		const { approval, customerId, memberId } = await requestedSale(10)
		const off = { enabled: true, redemption: false }
		await expectLoyaltyError(
			sendTillApprovalOtp(ORG, {
				approvalId: approval.id,
				device,
				features: off,
				now: NOW,
			}),
			'redemption_disabled',
		)
		expect(sms).not.toHaveBeenCalled()
		expect((await approvalRow(approval.id))!.otpHash).toBeNull()

		// A code sent while redemption was on stops working once it is off.
		await sendTillApprovalOtp(ORG, {
			approvalId: approval.id,
			device,
			features: FEATURES,
			now: NOW,
		})
		const message = sms.mock.calls[0]![0] as { message: string }
		const otp = message.message.match(/: (\d{6}) is your code/)![1]!
		await expectLoyaltyError(
			verifyTillApprovalOtp(ORG, {
				approvalId: approval.id,
				device,
				otp,
				features: off,
				now: NOW + 1000,
			}),
			'redemption_disabled',
		)
		await expectLoyaltyError(
			decideCustomerApproval(ORG, {
				customerId,
				approvalId: approval.id,
				decision: 'approve',
				features: off,
				now: NOW + 1000,
			}),
			'redemption_disabled',
		)
		expect(await approvalRow(approval.id)).toMatchObject({
			status: 'pending',
			redemptionId: null,
			otpAttempts: 0,
		})
		expect(await balanceOf(ORG, memberId)).toMatchObject({
			points: 10,
			reserved: 0,
		})

		// Back on, the same code still approves.
		const approved = await verifyTillApprovalOtp(ORG, {
			approvalId: approval.id,
			device,
			otp,
			features: FEATURES,
			now: NOW + 2000,
		})
		expect(approved.status).toBe('approved')
	})

	it('keeps a pending request working when the operator edits the program terms', async () => {
		const { approval, binding, customerId, memberId, reward } =
			await requestedSale(20)
		const db = await getTenantDb(ORG)
		const before = (await readProgramInTx(db))!
		await saveProgram(ORG, {
			expectedVersion: before.program.version,
			config: programConfig({ terms: 'New terms for the till.' }),
			actorId: ACTOR,
			now: NOW + 500,
		})

		// Nothing asks for the new text to be accepted: the code goes out, the
		// till can quote and ask again, and the member approves.
		await sendTillApprovalOtp(ORG, {
			approvalId: approval.id,
			device,
			features: FEATURES,
			now: NOW + 1000,
		})
		expect(sms).toHaveBeenCalledTimes(1)
		const quoted = await quoteForTill(ORG, {
			binding,
			device,
			rewardId: reward.id,
			cart: loyaltyCart(),
			targetLineId: null,
			features: FEATURES,
			now: NOW + 1000,
		})
		expect(quoted.quote.applicable).toBe(true)
		const approved = await decideCustomerApproval(ORG, {
			customerId,
			approvalId: approval.id,
			decision: 'approve',
			features: FEATURES,
			now: NOW + 3000,
		})
		expect(approved.status).toBe('approved')
		expect((await balanceOf(ORG, memberId)).reserved).toBe(10)
	})

	it('malformed codes never reach the hash check', async () => {
		const { approval } = await requestWithOtp()
		await expectLoyaltyError(
			verifyTillApprovalOtp(ORG, {
				approvalId: approval.id,
				device,
				features: FEATURES,
				otp: '12',
				now: NOW,
			}),
			'otp_invalid',
		)
	})
})

describe('housekeeping', () => {
	it('expireLoyaltyApprovalsInTx expires only what is due', async () => {
		const { approval } = await requestedSale(10)
		const count = await withLoyaltyWrite(
			{ orgId: ORG, now: NOW + LOYALTY_APPROVAL_TTL_MS },
			(tx) => expireLoyaltyApprovalsInTx(tx, NOW + LOYALTY_APPROVAL_TTL_MS),
		)
		expect(count).toBe(1)
		expect((await approvalRow(approval.id))!.status).toBe('expired')
	})

	it('purge removes spent access but keeps consent records', async () => {
		const { customerId, approval } = await requestedSale(10)
		// Decide it, so the approval row is an approved consent record.
		await decideCustomerApproval(ORG, {
			customerId,
			approvalId: approval.id,
			decision: 'approve',
			features: FEATURES,
			now: NOW,
		})
		const olderThan = NOW + 40 * 24 * 60 * 60_000
		await withLoyaltyWrite({ orgId: ORG, now: olderThan }, (tx) =>
			purgeLoyaltyAccessInTx(tx, olderThan),
		)
		// The approved approval survives; the spent member code does not.
		expect(await approvalRow(approval.id)).toBeDefined()
		const db = await getTenantDb(ORG)
		const codes = await db.select().from(loyaltyMemberCodes)
		expect(codes).toHaveLength(0)
	})
})
