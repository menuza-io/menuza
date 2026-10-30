import {
	computeRewardDiscount,
	formatMemberCode,
	generateBindingToken,
	generateMemberCode,
	generateOtp,
	hashLoyaltyCart,
	isBindingToken,
	LOYALTY_APPROVAL_TTL_MS,
	LOYALTY_BINDING_TTL_MS,
	LOYALTY_MEMBER_CODE_TTL_MS,
	LOYALTY_OTP_MAX_ATTEMPTS,
	LOYALTY_OTP_TTL_MS,
	loyaltyCartSchema,
	LoyaltyDomainError,
	loyaltyHashMessages,
	normalizeMemberCode,
	normalizeOtp,
	type LoyaltyApprovalMethod,
	type LoyaltyCart,
	type LoyaltyCustomerApproval,
	type LoyaltyErrorCode,
	type LoyaltyFeatures,
	type LoyaltyPosApproval,
	type LoyaltyPosMember,
	type LoyaltyPublicReward,
	type LoyaltyRewardQuote,
} from '@repo/loyalty'
import { sendSms } from '@repo/sms'
import {
	customers,
	getTenantDb,
	loyaltyApprovals,
	loyaltyMemberBindings,
	loyaltyMemberCodes,
	posOrders,
	type TenantDatabase,
} from '@repo/tenant-db'
import { and, desc, eq, gt, inArray, isNull, lte, or } from 'drizzle-orm'
import { errorLogFields } from '../lib/error-log.ts'
import { enforceLoyaltyLimit } from '../lib/loyalty-rate-limit.ts'
import {
	type LoyaltyIdempotency,
	type LoyaltyReader,
	type LoyaltyTx,
	withLoyaltyWrite,
} from '../lib/loyalty-write.ts'
import { getNodeRegion } from '../lib/region.ts'
import { hmacHash, timingSafeEqualString } from '../lib/secrets.ts'
import { readBalanceViewInTx } from './loyalty-ledger.ts'
import {
	memberForCustomerInTx,
	readMemberInTx,
	ensureMemberForCustomerInTx,
	type MemberRow,
} from './loyalty-member-service.ts'
import {
	activeRewardsInTx,
	readProgramInTx,
	readRewardInTx,
	toPublicReward,
	type CurrentProgram,
} from './loyalty-program-service.ts'
import {
	activeRedemptionForSourceInTx,
	quoteReward,
	readRedemptionInTx,
	releaseRedemptionInTx,
	reserveRedemptionInTx,
} from './loyalty-redemption-service.ts'

/**
 * Identifying members at the till and letting them approve a spend.
 *
 * - A member code (signed-in wallet, five minutes, single use) identifies the
 *   member to one terminal and turns into a binding the terminal keeps for
 *   twelve hours, so a sale it finishes offline can still be credited. A code
 *   never authorizes spending, and a typed phone number is never a binding.
 * - Spending at the till needs an approval: the terminal asks, the member
 *   approves in their signed-in wallet, or reads back a one-time code sent to
 *   their verified phone (US node only). Approving reserves the points and
 *   binds them to the till's sale id before the till records the discount.
 *
 * Only keyed hashes of codes, bindings and one-time codes are stored.
 */

export type ApprovalRow = typeof loyaltyApprovals.$inferSelect
export type BindingRow = typeof loyaltyMemberBindings.$inferSelect

export type TillDevice = { id: string; locationId: string | null }

export const LOYALTY_TILL_SOURCE = 'pos_order' as const

function hashMemberCode(orgId: string, code: string): string {
	return hmacHash(loyaltyHashMessages.memberCode(orgId, code))
}

function hashBinding(orgId: string, token: string): string {
	return hmacHash(loyaltyHashMessages.binding(orgId, token))
}

function hashOtp(approvalId: string, otp: string): string {
	return hmacHash(loyaltyHashMessages.otp(approvalId, otp))
}

function firstNameOf(name: string | null | undefined): string | null {
	const first = (name ?? '').trim().split(/\s+/)[0] ?? ''
	return first ? first.slice(0, 40) : null
}

/** The program, which must be active for anything new to happen. */
async function activeProgramInTx(db: LoyaltyReader): Promise<CurrentProgram> {
	const program = await readProgramInTx(db)
	if (!program || program.program.status === 'draft') {
		throw new LoyaltyDomainError('program_not_found')
	}
	if (program.program.status !== 'active') {
		throw new LoyaltyDomainError('program_inactive')
	}
	return program
}

async function programRewardsInTx(
	db: LoyaltyReader,
	program: CurrentProgram,
): Promise<LoyaltyPublicReward[]> {
	return (await activeRewardsInTx(db))
		.filter((reward) => reward.currency === program.program.currency)
		.map(toPublicReward)
}

function requireEnabled(features: LoyaltyFeatures): void {
	if (!features.enabled) throw new LoyaltyDomainError('loyalty_disabled')
}

function requireRedemption(features: LoyaltyFeatures): void {
	requireEnabled(features)
	if (!features.redemption) throw new LoyaltyDomainError('redemption_disabled')
}

// ---------------------------------------------------------------------------
// Member codes and till bindings
// ---------------------------------------------------------------------------

/**
 * A new member code for the signed-in customer. Asking again replaces the
 * previous unused code: a member has one live code at a time.
 */
export async function issueMemberCode(
	orgId: string,
	input: { customerId: string; features: LoyaltyFeatures; now?: number },
): Promise<{ code: string; expiresAt: number }> {
	requireEnabled(input.features)
	return withLoyaltyWrite({ orgId, now: input.now }, async (tx, ctx) => {
		await activeProgramInTx(tx)
		// A verified customer who has no points account yet gets one here, so a
		// customer who signed in before the program went live can still ask for a
		// code. Anyone else (unverified phone, erased) has no account to use.
		const member = await ensureMemberForCustomerInTx(
			tx,
			input.customerId,
			ctx.now,
		)
		if (!member || member.status === 'erased') {
			throw new LoyaltyDomainError('member_not_found')
		}
		ctx.linkMember(member.id)
		if (member.status !== 'active') {
			throw new LoyaltyDomainError('member_inactive')
		}
		await tx
			.delete(loyaltyMemberCodes)
			.where(
				and(
					eq(loyaltyMemberCodes.memberId, member.id),
					isNull(loyaltyMemberCodes.usedAt),
				),
			)
		const code = generateMemberCode()
		const expiresAt = ctx.now + LOYALTY_MEMBER_CODE_TTL_MS
		await tx.insert(loyaltyMemberCodes).values({
			memberId: member.id,
			codeHash: hashMemberCode(orgId, code),
			expiresAt,
			createdAt: ctx.now,
		})
		return { code: formatMemberCode(code), expiresAt }
	})
}

export type TillIdentification = {
	member: LoyaltyPosMember
	rewards: LoyaltyPublicReward[]
	redemptionEnabled: boolean
}

/**
 * The till reads a member code. A valid code is used up and becomes a binding
 * for this terminal. Unknown, used, expired and inactive-member codes all
 * answer the same `code_invalid`, so the answer never says which codes exist.
 */
export async function identifyMemberByCode(
	orgId: string,
	input: {
		code: string
		device: TillDevice
		features: LoyaltyFeatures
		now?: number
	},
): Promise<TillIdentification> {
	requireEnabled(input.features)
	const normalized = normalizeMemberCode(input.code)
	if (!normalized) throw new LoyaltyDomainError('code_invalid')
	const codeHash = hashMemberCode(orgId, normalized)
	return withLoyaltyWrite({ orgId, now: input.now }, async (tx, ctx) => {
		const row = await tx
			.select()
			.from(loyaltyMemberCodes)
			.where(eq(loyaltyMemberCodes.codeHash, codeHash))
			.get()
		if (!row || row.usedAt !== null || row.expiresAt <= ctx.now) {
			throw new LoyaltyDomainError('code_invalid')
		}
		const program = await activeProgramInTx(tx)
		const member = await readMemberInTx(tx, row.memberId)
		if (!member || member.status !== 'active' || !member.customerId) {
			throw new LoyaltyDomainError('code_invalid')
		}
		const used = await tx
			.update(loyaltyMemberCodes)
			.set({ usedAt: ctx.now, usedByDeviceId: input.device.id })
			.where(
				and(
					eq(loyaltyMemberCodes.id, row.id),
					isNull(loyaltyMemberCodes.usedAt),
				),
			)
			.returning({ id: loyaltyMemberCodes.id })
		if (used.length !== 1) throw new LoyaltyDomainError('code_invalid')
		const binding = generateBindingToken()
		const bindingExpiresAt = ctx.now + LOYALTY_BINDING_TTL_MS
		await tx.insert(loyaltyMemberBindings).values({
			memberId: member.id,
			deviceId: input.device.id,
			tokenHash: hashBinding(orgId, binding),
			expiresAt: bindingExpiresAt,
			createdAt: ctx.now,
		})
		const customer = await tx
			.select({ name: customers.name })
			.from(customers)
			.where(eq(customers.id, member.customerId))
			.get()
		return {
			member: {
				binding,
				bindingExpiresAt,
				firstName: firstNameOf(customer?.name),
				unitLabel: program.current.config.unitLabel,
				balance: await readBalanceViewInTx(tx, member.id),
			},
			rewards: await programRewardsInTx(tx, program),
			redemptionEnabled: input.features.redemption,
		}
	})
}

/**
 * The member behind a terminal's binding. `at` is when the binding is used:
 * now for a live request, the sale time for an offline sale being uploaded. A
 * binding revoked after that sale still credits it. `clockSkewMs` allows for
 * a till clock a few minutes off the region's, which stamps the sale time.
 */
export async function resolveBindingInTx(
	db: LoyaltyReader,
	orgId: string,
	input: {
		binding: unknown
		deviceId: string
		at: number
		clockSkewMs?: number
	},
): Promise<{ member: MemberRow; binding: BindingRow }> {
	if (!isBindingToken(input.binding)) {
		throw new LoyaltyDomainError('binding_invalid')
	}
	const row = await db
		.select()
		.from(loyaltyMemberBindings)
		.where(
			eq(loyaltyMemberBindings.tokenHash, hashBinding(orgId, input.binding)),
		)
		.get()
	const skew = Math.max(0, input.clockSkewMs ?? 0)
	if (
		!row ||
		row.deviceId !== input.deviceId ||
		row.createdAt - skew > input.at ||
		row.expiresAt + skew <= input.at ||
		(row.revokedAt !== null && row.revokedAt + skew <= input.at)
	) {
		throw new LoyaltyDomainError('binding_invalid')
	}
	const member = await readMemberInTx(db, row.memberId)
	if (!member || member.status !== 'active') {
		throw new LoyaltyDomainError('member_inactive')
	}
	return { member, binding: row }
}

/** The member's balance and the rewards, for a till that already identified them. */
export async function readTillMember(
	orgId: string,
	input: {
		binding: string
		device: TillDevice
		features: LoyaltyFeatures
		db?: TenantDatabase
		now?: number
	},
): Promise<TillIdentification> {
	requireEnabled(input.features)
	const now = input.now ?? Date.now()
	const db = input.db ?? (await getTenantDb(orgId))
	const { member, binding } = await resolveBindingInTx(db, orgId, {
		binding: input.binding,
		deviceId: input.device.id,
		at: now,
	})
	const program = await activeProgramInTx(db)
	const customer = member.customerId
		? await db
				.select({ name: customers.name })
				.from(customers)
				.where(eq(customers.id, member.customerId))
				.get()
		: undefined
	return {
		member: {
			binding: input.binding,
			bindingExpiresAt: binding.expiresAt,
			firstName: firstNameOf(customer?.name),
			unitLabel: program.current.config.unitLabel,
			balance: await readBalanceViewInTx(db, member.id),
		},
		rewards: await programRewardsInTx(db, program),
		redemptionEnabled: input.features.redemption,
	}
}

/**
 * The till forgets a member (end of sale or a wrong person). Its requests
 * still waiting for that member go with the binding, so the member cannot
 * approve a spend for a till that no longer has them.
 */
export async function revokeTillBinding(
	orgId: string,
	input: { binding: string; device: TillDevice; now?: number },
): Promise<void> {
	if (!isBindingToken(input.binding)) return
	const tokenHash = hashBinding(orgId, input.binding)
	await withLoyaltyWrite({ orgId, now: input.now }, async (tx, ctx) => {
		const revoked = await tx
			.update(loyaltyMemberBindings)
			.set({ revokedAt: ctx.now })
			.where(
				and(
					eq(loyaltyMemberBindings.tokenHash, tokenHash),
					eq(loyaltyMemberBindings.deviceId, input.device.id),
					isNull(loyaltyMemberBindings.revokedAt),
				),
			)
			.returning({ memberId: loyaltyMemberBindings.memberId })
		for (const { memberId } of revoked) {
			await cancelPendingTillApprovalsInTx(tx, {
				deviceId: input.device.id,
				memberId,
				at: ctx.now,
			})
		}
	})
}

/**
 * Withdraws a terminal's requests still waiting for a member: one member's
 * when the till forgets them, all of them when the terminal is removed.
 * Approved requests stay with their sale.
 */
export async function cancelPendingTillApprovalsInTx(
	tx: LoyaltyTx,
	input: { deviceId: string; memberId?: string; at: number },
): Promise<number> {
	const rows = await tx
		.update(loyaltyApprovals)
		.set({ status: 'cancelled', decidedAt: input.at, updatedAt: input.at })
		.where(
			and(
				eq(loyaltyApprovals.deviceId, input.deviceId),
				eq(loyaltyApprovals.status, 'pending'),
				input.memberId === undefined
					? undefined
					: eq(loyaltyApprovals.memberId, input.memberId),
			),
		)
		.returning({ id: loyaltyApprovals.id })
	return rows.length
}

// ---------------------------------------------------------------------------
// Quotes at the till
// ---------------------------------------------------------------------------

async function currentRewardForSpendInTx(
	db: LoyaltyReader,
	program: CurrentProgram,
	rewardId: string,
	expectedVersion?: number,
) {
	const reward = await readRewardInTx(db, rewardId)
	if (!reward) throw new LoyaltyDomainError('reward_not_found')
	if (
		reward.status !== 'active' ||
		reward.snapshot.currency !== program.program.currency
	) {
		throw new LoyaltyDomainError('reward_unavailable')
	}
	if (
		expectedVersion !== undefined &&
		reward.snapshot.version !== expectedVersion
	) {
		throw new LoyaltyDomainError('stale_version', {
			currentVersion: reward.snapshot.version,
		})
	}
	return reward.snapshot
}

/** A non-binding quote of one reward against the till's cart. */
export async function quoteForTill(
	orgId: string,
	input: {
		binding: string
		device: TillDevice
		rewardId: string
		cart: LoyaltyCart
		targetLineId: string | null
		features: LoyaltyFeatures
		db?: TenantDatabase
		now?: number
	},
): Promise<{ quote: LoyaltyRewardQuote; availableAfter: number }> {
	requireRedemption(input.features)
	const now = input.now ?? Date.now()
	const db = input.db ?? (await getTenantDb(orgId))
	const { member } = await resolveBindingInTx(db, orgId, {
		binding: input.binding,
		deviceId: input.device.id,
		at: now,
	})
	const program = await activeProgramInTx(db)
	const reward = await currentRewardForSpendInTx(db, program, input.rewardId)
	const balance = await readBalanceViewInTx(db, member.id)
	const quote = quoteReward(
		reward,
		input.cart,
		balance.available,
		input.targetLineId,
	)
	return {
		quote,
		availableAfter:
			balance.available -
			(quote.applicable && quote.affordable ? quote.pointsCost : 0),
	}
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

async function memberHasVerifiedPhoneInTx(
	db: LoyaltyReader,
	member: MemberRow,
): Promise<{ phone: string } | null> {
	if (!member.customerId) return null
	const customer = await db
		.select({ phone: customers.phone, phoneVerified: customers.phoneVerified })
		.from(customers)
		.where(eq(customers.id, member.customerId))
		.get()
	return customer?.phoneVerified && customer.phone
		? { phone: customer.phone }
		: null
}

function otpSupportedOnNode(): boolean {
	try {
		return getNodeRegion() === 'us'
	} catch {
		return false
	}
}

export function toTillApproval(
	row: ApprovalRow,
	otpAvailable: boolean,
): LoyaltyPosApproval {
	return {
		id: row.id,
		status: row.status,
		saleId: row.saleId,
		rewardId: row.rewardId,
		rewardVersion: row.rewardVersion,
		rewardName: row.rewardName,
		pointsCost: row.pointsCost,
		discountMinor: row.discountMinor,
		lines: row.allocation,
		cartHash: row.cartHash,
		redemptionId: row.redemptionId,
		expiresAt: row.expiresAt,
		otpAvailable: otpAvailable && row.status === 'pending',
		otpSentAt: row.otpSentAt,
	}
}

export function toCustomerApproval(row: ApprovalRow): LoyaltyCustomerApproval {
	return {
		id: row.id,
		status: row.status,
		rewardName: row.rewardName,
		pointsCost: row.pointsCost,
		discountMinor: row.discountMinor,
		currency: row.currency,
		createdAt: row.createdAt,
		expiresAt: row.expiresAt,
	}
}

async function readApprovalInTx(
	db: LoyaltyReader,
	approvalId: string,
): Promise<ApprovalRow | null> {
	return (
		(await db
			.select()
			.from(loyaltyApprovals)
			.where(eq(loyaltyApprovals.id, approvalId))
			.get()) ?? null
	)
}

/** Every request a till made for one sale, whatever its status. */
export async function approvalsForSaleInTx(
	db: LoyaltyReader,
	saleId: string,
): Promise<ApprovalRow[]> {
	return db
		.select()
		.from(loyaltyApprovals)
		.where(eq(loyaltyApprovals.saleId, saleId))
		.all()
}

async function setApprovalStatusInTx(
	tx: LoyaltyTx,
	approval: ApprovalRow,
	status: 'expired' | 'cancelled' | 'declined',
	at: number,
): Promise<ApprovalRow> {
	const [row] = await tx
		.update(loyaltyApprovals)
		.set({ status, decidedAt: at, updatedAt: at })
		.where(eq(loyaltyApprovals.id, approval.id))
		.returning()
	return row!
}

/** A pending approval past its time is expired before anyone looks at it. */
async function freshApprovalInTx(
	tx: LoyaltyTx,
	approval: ApprovalRow,
	at: number,
): Promise<ApprovalRow> {
	if (approval.status === 'pending' && approval.expiresAt <= at) {
		return setApprovalStatusInTx(tx, approval, 'expired', at)
	}
	return approval
}

async function tillApprovalInTx(
	tx: LoyaltyTx,
	approvalId: string,
	device: TillDevice,
	at: number,
): Promise<ApprovalRow> {
	const row = await readApprovalInTx(tx, approvalId)
	if (!row || row.deviceId !== device.id) {
		throw new LoyaltyDomainError('approval_not_found')
	}
	return freshApprovalInTx(tx, row, at)
}

/**
 * The till asks the member to approve spending a reward on one sale. Nothing
 * is held yet: the quote is checked (reward version, discount, balance, one
 * reward per sale) and the request waits for the member. Asking again for the
 * same sale from the same terminal replaces the pending request.
 */
export async function requestTillApproval(
	orgId: string,
	input: {
		binding: string
		device: TillDevice
		rewardId: string
		rewardVersion: number
		saleId: string
		cart: LoyaltyCart
		targetLineId: string | null
		features: LoyaltyFeatures
		now?: number
		idempotency?: LoyaltyIdempotency
	},
): Promise<LoyaltyPosApproval> {
	requireRedemption(input.features)
	const cartHash = await hashLoyaltyCart(input.cart)
	return withLoyaltyWrite(
		{ orgId, now: input.now, idempotency: input.idempotency },
		async (tx, ctx) => {
			const { member } = await resolveBindingInTx(tx, orgId, {
				binding: input.binding,
				deviceId: input.device.id,
				at: ctx.now,
			})
			ctx.linkMember(member.id)
			const program = await activeProgramInTx(tx)
			const reward = await currentRewardForSpendInTx(
				tx,
				program,
				input.rewardId,
				input.rewardVersion,
			)
			const result = computeRewardDiscount(reward, input.cart, {
				targetLineId: input.targetLineId,
			})
			if (!result.ok) throw new LoyaltyDomainError(result.code)
			const pointsCost = reward.definition.pointsCost
			const balance = await readBalanceViewInTx(tx, member.id)
			if (balance.available < pointsCost) {
				throw new LoyaltyDomainError('insufficient_points', {
					available: balance.available,
					pointsCost,
				})
			}
			if (
				await activeRedemptionForSourceInTx(
					tx,
					LOYALTY_TILL_SOURCE,
					input.saleId,
				)
			) {
				throw new LoyaltyDomainError('one_reward_per_order')
			}
			const earlier = await approvalsForSaleInTx(tx, input.saleId)
			// A sale id belongs to the terminal that made it.
			if (earlier.some((row) => row.deviceId !== input.device.id)) {
				throw new LoyaltyDomainError('approval_closed')
			}
			// So does a sale the region already holds: another terminal cannot
			// attach a member's approval to it.
			const stored = await tx
				.select({ deviceId: posOrders.deviceId })
				.from(posOrders)
				.where(eq(posOrders.id, input.saleId))
				.get()
			if (stored && stored.deviceId !== input.device.id) {
				throw new LoyaltyDomainError('approval_closed')
			}
			for (const row of earlier) {
				if (row.status === 'pending') {
					await setApprovalStatusInTx(tx, row, 'cancelled', ctx.now)
				}
			}
			const [row] = await tx
				.insert(loyaltyApprovals)
				.values({
					memberId: member.id,
					deviceId: input.device.id,
					locationId: input.device.locationId,
					saleId: input.saleId,
					rewardId: reward.rewardId,
					rewardVersion: reward.version,
					rewardName: reward.definition.name,
					pointsCost,
					currency: reward.currency,
					discountMinor: result.discountMinor,
					allocation: result.lines,
					cart: input.cart as unknown as Record<string, unknown>,
					cartHash,
					targetLineId: result.targetLineId,
					status: 'pending',
					expiresAt: ctx.now + LOYALTY_APPROVAL_TTL_MS,
					createdAt: ctx.now,
					updatedAt: ctx.now,
				})
				.returning()
			const phone = await memberHasVerifiedPhoneInTx(tx, member)
			return toTillApproval(row!, Boolean(phone) && otpSupportedOnNode())
		},
	)
}

/** Where a till's approval stands; the till polls this while the member decides. */
export async function readTillApproval(
	orgId: string,
	input: { approvalId: string; device: TillDevice; now?: number },
): Promise<LoyaltyPosApproval> {
	return withLoyaltyWrite({ orgId, now: input.now }, async (tx, ctx) => {
		const row = await tillApprovalInTx(
			tx,
			input.approvalId,
			input.device,
			ctx.now,
		)
		const member = await readMemberInTx(tx, row.memberId)
		const phone = member ? await memberHasVerifiedPhoneInTx(tx, member) : null
		return toTillApproval(row, Boolean(phone) && otpSupportedOnNode())
	})
}

/**
 * The till withdraws a request. Once approved, withdrawing gives the points
 * back: the till says the discount was not used. A sale that still carries it
 * later goes to review.
 */
export async function cancelTillApproval(
	orgId: string,
	input: { approvalId: string; device: TillDevice; now?: number },
): Promise<LoyaltyPosApproval> {
	return withLoyaltyWrite({ orgId, now: input.now }, async (tx, ctx) => {
		let row = await tillApprovalInTx(
			tx,
			input.approvalId,
			input.device,
			ctx.now,
		)
		if (row.status === 'pending') {
			row = await setApprovalStatusInTx(tx, row, 'cancelled', ctx.now)
		} else if (row.status === 'approved' && row.redemptionId) {
			const redemption = await readRedemptionInTx(tx, row.redemptionId)
			if (redemption && redemption.state !== 'released') {
				if (redemption.state !== 'bound' && redemption.state !== 'reserved') {
					throw new LoyaltyDomainError('invalid_transition')
				}
				await releaseRedemptionInTx(tx, redemption, {
					reason: 'till_cancelled',
					at: ctx.now,
				})
			}
			row = await setApprovalStatusInTx(tx, row, 'cancelled', ctx.now)
		}
		return toTillApproval(row, false)
	})
}

/**
 * Approving reserves the points and binds them to the till's sale in one
 * step, from the cart and reward version the member saw. A reward edited or
 * archived since the request cannot be approved any more, and nothing is
 * approved while redemption is off.
 */
async function approveInTx(
	tx: LoyaltyTx,
	approval: ApprovalRow,
	method: LoyaltyApprovalMethod,
	at: number,
	features: LoyaltyFeatures,
): Promise<ApprovalRow> {
	requireRedemption(features)
	const member = await readMemberInTx(tx, approval.memberId)
	if (!member || member.status !== 'active') {
		throw new LoyaltyDomainError('member_inactive')
	}
	const program = await activeProgramInTx(tx)
	const reward = await currentRewardForSpendInTx(
		tx,
		program,
		approval.rewardId,
		approval.rewardVersion,
	).catch((error: unknown) => {
		if (error instanceof LoyaltyDomainError && error.code === 'stale_version') {
			throw new LoyaltyDomainError('reward_unavailable')
		}
		throw error
	})
	const cart = loyaltyCartSchema.parse(approval.cart)
	const redemption = await reserveRedemptionInTx(tx, {
		member,
		reward,
		cart,
		cartHash: approval.cartHash,
		targetLineId: approval.targetLineId,
		expectedDiscountMinor: approval.discountMinor,
		channel: 'pos',
		source: { type: LOYALTY_TILL_SOURCE, id: approval.saleId },
		locationId: approval.locationId,
		deviceId: approval.deviceId,
		approvalId: approval.id,
		at,
	})
	const [row] = await tx
		.update(loyaltyApprovals)
		.set({
			status: 'approved',
			method,
			redemptionId: redemption.id,
			decidedAt: at,
			updatedAt: at,
		})
		.where(
			and(
				eq(loyaltyApprovals.id, approval.id),
				eq(loyaltyApprovals.status, 'pending'),
			),
		)
		.returning()
	if (!row) throw new LoyaltyDomainError('approval_closed')
	return row
}

/** The member's open till requests, newest first. */
export async function listCustomerApprovals(
	db: LoyaltyReader,
	input: { customerId: string; now?: number },
): Promise<LoyaltyCustomerApproval[]> {
	const now = input.now ?? Date.now()
	const member = await memberForCustomerInTx(db, input.customerId)
	if (!member || member.status !== 'active') return []
	const rows = await db
		.select()
		.from(loyaltyApprovals)
		.where(
			and(
				eq(loyaltyApprovals.memberId, member.id),
				eq(loyaltyApprovals.status, 'pending'),
				gt(loyaltyApprovals.expiresAt, now),
			),
		)
		.orderBy(desc(loyaltyApprovals.createdAt))
		.limit(10)
		.all()
	return rows.map(toCustomerApproval)
}

/** The signed-in member approves or declines a till's request. */
export async function decideCustomerApproval(
	orgId: string,
	input: {
		customerId: string
		approvalId: string
		decision: 'approve' | 'decline'
		features: LoyaltyFeatures
		now?: number
		idempotency?: LoyaltyIdempotency
	},
): Promise<LoyaltyCustomerApproval> {
	if (input.decision === 'approve') requireRedemption(input.features)
	return withLoyaltyWrite(
		{ orgId, now: input.now, idempotency: input.idempotency },
		async (tx, ctx) => {
			const member = await memberForCustomerInTx(tx, input.customerId)
			const approval = await readApprovalInTx(tx, input.approvalId)
			if (!member || !approval || approval.memberId !== member.id) {
				throw new LoyaltyDomainError('approval_not_found')
			}
			ctx.linkMember(member.id)
			if (approval.status === 'approved' && input.decision === 'approve') {
				return toCustomerApproval(approval)
			}
			if (approval.status === 'declined' && input.decision === 'decline') {
				return toCustomerApproval(approval)
			}
			if (approval.status !== 'pending') {
				throw new LoyaltyDomainError('approval_closed')
			}
			if (approval.expiresAt <= ctx.now) {
				throw new LoyaltyDomainError('approval_expired')
			}
			const next =
				input.decision === 'approve'
					? await approveInTx(tx, approval, 'wallet', ctx.now, input.features)
					: await setApprovalStatusInTx(tx, approval, 'declined', ctx.now)
			return toCustomerApproval(next)
		},
	)
}

// ---------------------------------------------------------------------------
// One-time codes (US node)
// ---------------------------------------------------------------------------

function otpMessage(input: {
	programName: string
	otp: string
	pointsCost: number
	unitLabel: string
}): string {
	return `${input.programName}: ${input.otp} is your code to spend ${input.pointsCost} ${input.unitLabel} at the till. Share it only with the cashier. It expires in 5 minutes.`
}

/**
 * Sends a one-time code for a pending request to the member's verified phone.
 * Only the code's keyed hash is stored; sending again replaces it and resets
 * the attempts. Nothing is sent while redemption is off: the code could not
 * be used.
 */
export async function sendTillApprovalOtp(
	orgId: string,
	input: {
		approvalId: string
		device: TillDevice
		features: LoyaltyFeatures
		now?: number
	},
): Promise<LoyaltyPosApproval> {
	requireRedemption(input.features)
	if (!otpSupportedOnNode()) throw new LoyaltyDomainError('otp_unavailable')
	const otp = generateOtp()
	const prepared = await withLoyaltyWrite(
		{ orgId, now: input.now },
		async (tx, ctx) => {
			const row = await tillApprovalInTx(
				tx,
				input.approvalId,
				input.device,
				ctx.now,
			)
			if (row.status === 'expired')
				return { closed: 'approval_expired' as const }
			if (row.status !== 'pending')
				return { closed: 'approval_closed' as const }
			const member = await readMemberInTx(tx, row.memberId)
			const phone = member ? await memberHasVerifiedPhoneInTx(tx, member) : null
			if (!member || !phone) throw new LoyaltyDomainError('otp_unavailable')
			const program = await activeProgramInTx(tx)
			// Per-member send limit across approvals (the route limits per
			// approval); counted before the send so a refusal is not free.
			await enforceLoyaltyLimit(tx, 'otpSendMember', member.id, ctx.now)
			const [updated] = await tx
				.update(loyaltyApprovals)
				.set({
					otpHash: hashOtp(row.id, otp),
					otpSentAt: ctx.now,
					otpAttempts: 0,
					expiresAt: Math.max(row.expiresAt, ctx.now + LOYALTY_OTP_TTL_MS),
					updatedAt: ctx.now,
				})
				.where(eq(loyaltyApprovals.id, row.id))
				.returning()
			return {
				approval: updated!,
				phone: phone.phone,
				message: otpMessage({
					programName: program.current.config.name,
					otp,
					pointsCost: row.pointsCost,
					unitLabel: program.current.config.unitLabel,
				}),
			}
		},
	)
	if (prepared.closed !== undefined)
		throw new LoyaltyDomainError(prepared.closed)
	try {
		await sendSms({ to: prepared.phone, message: prepared.message })
	} catch (error) {
		// Ids and error codes only: never the phone number or the message,
		// which holds the code itself.
		console.error('Loyalty could not send a till approval code', {
			approvalId: prepared.approval.id,
			...errorLogFields(error),
		})
		throw new LoyaltyDomainError('otp_unavailable')
	}
	return toTillApproval(prepared.approval, true)
}

/**
 * The cashier types the code the member reads out. Wrong codes count; after
 * five the request is locked and the till has to ask again.
 */
export async function verifyTillApprovalOtp(
	orgId: string,
	input: {
		approvalId: string
		device: TillDevice
		otp: string
		features: LoyaltyFeatures
		now?: number
	},
): Promise<LoyaltyPosApproval> {
	requireRedemption(input.features)
	const otp = normalizeOtp(input.otp)
	if (!otp) throw new LoyaltyDomainError('otp_invalid')
	const outcome = await withLoyaltyWrite(
		{ orgId, now: input.now },
		async (
			tx,
			ctx,
		): Promise<
			| { ok: true; approval: ApprovalRow }
			| { ok: false; code: LoyaltyErrorCode; details?: Record<string, unknown> }
		> => {
			const row = await tillApprovalInTx(
				tx,
				input.approvalId,
				input.device,
				ctx.now,
			)
			if (row.status === 'approved' && row.method === 'otp') {
				return { ok: true, approval: row }
			}
			if (row.status === 'expired')
				return { ok: false, code: 'approval_expired' }
			if (row.status !== 'pending')
				return { ok: false, code: 'approval_closed' }
			if (!row.otpHash || row.otpSentAt === null) {
				return { ok: false, code: 'otp_invalid' }
			}
			if (row.otpAttempts >= LOYALTY_OTP_MAX_ATTEMPTS) {
				return { ok: false, code: 'otp_locked' }
			}
			if (!timingSafeEqualString(hashOtp(row.id, otp), row.otpHash)) {
				const attempts = row.otpAttempts + 1
				await tx
					.update(loyaltyApprovals)
					.set({ otpAttempts: attempts, updatedAt: ctx.now })
					.where(eq(loyaltyApprovals.id, row.id))
				return attempts >= LOYALTY_OTP_MAX_ATTEMPTS
					? { ok: false, code: 'otp_locked' }
					: {
							ok: false,
							code: 'otp_invalid',
							details: { attemptsLeft: LOYALTY_OTP_MAX_ATTEMPTS - attempts },
						}
			}
			return {
				ok: true,
				approval: await approveInTx(tx, row, 'otp', ctx.now, input.features),
			}
		},
	)
	if (!outcome.ok) throw new LoyaltyDomainError(outcome.code, outcome.details)
	return toTillApproval(outcome.approval, false)
}

// ---------------------------------------------------------------------------
// Housekeeping (the tick)
// ---------------------------------------------------------------------------

/** Pending requests past their time become expired. */
export async function expireLoyaltyApprovalsInTx(
	tx: LoyaltyTx,
	now: number,
): Promise<number> {
	const rows = await tx
		.update(loyaltyApprovals)
		.set({ status: 'expired', decidedAt: now, updatedAt: now })
		.where(
			and(
				eq(loyaltyApprovals.status, 'pending'),
				lte(loyaltyApprovals.expiresAt, now),
			),
		)
		.returning({ id: loyaltyApprovals.id })
	return rows.length
}

/**
 * Deletes codes, bindings and closed requests nobody can use any more, once
 * they are older than `olderThan`. Approved requests are kept: they record
 * the member's consent to the spend.
 */
export async function purgeLoyaltyAccessInTx(
	tx: LoyaltyTx,
	olderThan: number,
): Promise<void> {
	await tx
		.delete(loyaltyMemberCodes)
		.where(lte(loyaltyMemberCodes.expiresAt, olderThan))
	await tx
		.delete(loyaltyMemberBindings)
		.where(
			or(
				lte(loyaltyMemberBindings.expiresAt, olderThan),
				lte(loyaltyMemberBindings.revokedAt, olderThan),
			),
		)
	await tx
		.delete(loyaltyApprovals)
		.where(
			and(
				inArray(loyaltyApprovals.status, ['declined', 'expired', 'cancelled']),
				lte(loyaltyApprovals.updatedAt, olderThan),
			),
		)
}
