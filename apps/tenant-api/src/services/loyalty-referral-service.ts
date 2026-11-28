import { randomUUID } from 'node:crypto'
import { normalizePhone } from '@repo/common/phone'
import {
	generateMarketingCode,
	normalizeDiscountCode,
	type DiscountCodeRecord,
	type DiscountRecord,
} from '@repo/discounts'
import {
	generateReferralCode,
	LOYALTY_REFERRAL_DISCOUNT_ID,
	LoyaltyDomainError,
	loyaltyEventKeys,
	loyaltyOperatorReferralsResponseSchema,
	loyaltyReferralClaimResponseSchema,
	loyaltyReferralPublicSchema,
	normalizeReferralCode,
	type LoyaltyDiscount,
	type LoyaltyFeatures,
	type LoyaltyOperatorReferralsResponse,
	type LoyaltyProgramConfig,
	type LoyaltyReferralClaimResponse,
	type LoyaltyReferralPublic,
	type LoyaltyReport,
	type LoyaltyWallet,
} from '@repo/loyalty'
import {
	customers,
	discountIssuedCodes,
	discountRedemptions,
	getTenantDb,
	loyaltyMembers,
	loyaltyReferralCodes,
	loyaltyReferrals,
	restaurantOrders,
	type TenantDatabase,
	type TenantTransaction,
} from '@repo/tenant-db'
import { businessDateOf, startOfLocalDay } from '@repo/zoned-time'
import {
	and,
	desc,
	eq,
	gte,
	inArray,
	isNull,
	lte,
	ne,
	or,
	sql,
} from 'drizzle-orm'
import { chunkIds } from '../lib/chunked-in.ts'
import { getLoyaltyFeatures } from '../lib/loyalty-context.ts'
import {
	type LoyaltyReader,
	type LoyaltyTx,
	withLoyaltyWrite,
} from '../lib/loyalty-write.ts'
import { hmacHash } from '../lib/secrets.ts'
import { recordLoyaltyAudit } from './loyalty-audit.ts'
import { postLedgerEntryInTx } from './loyalty-ledger.ts'
import { readProgramInTx } from './loyalty-program-service.ts'

type ReferralDb = TenantDatabase | TenantTransaction

const DAY_MS = 24 * 60 * 60_000
const CLAIM_CODE_TTL_MS = 30 * DAY_MS
const CODE_GEN_ATTEMPTS = 6
const HOLD_TICK_BATCH_LIMIT = 200
const ACTIVE_CAP_STATUSES = [
	'claimed',
	'pending_order',
	'holding',
	'credited',
] as const

function randomBytes(count: number): Uint8Array {
	const buf = new Uint8Array(count)
	crypto.getRandomValues(buf)
	return buf
}

function isUniqueViolation(error: unknown): boolean {
	const msg = String(
		(error as { message?: unknown } | null)?.message ?? error ?? '',
	)
	return /UNIQUE constraint failed/i.test(msg)
}

export function referralPhoneHash(orgId: string, rawPhone: string): string {
	const normalized = normalizePhone(rawPhone) || rawPhone.trim()
	return hmacHash(`loyalty:referral:phone:v1:${orgId}:${normalized}`)
}

export function referralDeviceHash(orgId: string, deviceId: string): string {
	return hmacHash(`loyalty:referral:device:v1:${orgId}:${deviceId.trim()}`)
}

function monthStartMs(now: number, timeZone: string): number {
	const local = businessDateOf(now, timeZone)
	return startOfLocalDay(`${local.slice(0, 7)}-01`, timeZone)
}

async function countReferrerUsageInTx(
	db: LoyaltyReader,
	input: { referrerMemberId: string; timeZone: string; now: number },
): Promise<{ lifetime: number; month: number }> {
	const monthStart = monthStartMs(input.now, input.timeZone)
	const [lifetimeRow, monthRow] = await Promise.all([
		db
			.select({ count: sql<number>`count(*)` })
			.from(loyaltyReferrals)
			.where(
				and(
					eq(loyaltyReferrals.referrerMemberId, input.referrerMemberId),
					inArray(loyaltyReferrals.status, [...ACTIVE_CAP_STATUSES]),
				),
			)
			.get(),
		db
			.select({ count: sql<number>`count(*)` })
			.from(loyaltyReferrals)
			.where(
				and(
					eq(loyaltyReferrals.referrerMemberId, input.referrerMemberId),
					inArray(loyaltyReferrals.status, [...ACTIVE_CAP_STATUSES]),
					gte(loyaltyReferrals.createdAt, monthStart),
				),
			)
			.get(),
	])
	return {
		lifetime: Number(lifetimeRow?.count ?? 0),
		month: Number(monthRow?.count ?? 0),
	}
}

function referrerIsAtCap(
	usage: { lifetime: number; month: number },
	config: LoyaltyProgramConfig['referrals'],
): boolean {
	if (usage.lifetime >= config.maxReferralsPerMember) return true
	if (
		config.maxReferralsPerMonth !== null &&
		usage.month >= config.maxReferralsPerMonth
	) {
		return true
	}
	return false
}

export async function getOrCreateReferralCodeInTx(
	tx: LoyaltyTx,
	input: { memberId: string; now: number },
): Promise<string> {
	const existing = await tx
		.select({ code: loyaltyReferralCodes.code })
		.from(loyaltyReferralCodes)
		.where(eq(loyaltyReferralCodes.memberId, input.memberId))
		.get()
	if (existing) return existing.code

	for (let attempt = 0; attempt < CODE_GEN_ATTEMPTS; attempt++) {
		const code = generateReferralCode()
		try {
			await tx.insert(loyaltyReferralCodes).values({
				memberId: input.memberId,
				code,
				createdAt: input.now,
			})
			return code
		} catch (error) {
			if (!isUniqueViolation(error)) throw error
			const raced = await tx
				.select({ code: loyaltyReferralCodes.code })
				.from(loyaltyReferralCodes)
				.where(eq(loyaltyReferralCodes.memberId, input.memberId))
				.get()
			if (raced) return raced.code
		}
	}
	throw new Error('Could not generate unique referral code')
}

async function resolveReferrerByAnyCodeInTx(
	db: LoyaltyReader,
	rawCode: string,
): Promise<{
	kind: 'referral_code' | 'issued_code'
	referrerMemberId: string
	referrerCustomerId: string | null
	referrerPhone: string | null
	referrerName: string | null
	referralCode: string
	issuedCodeRow: {
		id: string
		code: string
		normalizedCode: string
		customerId: string | null
		expiresAt: number
		sourceId: string
	} | null
} | null> {
	const normalizedRef = normalizeReferralCode(rawCode)
	if (normalizedRef) {
		const row = await db
			.select({
				memberId: loyaltyMembers.id,
				memberStatus: loyaltyMembers.status,
				customerId: loyaltyMembers.customerId,
				phone: customers.phone,
				name: customers.name,
				code: loyaltyReferralCodes.code,
			})
			.from(loyaltyReferralCodes)
			.innerJoin(
				loyaltyMembers,
				eq(loyaltyMembers.id, loyaltyReferralCodes.memberId),
			)
			.leftJoin(customers, eq(customers.id, loyaltyMembers.customerId))
			.where(eq(loyaltyReferralCodes.code, normalizedRef))
			.get()
		if (!row || row.memberStatus !== 'active') return null
		return {
			kind: 'referral_code',
			referrerMemberId: row.memberId,
			referrerCustomerId: row.customerId,
			referrerPhone: row.phone,
			referrerName: row.name,
			referralCode: row.code,
			issuedCodeRow: null,
		}
	}

	const normalizedDiscount = normalizeDiscountCode(rawCode)
	if (normalizedDiscount.length < 3 || normalizedDiscount.length > 32) {
		return null
	}
	const issued = await db
		.select({
			id: discountIssuedCodes.id,
			code: discountIssuedCodes.code,
			normalizedCode: discountIssuedCodes.normalizedCode,
			customerId: discountIssuedCodes.customerId,
			expiresAt: discountIssuedCodes.expiresAt,
			sourceType: discountIssuedCodes.sourceType,
			sourceId: discountIssuedCodes.sourceId,
		})
		.from(discountIssuedCodes)
		.where(
			and(
				eq(discountIssuedCodes.normalizedCode, normalizedDiscount),
				eq(discountIssuedCodes.sourceType, 'loyalty_referral'),
			),
		)
		.get()
	if (!issued) return null
	const claimed = await db
		.select()
		.from(loyaltyReferrals)
		.where(eq(loyaltyReferrals.id, issued.sourceId))
		.get()
	if (!claimed || !claimed.referrerMemberId) return null
	const refRow = await db
		.select({
			memberId: loyaltyMembers.id,
			memberStatus: loyaltyMembers.status,
			customerId: loyaltyMembers.customerId,
			phone: customers.phone,
			name: customers.name,
		})
		.from(loyaltyMembers)
		.leftJoin(customers, eq(customers.id, loyaltyMembers.customerId))
		.where(eq(loyaltyMembers.id, claimed.referrerMemberId))
		.get()
	if (!refRow || refRow.memberStatus !== 'active') return null
	return {
		kind: 'issued_code',
		referrerMemberId: refRow.memberId,
		referrerCustomerId: refRow.customerId,
		referrerPhone: refRow.phone,
		referrerName: refRow.name,
		referralCode: claimed.referralCode,
		issuedCodeRow: {
			id: issued.id,
			code: issued.code,
			normalizedCode: issued.normalizedCode,
			customerId: issued.customerId,
			expiresAt: issued.expiresAt,
			sourceId: issued.sourceId,
		},
	}
}

async function hasPriorCustomerOrderInTx(
	db: LoyaltyReader,
	input: {
		customerId: string | null
		phone: string | null
		now: number
	},
): Promise<boolean> {
	const cutoffSec = Math.floor(input.now / 1000)
	const activeStatuses = [
		'pending_acceptance',
		'accepted',
		'preparing',
		'ready',
		'completed',
		'payment_review',
	] as const
	const normalized = input.phone ? normalizePhone(input.phone) : ''
	const identityClauses = [
		...(input.customerId
			? [eq(restaurantOrders.customerId, input.customerId)]
			: []),
		...(input.phone
			? [
					eq(restaurantOrders.contactPhone, input.phone.trim()),
					...(normalized && normalized !== input.phone.trim()
						? [eq(restaurantOrders.contactPhone, normalized)]
						: []),
				]
			: []),
	]
	if (identityClauses.length === 0) return false
	const prior = await db
		.select({ id: restaurantOrders.id })
		.from(restaurantOrders)
		.where(
			and(
				or(...identityClauses),
				// A free test order (#119) is not a prior order.
				eq(restaurantOrders.isTest, false),
				// bounded: fixed 6-element status tuple
				inArray(restaurantOrders.status, [...activeStatuses]),
				// Ignore lapsed unpaid online holds (consistent with discount-apply.ts).
				sql`NOT (${restaurantOrders.paymentMethod} = 'online' AND ${restaurantOrders.status} = 'accepted' AND ${restaurantOrders.paymentStatus} = 'pending' AND ${restaurantOrders.holdExpiresAt} IS NOT NULL AND ${restaurantOrders.holdExpiresAt} < ${cutoffSec})`,
			),
		)
		.limit(1)
		.get()
	if (prior) return true

	if (normalized) {
		const fallbackRows = await db
			.select({ contactPhone: restaurantOrders.contactPhone })
			.from(restaurantOrders)
			.where(
				and(
					// bounded: fixed 6-element status tuple
					inArray(restaurantOrders.status, [...activeStatuses]),
					sql`NOT (${restaurantOrders.paymentMethod} = 'online' AND ${restaurantOrders.status} = 'accepted' AND ${restaurantOrders.paymentStatus} = 'pending' AND ${restaurantOrders.holdExpiresAt} IS NOT NULL AND ${restaurantOrders.holdExpiresAt} < ${cutoffSec})`,
				),
			)
			.limit(100)
			.all()
		for (const row of fallbackRows) {
			if (row.contactPhone && normalizePhone(row.contactPhone) === normalized) {
				return true
			}
		}
	}
	return false
}

async function deviceAlreadyBlockedInTx(
	db: LoyaltyReader,
	input: {
		orgId: string
		deviceHash: string | null
		referrerCustomerId: string | null
		friendPhoneHash: string
		allowReferralId?: string | null
	},
): Promise<'none' | 'self' | 'claimed'> {
	if (!input.deviceHash) return 'none'
	const matching = await db
		.select({
			id: loyaltyReferrals.id,
			friendCustomerId: loyaltyReferrals.friendCustomerId,
			friendPhoneHash: loyaltyReferrals.friendPhoneHash,
			referrerMemberId: loyaltyReferrals.referrerMemberId,
			status: loyaltyReferrals.status,
		})
		.from(loyaltyReferrals)
		.where(
			and(
				eq(loyaltyReferrals.deviceHash, input.deviceHash),
				ne(loyaltyReferrals.status, 'cancelled'),
			),
		)
		.all()
	for (const row of matching) {
		if (input.allowReferralId && row.id === input.allowReferralId) continue
		if (
			input.referrerCustomerId &&
			row.friendCustomerId === input.referrerCustomerId
		) {
			return 'self'
		}
		if (row.friendPhoneHash !== input.friendPhoneHash) {
			return 'claimed'
		}
	}
	return 'none'
}

export async function lookupPublicReferral(
	db: LoyaltyReader,
	input: {
		orgId?: string
		code: string
		features: LoyaltyFeatures
		now?: number
	},
): Promise<LoyaltyReferralPublic | null> {
	if (!input.features.enabled || !input.features.referrals) return null
	const program = await readProgramInTx(db)
	if (
		!program ||
		program.current.status !== 'active' ||
		!program.current.config.referrals.enabled
	) {
		return null
	}
	const now = input.now ?? Date.now()
	const normalized = normalizeReferralCode(input.code)
	if (!normalized) {
		return loyaltyReferralPublicSchema.parse({
			valid: false,
			code: input.code.trim().toUpperCase(),
			referrerFirstName: null,
			friendDiscount: null,
			friendPoints: 0,
			minimumOrderMinor: 0,
		})
	}
	const resolved = await resolveReferrerByAnyCodeInTx(db, normalized)
	if (!resolved) {
		return loyaltyReferralPublicSchema.parse({
			valid: false,
			code: normalized,
			referrerFirstName: null,
			friendDiscount: null,
			friendPoints: 0,
			minimumOrderMinor: 0,
		})
	}
	const referralsCfg = program.current.config.referrals
	const usage = await countReferrerUsageInTx(db, {
		referrerMemberId: resolved.referrerMemberId,
		timeZone: program.current.config.timeZone,
		now,
	})
	const atCap = referrerIsAtCap(usage, referralsCfg)
	const firstName = resolved.referrerName?.trim().split(/\s+/)[0] || null
	return loyaltyReferralPublicSchema.parse({
		valid: !atCap,
		code: resolved.referralCode,
		referrerFirstName: firstName,
		friendDiscount: atCap ? null : referralsCfg.friendDiscount,
		friendPoints: atCap ? 0 : referralsCfg.friendPoints,
		minimumOrderMinor: referralsCfg.minimumOrderMinor,
	})
}

async function mintReferralIssuedCodeInTx(
	tx: LoyaltyTx,
	input: {
		referralId: string
		customerId: string | null
		expiresAt: number
		now: number
	},
): Promise<{ id: string; code: string }> {
	for (let attempt = 0; attempt < CODE_GEN_ATTEMPTS; attempt++) {
		const { code, normalizedCode } = generateMarketingCode('RF', randomBytes)
		try {
			const [row] = await tx
				.insert(discountIssuedCodes)
				.values({
					discountId: LOYALTY_REFERRAL_DISCOUNT_ID,
					code,
					normalizedCode,
					sourceType: 'loyalty_referral',
					sourceId: input.referralId,
					customerId: input.customerId,
					expiresAt: input.expiresAt,
					createdAt: input.now,
				})
				.returning({
					id: discountIssuedCodes.id,
					code: discountIssuedCodes.code,
				})
			return row!
		} catch (error) {
			if (!isUniqueViolation(error)) throw error
		}
	}
	throw new Error('Could not mint unique referral discount code')
}

export async function claimReferral(
	orgId: string,
	input: {
		customerId: string
		code: string
		deviceId?: string | null
		features: LoyaltyFeatures
		now?: number
	},
): Promise<LoyaltyReferralClaimResponse> {
	if (!input.features.enabled) {
		throw new LoyaltyDomainError('loyalty_disabled')
	}
	if (!input.features.referrals) {
		throw new LoyaltyDomainError('referrals_disabled')
	}
	return withLoyaltyWrite({ orgId, now: input.now }, async (tx, ctx) => {
		const program = await readProgramInTx(tx)
		if (!program || program.current.status !== 'active') {
			throw new LoyaltyDomainError('program_inactive')
		}
		const refConfig = program.current.config.referrals
		if (!refConfig.enabled) {
			throw new LoyaltyDomainError('referrals_disabled')
		}
		const customer = await tx
			.select()
			.from(customers)
			.where(eq(customers.id, input.customerId))
			.get()
		if (!customer) {
			throw new LoyaltyDomainError('customer_not_found')
		}
		if (!customer.phone || !customer.phoneVerified) {
			throw new LoyaltyDomainError('phone_required')
		}

		const resolved = await resolveReferrerByAnyCodeInTx(tx, input.code)
		if (!resolved) {
			throw new LoyaltyDomainError('referral_invalid')
		}
		if (resolved.referrerCustomerId === customer.id) {
			throw new LoyaltyDomainError('referral_self')
		}
		const phoneHash = referralPhoneHash(orgId, customer.phone)
		if (
			resolved.referrerPhone &&
			referralPhoneHash(orgId, resolved.referrerPhone) === phoneHash
		) {
			throw new LoyaltyDomainError('referral_self')
		}
		const deviceHash = input.deviceId?.trim()
			? referralDeviceHash(orgId, input.deviceId)
			: null

		const existingForPhone = await tx
			.select()
			.from(loyaltyReferrals)
			.where(
				and(
					eq(loyaltyReferrals.friendPhoneHash, phoneHash),
					ne(loyaltyReferrals.status, 'cancelled'),
				),
			)
			.get()
		if (existingForPhone) {
			// Idempotent return if this exact guest already claimed the same code and has not placed an order yet.
			if (
				existingForPhone.status === 'claimed' &&
				existingForPhone.referralCode === resolved.referralCode &&
				(existingForPhone.friendCustomerId === null ||
					existingForPhone.friendCustomerId === customer.id)
			) {
				const existingIssued = existingForPhone.issuedDiscountCodeId
					? await tx
							.select({ code: discountIssuedCodes.code })
							.from(discountIssuedCodes)
							.where(
								eq(
									discountIssuedCodes.id,
									existingForPhone.issuedDiscountCodeId,
								),
							)
							.get()
					: null
				return loyaltyReferralClaimResponseSchema.parse({
					referral: {
						id: existingForPhone.id,
						code: existingForPhone.referralCode,
						status: existingForPhone.status,
						discountCode: existingIssued?.code ?? null,
						friendDiscount: refConfig.friendDiscount,
						friendPoints: existingForPhone.friendPoints,
						minimumOrderMinor: refConfig.minimumOrderMinor,
					},
				})
			}
			throw new LoyaltyDomainError('referral_already_claimed')
		}

		const devCheck = await deviceAlreadyBlockedInTx(tx, {
			orgId,
			deviceHash,
			referrerCustomerId: resolved.referrerCustomerId,
			friendPhoneHash: phoneHash,
		})
		if (devCheck === 'self') {
			throw new LoyaltyDomainError('referral_self')
		}
		if (devCheck === 'claimed') {
			throw new LoyaltyDomainError('referral_already_claimed')
		}

		if (
			await hasPriorCustomerOrderInTx(tx, {
				customerId: customer.id,
				phone: customer.phone,
				now: ctx.now,
			})
		) {
			throw new LoyaltyDomainError('referral_existing_customer')
		}

		const usage = await countReferrerUsageInTx(tx, {
			referrerMemberId: resolved.referrerMemberId,
			timeZone: program.current.config.timeZone,
			now: ctx.now,
		})
		if (referrerIsAtCap(usage, refConfig)) {
			throw new LoyaltyDomainError('referral_cap_reached')
		}

		const friendMember = await tx
			.select({ id: loyaltyMembers.id })
			.from(loyaltyMembers)
			.where(
				and(
					eq(loyaltyMembers.customerId, customer.id),
					ne(loyaltyMembers.status, 'erased'),
				),
			)
			.get()

		const referralId = randomUUID()
		let issuedCodeId: string | null = null
		let discountCode: string | null = null
		if (refConfig.friendDiscount !== null) {
			const minted = await mintReferralIssuedCodeInTx(tx, {
				referralId,
				customerId: customer.id,
				expiresAt: ctx.now + CLAIM_CODE_TTL_MS,
				now: ctx.now,
			})
			issuedCodeId = minted.id
			discountCode = minted.code
		}

		const [inserted] = await tx
			.insert(loyaltyReferrals)
			.values({
				id: referralId,
				referrerMemberId: resolved.referrerMemberId,
				referralCode: resolved.referralCode,
				friendCustomerId: customer.id,
				friendMemberId: friendMember?.id ?? null,
				friendPhoneHash: phoneHash,
				deviceHash,
				issuedDiscountCodeId: issuedCodeId,
				status: 'claimed',
				referrerPoints: refConfig.referrerPoints,
				friendPoints: refConfig.friendPoints,
				friendDiscountMinor: 0,
				createdAt: ctx.now,
				updatedAt: ctx.now,
			})
			.returning()

		await recordLoyaltyAudit(tx, {
			actorKind: 'customer',
			actorId: customer.id,
			action: 'referral.claimed',
			entityType: 'referral',
			entityId: referralId,
			changes: {
				referrerMemberId: resolved.referrerMemberId,
				code: resolved.referralCode,
			},
			at: ctx.now,
		})

		return loyaltyReferralClaimResponseSchema.parse({
			referral: {
				id: inserted!.id,
				code: inserted!.referralCode,
				status: inserted!.status,
				discountCode,
				friendDiscount: refConfig.friendDiscount,
				friendPoints: inserted!.friendPoints,
				minimumOrderMinor: refConfig.minimumOrderMinor,
			},
		})
	})
}

function syntheticReferralDiscountRecord(input: {
	name: string
	currency: string
	friendDiscount: LoyaltyDiscount
	minimumOrderMinor: number
	now: number
}): DiscountRecord {
	return {
		id: LOYALTY_REFERRAL_DISCOUNT_ID,
		version: 1,
		createdAt: new Date(input.now).toISOString(),
		name: input.name,
		internalName: null,
		description: null,
		status: 'active',
		application: 'code',
		valueType: input.friendDiscount.type,
		percentBp:
			input.friendDiscount.type === 'percent'
				? input.friendDiscount.percentBp
				: null,
		amountMinor:
			input.friendDiscount.type === 'fixed'
				? input.friendDiscount.amountMinor
				: null,
		currency: input.currency,
		maxDiscountMinor:
			input.friendDiscount.type === 'percent'
				? (input.friendDiscount.maxDiscountMinor ?? null)
				: null,
		target: {
			scope: 'order',
			itemIds: [],
			categoryIds: [],
			excludeItemIds: [],
			excludeCategoryIds: [],
		},
		requirement: null,
		quantityRule: { kind: 'none' },
		maxDiscountedUnits: null,
		minSubtotalMinor:
			input.minimumOrderMinor > 0 ? input.minimumOrderMinor : null,
		locationIds: null,
		channels: ['web', 'qr', 'app'],
		fulfillments: ['pickup', 'delivery'],
		includeDrops: true,
		schedule: null,
		startsAt: null,
		endsAt: null,
		eligibility: 'everyone',
		totalLimit: null,
		perCustomerLimit: null,
		combinable: true,
		priority: 100,
		promoteOnMenu: false,
		requireApproval: false,
	}
}

export type ResolvedReferralOrderOffer = {
	referralCode: string
	referrerMemberId: string
	existingClaimId: string | null
	syntheticRecord: DiscountRecord | null
	syntheticCode: DiscountCodeRecord | null
}

/**
 * Evaluates a candidate checkout code against loyalty referrals (both `?ref=`
 * minted issued codes and direct `REF-...` referral codes). Returns a synthetic
 * DiscountRecord + DiscountCodeRecord when valid and offering a friend discount,
 * without requiring the separate `discounts.coupons` flag.
 */
export async function resolveReferralDiscountForOrder(
	db: ReferralDb,
	input: {
		orgId: string
		typedCode: string | null | undefined
		customerId: string | null
		phone: string | null | undefined
		deviceId?: string | null | undefined
		currency: string
		now: number
	},
): Promise<ResolvedReferralOrderOffer | null> {
	const typed = input.typedCode?.trim()
	if (!typed) return null

	const features = await getLoyaltyFeatures(input.orgId).catch(() => null)
	if (!features?.enabled || !features.referrals) return null

	const program = await readProgramInTx(db)
	if (
		!program ||
		program.current.status !== 'active' ||
		!program.current.config.referrals.enabled ||
		program.current.currency !== input.currency
	) {
		return null
	}

	const resolved = await resolveReferrerByAnyCodeInTx(db, typed)
	if (!resolved) return null

	if (
		resolved.issuedCodeRow &&
		(resolved.issuedCodeRow.expiresAt <= input.now ||
			(resolved.issuedCodeRow.customerId &&
				input.customerId &&
				resolved.issuedCodeRow.customerId !== input.customerId))
	) {
		return null
	}

	let effectivePhone = input.phone?.trim() || null
	if (!effectivePhone && input.customerId) {
		const c = await db
			.select({ phone: customers.phone })
			.from(customers)
			.where(eq(customers.id, input.customerId))
			.get()
		effectivePhone = c?.phone ?? null
	}

	if (input.customerId && resolved.referrerCustomerId === input.customerId) {
		return null
	}
	const phoneHash = effectivePhone
		? referralPhoneHash(input.orgId, effectivePhone)
		: null
	if (
		phoneHash &&
		resolved.referrerPhone &&
		referralPhoneHash(input.orgId, resolved.referrerPhone) === phoneHash
	) {
		return null
	}

	let existingClaim: typeof loyaltyReferrals.$inferSelect | undefined
	if (resolved.issuedCodeRow) {
		existingClaim = await db
			.select()
			.from(loyaltyReferrals)
			.where(eq(loyaltyReferrals.id, resolved.issuedCodeRow.sourceId))
			.get()
		if (!existingClaim || existingClaim.status !== 'claimed') return null
	} else if (phoneHash) {
		const row = await db
			.select()
			.from(loyaltyReferrals)
			.where(
				and(
					eq(loyaltyReferrals.friendPhoneHash, phoneHash),
					ne(loyaltyReferrals.status, 'cancelled'),
				),
			)
			.get()
		if (row) {
			if (
				row.status === 'claimed' &&
				row.referralCode === resolved.referralCode
			) {
				existingClaim = row
			} else {
				return null
			}
		}
	}

	if (phoneHash) {
		const deviceHash = input.deviceId?.trim()
			? referralDeviceHash(input.orgId, input.deviceId)
			: null
		const devCheck = await deviceAlreadyBlockedInTx(db, {
			orgId: input.orgId,
			deviceHash,
			referrerCustomerId: resolved.referrerCustomerId,
			friendPhoneHash: phoneHash,
			allowReferralId: existingClaim?.id ?? null,
		})
		if (devCheck !== 'none') return null
	}

	if (
		await hasPriorCustomerOrderInTx(db, {
			customerId: input.customerId,
			phone: effectivePhone,
			now: input.now,
		})
	) {
		return null
	}

	const refCfg = program.current.config.referrals
	// Note: when checking cap, if an existing `'claimed'` row is already counted, subtract nothing unless not counted?
	// Only enforce cap on brand-new referral (when there isn't already a counted 'claimed' row).
	if (!existingClaim) {
		const usage = await countReferrerUsageInTx(db, {
			referrerMemberId: resolved.referrerMemberId,
			timeZone: program.current.config.timeZone,
			now: input.now,
		})
		if (referrerIsAtCap(usage, refCfg)) return null
	}

	if (!refCfg.friendDiscount) {
		return {
			referralCode: resolved.referralCode,
			referrerMemberId: resolved.referrerMemberId,
			existingClaimId: existingClaim?.id ?? null,
			syntheticRecord: null,
			syntheticCode: null,
		}
	}

	const normalizedForDiscount = normalizeDiscountCode(typed)
	const codeId =
		resolved.issuedCodeRow?.id ??
		existingClaim?.issuedDiscountCodeId ??
		`ref:${resolved.referrerMemberId}`
	return {
		referralCode: resolved.referralCode,
		referrerMemberId: resolved.referrerMemberId,
		existingClaimId: existingClaim?.id ?? null,
		syntheticRecord: syntheticReferralDiscountRecord({
			name: `${program.current.config.name} Referral`,
			currency: program.current.currency,
			friendDiscount: refCfg.friendDiscount,
			minimumOrderMinor: refCfg.minimumOrderMinor,
			now: input.now,
		}),
		syntheticCode: {
			id: codeId,
			discountId: LOYALTY_REFERRAL_DISCOUNT_ID,
			normalizedCode: normalizedForDiscount,
			maxUses: resolved.issuedCodeRow ? 1 : null,
		},
	}
}

/**
 * Binds an applied referral code (from checkout promo input) OR an already-claimed
 * `?ref=` referral (including points-only referrals) to a newly placed order.
 * Runs inside the order placement transaction so abuse conflicts abort placement.
 */
export async function bindReferralToOrderInTx(
	tx: LoyaltyTx,
	input: {
		orgId: string
		orderId: string
		customerId: string | null
		memberId: string | null
		phone: string | null | undefined
		deviceId?: string | null | undefined
		typedCode?: string | null | undefined
		appliedDiscountMinor: number
		appliedReferralDiscount: boolean
		now: number
	},
): Promise<void> {
	const typed = input.typedCode?.trim() || null
	const hasTypedReferral = typed
		? (await resolveReferrerByAnyCodeInTx(tx, typed)) !== null
		: false

	const effectivePhone =
		input.phone?.trim() ||
		(input.customerId
			? ((
					await tx
						.select({ phone: customers.phone })
						.from(customers)
						.where(eq(customers.id, input.customerId))
						.get()
				)?.phone ?? null)
			: null)
	if (!effectivePhone) return

	const features = await getLoyaltyFeatures(input.orgId).catch(() => null)
	if (!features?.enabled || !features.referrals) return

	const program = await readProgramInTx(tx)
	if (
		!program ||
		program.current.status !== 'active' ||
		!program.current.config.referrals.enabled
	) {
		return
	}
	const refCfg = program.current.config.referrals
	const phoneHash = referralPhoneHash(input.orgId, effectivePhone)
	const deviceHash = input.deviceId?.trim()
		? referralDeviceHash(input.orgId, input.deviceId)
		: null

	let targetClaim = await tx
		.select()
		.from(loyaltyReferrals)
		.where(
			and(
				eq(loyaltyReferrals.friendPhoneHash, phoneHash),
				eq(loyaltyReferrals.status, 'claimed'),
			),
		)
		.get()

	if (!hasTypedReferral && !input.appliedReferralDiscount) {
		// If the signed-in guest previously claimed a `?ref=` link (including points-only), bind that claim to this first order!
		if (!targetClaim || !input.customerId) return
		if (
			targetClaim.friendCustomerId &&
			targetClaim.friendCustomerId !== input.customerId
		) {
			return
		}
	}

	if (hasTypedReferral) {
		const resolved = await resolveReferrerByAnyCodeInTx(tx, typed!)
		if (!resolved) return
		if (
			(input.customerId && resolved.referrerCustomerId === input.customerId) ||
			(resolved.referrerPhone &&
				referralPhoneHash(input.orgId, resolved.referrerPhone) === phoneHash)
		) {
			throw new LoyaltyDomainError('referral_self')
		}
		if (targetClaim && targetClaim.referralCode === resolved.referralCode) {
			// Consume their matching claim!
		} else {
			// Check whether phoneHash already has any non-cancelled referral
			const anyPrior = await tx
				.select({ id: loyaltyReferrals.id })
				.from(loyaltyReferrals)
				.where(
					and(
						eq(loyaltyReferrals.friendPhoneHash, phoneHash),
						ne(loyaltyReferrals.status, 'cancelled'),
					),
				)
				.get()
			if (anyPrior) {
				throw new LoyaltyDomainError('referral_already_claimed')
			}
			const devCheck = await deviceAlreadyBlockedInTx(tx, {
				orgId: input.orgId,
				deviceHash,
				referrerCustomerId: resolved.referrerCustomerId,
				friendPhoneHash: phoneHash,
			})
			if (devCheck === 'self') throw new LoyaltyDomainError('referral_self')
			if (devCheck === 'claimed') {
				throw new LoyaltyDomainError('referral_already_claimed')
			}
			const usage = await countReferrerUsageInTx(tx, {
				referrerMemberId: resolved.referrerMemberId,
				timeZone: program.current.config.timeZone,
				now: input.now,
			})
			if (referrerIsAtCap(usage, refCfg)) {
				throw new LoyaltyDomainError('referral_cap_reached')
			}

			const referralId = randomUUID()
			await tx.insert(loyaltyReferrals).values({
				id: referralId,
				referrerMemberId: resolved.referrerMemberId,
				referralCode: resolved.referralCode,
				friendCustomerId: input.customerId,
				friendMemberId: input.memberId,
				friendPhoneHash: phoneHash,
				deviceHash,
				issuedDiscountCodeId: resolved.issuedCodeRow?.id ?? null,
				orderId: input.orderId,
				status: 'pending_order',
				referrerPoints: refCfg.referrerPoints,
				friendPoints: refCfg.friendPoints,
				friendDiscountMinor: input.appliedDiscountMinor,
				createdAt: input.now,
				updatedAt: input.now,
			})
			await recordLoyaltyAudit(tx, {
				actorKind: input.customerId ? 'customer' : 'system',
				actorId: input.customerId,
				action: 'referral.bound_order',
				entityType: 'referral',
				entityId: referralId,
				changes: {
					orderId: input.orderId,
					code: resolved.referralCode,
				},
				at: input.now,
			})
			return
		}
	}

	if (!targetClaim) return

	await tx
		.update(loyaltyReferrals)
		.set({
			orderId: input.orderId,
			friendCustomerId: targetClaim.friendCustomerId ?? input.customerId,
			friendMemberId: targetClaim.friendMemberId ?? input.memberId,
			deviceHash: targetClaim.deviceHash ?? deviceHash,
			status: 'pending_order',
			friendDiscountMinor: input.appliedDiscountMinor,
			referrerPoints: refCfg.referrerPoints,
			friendPoints: refCfg.friendPoints,
			updatedAt: input.now,
		})
		.where(eq(loyaltyReferrals.id, targetClaim.id))

	await recordLoyaltyAudit(tx, {
		actorKind: input.customerId ? 'customer' : 'system',
		actorId: input.customerId,
		action: 'referral.bound_order',
		entityType: 'referral',
		entityId: targetClaim.id,
		changes: { orderId: input.orderId, code: targetClaim.referralCode },
		at: input.now,
	})
}

async function creditReferralRowInTx(
	tx: LoyaltyTx,
	row: typeof loyaltyReferrals.$inferSelect,
	input: { programVersion: number | null; now: number },
): Promise<boolean> {
	if (!row.referrerMemberId) {
		await tx
			.update(loyaltyReferrals)
			.set({
				status: 'cancelled',
				cancelledReason: 'referrer_missing',
				holdUntil: null,
				updatedAt: input.now,
			})
			.where(eq(loyaltyReferrals.id, row.id))
		return false
	}

	const referrer = await tx
		.select({ id: loyaltyMembers.id, status: loyaltyMembers.status })
		.from(loyaltyMembers)
		.where(eq(loyaltyMembers.id, row.referrerMemberId))
		.get()
	if (!referrer || referrer.status !== 'active') {
		await tx
			.update(loyaltyReferrals)
			.set({
				status: 'cancelled',
				cancelledReason: 'referrer_inactive',
				holdUntil: null,
				updatedAt: input.now,
			})
			.where(eq(loyaltyReferrals.id, row.id))
		return false
	}

	if (row.referrerPoints > 0) {
		await postLedgerEntryInTx(tx, {
			memberId: referrer.id,
			type: 'referral',
			delta: row.referrerPoints,
			eventKey: loyaltyEventKeys.referral(row.id, 'referrer'),
			programVersion: input.programVersion,
			actorKind: 'system',
			at: input.now,
		})
	}

	let friendMemberId = row.friendMemberId
	if (!friendMemberId && row.friendCustomerId) {
		const m = await tx
			.select({ id: loyaltyMembers.id, status: loyaltyMembers.status })
			.from(loyaltyMembers)
			.where(eq(loyaltyMembers.customerId, row.friendCustomerId))
			.get()
		if (m?.status === 'active') friendMemberId = m.id
	}
	if (row.friendPoints > 0 && friendMemberId) {
		const friendMember = await tx
			.select({ id: loyaltyMembers.id, status: loyaltyMembers.status })
			.from(loyaltyMembers)
			.where(eq(loyaltyMembers.id, friendMemberId))
			.get()
		if (friendMember?.status === 'active') {
			await postLedgerEntryInTx(tx, {
				memberId: friendMember.id,
				type: 'referral',
				delta: row.friendPoints,
				eventKey: loyaltyEventKeys.referral(row.id, 'friend'),
				programVersion: input.programVersion,
				actorKind: 'system',
				at: input.now,
			})
		}
	}

	await tx
		.update(loyaltyReferrals)
		.set({
			friendMemberId,
			status: 'credited',
			holdUntil: null,
			creditedAt: input.now,
			updatedAt: input.now,
		})
		.where(eq(loyaltyReferrals.id, row.id))

	await recordLoyaltyAudit(tx, {
		actorKind: 'system',
		action: 'referral.credited',
		entityType: 'referral',
		entityId: row.id,
		changes: {
			referrerMemberId: referrer.id,
			referrerPoints: row.referrerPoints,
			friendMemberId,
			friendPoints: row.friendPoints,
		},
		at: input.now,
	})
	return true
}

/**
 * Transitions a `pending_order` referral once the referred order finishes paid
 * and completed: either enters `holding` for `holdDays` or credits at once.
 */
export async function onReferralOrderCompletedInTx(
	tx: LoyaltyTx,
	input: {
		orderId: string
		memberId?: string | null
		eligibleMinor: number
		totalPaidMinor: number
		paymentStatus?: string | null
		now: number
	},
): Promise<void> {
	const row = await tx
		.select()
		.from(loyaltyReferrals)
		.where(eq(loyaltyReferrals.orderId, input.orderId))
		.get()
	if (!row || row.status !== 'pending_order') return

	const program = await readProgramInTx(tx)
	const refCfg = program?.current.config.referrals
	const minOrder = refCfg?.minimumOrderMinor ?? 0
	const paidEnough =
		minOrder > 0
			? input.eligibleMinor >= minOrder
			: input.totalPaidMinor > 0 ||
				input.paymentStatus === 'paid' ||
				input.paymentStatus === 'not_required'
	if (!paidEnough) {
		await tx
			.update(loyaltyReferrals)
			.set({
				status: 'cancelled',
				cancelledReason: 'below_minimum',
				updatedAt: input.now,
			})
			.where(eq(loyaltyReferrals.id, row.id))
		return
	}

	const updatedFriendMemberId = input.memberId ?? row.friendMemberId
	const holdDays = refCfg?.holdDays ?? 0
	if (holdDays > 0) {
		await tx
			.update(loyaltyReferrals)
			.set({
				friendMemberId: updatedFriendMemberId,
				status: 'holding',
				holdUntil: input.now + holdDays * DAY_MS,
				updatedAt: input.now,
			})
			.where(eq(loyaltyReferrals.id, row.id))
		return
	}

	await creditReferralRowInTx(
		tx,
		{ ...row, friendMemberId: updatedFriendMemberId },
		{ programVersion: program?.current.version ?? null, now: input.now },
	)
}

/**
 * Cancels pending/holding referrals or reverses already-credited referral points
 * if the qualifying order is cancelled or refunded below minimum spend.
 */
export async function onReferralOrderCancelledOrRefundedInTx(
	tx: LoyaltyTx,
	input: {
		orderId: string
		fullRefund: boolean
		remainingEligibleMinor: number
		now: number
	},
): Promise<void> {
	const row = await tx
		.select()
		.from(loyaltyReferrals)
		.where(eq(loyaltyReferrals.orderId, input.orderId))
		.get()
	if (!row || row.status === 'cancelled' || row.status === 'reversed') return

	const program = await readProgramInTx(tx)
	const minOrder = program?.current.config.referrals.minimumOrderMinor ?? 0
	const invalidatesOrder =
		input.fullRefund ||
		input.remainingEligibleMinor <= 0 ||
		(minOrder > 0 && input.remainingEligibleMinor < minOrder)
	if (!invalidatesOrder) return

	if (
		row.status === 'claimed' ||
		row.status === 'pending_order' ||
		row.status === 'holding'
	) {
		await tx
			.update(loyaltyReferrals)
			.set({
				status: 'cancelled',
				cancelledReason: input.fullRefund ? 'refunded' : 'cancelled',
				holdUntil: null,
				updatedAt: input.now,
			})
			.where(eq(loyaltyReferrals.id, row.id))
		await recordLoyaltyAudit(tx, {
			actorKind: 'system',
			action: 'referral.cancelled',
			entityType: 'referral',
			entityId: row.id,
			changes: { orderId: input.orderId, from: row.status },
			at: input.now,
		})
		return
	}

	// `credited` -> reverse points granted on both sides
	if (row.referrerMemberId && row.referrerPoints > 0) {
		const referrer = await tx
			.select({ id: loyaltyMembers.id, status: loyaltyMembers.status })
			.from(loyaltyMembers)
			.where(eq(loyaltyMembers.id, row.referrerMemberId))
			.get()
		if (referrer && referrer.status !== 'erased') {
			await postLedgerEntryInTx(tx, {
				memberId: referrer.id,
				type: 'referral_reversal',
				delta: -row.referrerPoints,
				eventKey: loyaltyEventKeys.referralReversal(row.id, 'referrer'),
				programVersion: program?.current.version ?? null,
				actorKind: 'system',
				at: input.now,
			})
		}
	}
	if (row.friendMemberId && row.friendPoints > 0) {
		const friend = await tx
			.select({ id: loyaltyMembers.id, status: loyaltyMembers.status })
			.from(loyaltyMembers)
			.where(eq(loyaltyMembers.id, row.friendMemberId))
			.get()
		if (friend && friend.status !== 'erased') {
			await postLedgerEntryInTx(tx, {
				memberId: friend.id,
				type: 'referral_reversal',
				delta: -row.friendPoints,
				eventKey: loyaltyEventKeys.referralReversal(row.id, 'friend'),
				programVersion: program?.current.version ?? null,
				actorKind: 'system',
				at: input.now,
			})
		}
	}

	await tx
		.update(loyaltyReferrals)
		.set({
			status: 'reversed',
			reversedAt: input.now,
			updatedAt: input.now,
		})
		.where(eq(loyaltyReferrals.id, row.id))

	await recordLoyaltyAudit(tx, {
		actorKind: 'system',
		action: 'referral.reversed',
		entityType: 'referral',
		entityId: row.id,
		changes: { orderId: input.orderId },
		at: input.now,
	})
}

/** Scheduled referral tick: credits `holding` referrals whose hold window ended. */
export async function processReferralHoldTickForOrg(
	orgId: string,
	options: { db?: TenantDatabase; now?: number } = {},
): Promise<{ credited: number; cancelled: number }> {
	const now = options.now ?? Date.now()
	const reader = options.db ?? (await getTenantDb(orgId))
	const due = await reader
		.select({ id: loyaltyReferrals.id })
		.from(loyaltyReferrals)
		.where(
			and(
				eq(loyaltyReferrals.status, 'holding'),
				lte(loyaltyReferrals.holdUntil, now),
			),
		)
		.limit(HOLD_TICK_BATCH_LIMIT)
		.all()

	if (due.length === 0) return { credited: 0, cancelled: 0 }

	let credited = 0
	let cancelled = 0
	for (const { id } of due) {
		await withLoyaltyWrite({ orgId, db: options.db, now }, async (tx, ctx) => {
			const row = await tx
				.select()
				.from(loyaltyReferrals)
				.where(eq(loyaltyReferrals.id, id))
				.get()
			if (!row || row.status !== 'holding') return
			if ((row.holdUntil ?? ctx.now + 1) > ctx.now) return

			const order = row.orderId
				? await tx
						.select()
						.from(restaurantOrders)
						.where(eq(restaurantOrders.id, row.orderId))
						.get()
				: null
			const netRefunded = order
				? Math.max(0, order.refundedCents - (order.refundReversedCents ?? 0))
				: 0
			const orderValid =
				order &&
				order.status === 'completed' &&
				(order.totalCents <= 0 || netRefunded < order.totalCents)
			if (!orderValid) {
				await tx
					.update(loyaltyReferrals)
					.set({
						status: 'cancelled',
						cancelledReason: 'order_invalid',
						holdUntil: null,
						updatedAt: ctx.now,
					})
					.where(eq(loyaltyReferrals.id, row.id))
				cancelled += 1
				return
			}
			const program = await readProgramInTx(tx)
			const ok = await creditReferralRowInTx(tx, row, {
				programVersion: program?.current.version ?? null,
				now: ctx.now,
			})
			if (ok) credited += 1
			else cancelled += 1
		})
	}
	return { credited, cancelled }
}

export async function buildWalletReferralInTx(
	orgId: string,
	db: LoyaltyReader,
	input: {
		member: typeof loyaltyMembers.$inferSelect
		config: LoyaltyProgramConfig
		features: LoyaltyFeatures
		now: number
	},
): Promise<LoyaltyWallet['referral']> {
	if (
		input.member.status !== 'active' ||
		!input.features.referrals ||
		!input.config.referrals.enabled
	) {
		return null
	}

	let existingCode = await db
		.select({ code: loyaltyReferralCodes.code })
		.from(loyaltyReferralCodes)
		.where(eq(loyaltyReferralCodes.memberId, input.member.id))
		.get()
	if (!existingCode) {
		existingCode = {
			code: await withLoyaltyWrite({ orgId, now: input.now }, (tx, ctx) =>
				getOrCreateReferralCodeInTx(tx, {
					memberId: input.member.id,
					now: ctx.now,
				}),
			),
		}
	}

	const rows = await db
		.select({
			status: loyaltyReferrals.status,
			referrerPoints: loyaltyReferrals.referrerPoints,
			createdAt: loyaltyReferrals.createdAt,
		})
		.from(loyaltyReferrals)
		.where(eq(loyaltyReferrals.referrerMemberId, input.member.id))
		.all()

	let referredCount = 0
	let pendingCount = 0
	let creditedCount = 0
	let creditedPoints = 0
	let activeCount = 0
	for (const r of rows) {
		if (r.status === 'cancelled') continue
		referredCount += 1
		if (
			r.status === 'claimed' ||
			r.status === 'pending_order' ||
			r.status === 'holding'
		) {
			pendingCount += 1
			activeCount += 1
		} else if (r.status === 'credited') {
			creditedCount += 1
			creditedPoints += r.referrerPoints
			activeCount += 1
		}
	}
	const capReached =
		activeCount >= input.config.referrals.maxReferralsPerMember ||
		(input.config.referrals.maxReferralsPerMonth !== null &&
			rows.filter(
				(r) =>
					(ACTIVE_CAP_STATUSES as readonly string[]).includes(r.status) &&
					r.createdAt >= monthStartMs(input.now, input.config.timeZone),
			).length >= input.config.referrals.maxReferralsPerMonth)

	return {
		code: existingCode.code,
		sharePath: `/?ref=${encodeURIComponent(existingCode.code)}`,
		referredCount,
		pendingCount,
		creditedCount,
		creditedPoints,
		capReached,
		maxReferralsPerMember: input.config.referrals.maxReferralsPerMember,
	}
}

export async function listOperatorReferrals(
	db: LoyaltyReader,
	options: { limit?: number } = {},
): Promise<LoyaltyOperatorReferralsResponse> {
	const limit = Math.min(200, Math.max(1, options.limit ?? 50))
	const rows = await db
		.select({
			referral: loyaltyReferrals,
			discountCode: discountIssuedCodes.code,
		})
		.from(loyaltyReferrals)
		.leftJoin(
			discountIssuedCodes,
			eq(discountIssuedCodes.id, loyaltyReferrals.issuedDiscountCodeId),
		)
		.orderBy(desc(loyaltyReferrals.createdAt))
		.limit(limit)
		.all()

	const memberIds = new Set<string>()
	for (const { referral } of rows) {
		if (referral.referrerMemberId) memberIds.add(referral.referrerMemberId)
		if (referral.friendMemberId) memberIds.add(referral.friendMemberId)
	}
	const memberNames = new Map<string, string | null>()
	if (memberIds.size > 0) {
		for (const part of chunkIds([...memberIds])) {
			const mRows = await db
				.select({
					id: loyaltyMembers.id,
					status: loyaltyMembers.status,
					name: customers.name,
				})
				.from(loyaltyMembers)
				.leftJoin(customers, eq(customers.id, loyaltyMembers.customerId))
				.where(inArray(loyaltyMembers.id, part))
				.all()
			for (const m of mRows) {
				memberNames.set(m.id, m.status === 'erased' ? null : (m.name ?? null))
			}
		}
	}

	const counts = await db
		.select({
			status: loyaltyReferrals.status,
			count: sql<number>`count(*)`,
			referrerPts: sql<number>`coalesce(sum(${loyaltyReferrals.referrerPoints}), 0)`,
			friendPts: sql<number>`coalesce(sum(case when ${loyaltyReferrals.friendMemberId} is not null then ${loyaltyReferrals.friendPoints} else 0 end), 0)`,
			discountMinor: sql<number>`coalesce(sum(${loyaltyReferrals.friendDiscountMinor}), 0)`,
		})
		.from(loyaltyReferrals)
		.groupBy(loyaltyReferrals.status)
		.all()

	const summary = {
		totalClaimed: 0,
		pendingOrder: 0,
		holding: 0,
		credited: 0,
		cancelled: 0,
		reversed: 0,
		pointsAwarded: 0,
		friendDiscountMinor: 0,
	}
	for (const row of counts) {
		const n = Number(row.count)
		switch (row.status) {
			case 'claimed':
				summary.totalClaimed += n
				break
			case 'pending_order':
				summary.pendingOrder += n
				break
			case 'holding':
				summary.holding += n
				break
			case 'credited':
				summary.credited += n
				summary.pointsAwarded += Number(row.referrerPts) + Number(row.friendPts)
				summary.friendDiscountMinor += Number(row.discountMinor)
				break
			case 'cancelled':
				summary.cancelled += n
				break
			case 'reversed':
				summary.reversed += n
				break
		}
	}

	return loyaltyOperatorReferralsResponseSchema.parse({
		summary,
		referrals: rows.map(({ referral, discountCode }) => ({
			id: referral.id,
			code: referral.referralCode,
			referrerMemberId: referral.referrerMemberId,
			referrerName: referral.referrerMemberId
				? (memberNames.get(referral.referrerMemberId) ?? null)
				: null,
			friendMemberId: referral.friendMemberId,
			friendName: referral.friendMemberId
				? (memberNames.get(referral.friendMemberId) ?? null)
				: null,
			status: referral.status,
			orderId: referral.orderId,
			discountCode: discountCode ?? null,
			discountMinor: referral.friendDiscountMinor,
			referrerPoints: referral.referrerPoints,
			friendPoints: referral.friendPoints,
			holdUntil: referral.holdUntil,
			creditedAt: referral.creditedAt,
			createdAt: referral.createdAt,
		})),
	})
}

export async function getReferralReportStatsInTx(
	db: LoyaltyReader,
	input: { fromMs: number; toMs: number },
): Promise<LoyaltyReport['referrals']> {
	const rows = await db
		.select({
			status: loyaltyReferrals.status,
			count: sql<number>`count(*)`,
			referrerPts: sql<number>`coalesce(sum(${loyaltyReferrals.referrerPoints}), 0)`,
			friendPts: sql<number>`coalesce(sum(case when ${loyaltyReferrals.friendMemberId} is not null then ${loyaltyReferrals.friendPoints} else 0 end), 0)`,
			discountMinor: sql<number>`coalesce(sum(${loyaltyReferrals.friendDiscountMinor}), 0)`,
		})
		.from(loyaltyReferrals)
		.where(
			and(
				gte(loyaltyReferrals.createdAt, input.fromMs),
				lte(loyaltyReferrals.createdAt, input.toMs),
			),
		)
		.groupBy(loyaltyReferrals.status)
		.all()

	let claimed = 0
	let credited = 0
	let cancelled = 0
	let reversed = 0
	let pointsGiven = 0
	let friendDiscountMinor = 0
	for (const row of rows) {
		const n = Number(row.count)
		if (
			row.status === 'claimed' ||
			row.status === 'pending_order' ||
			row.status === 'holding'
		) {
			claimed += n
		} else if (row.status === 'credited') {
			credited += n
			pointsGiven += Number(row.referrerPts) + Number(row.friendPts)
			friendDiscountMinor += Number(row.discountMinor)
		} else if (row.status === 'cancelled') {
			cancelled += n
		} else if (row.status === 'reversed') {
			reversed += n
		}
	}
	return {
		claimed,
		credited,
		cancelled,
		reversed,
		pointsGiven,
		friendDiscountMinor,
	}
}
