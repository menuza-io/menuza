import { randomUUID } from 'node:crypto'
import { createHash } from 'node:crypto'
import {
	policyRequiresPayment,
	selectPolicy,
	snapshotPolicy,
	type PolicyInput,
	type PolicySnapshot,
	type ReservationsContext,
} from '@repo/reservations'
import {
	rsvExperiences,
	rsvLocationSettings,
	rsvPayments,
	rsvPolicies,
	rsvServices,
	type TenantDatabase,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { HttpError } from '../lib/http.ts'
import { pickText, type LocaleOrg } from '../lib/reservations-i18n.ts'
import { deriveReservationPayToken } from '../lib/reservations-public-auth.ts'
import { type ReservationWriteTx } from '../lib/reservations-write.ts'

/**
 * Booking-time payment decisions: which policy applies, whether the booking
 * needs payment, the immutable snapshot stored on the reservation, and the
 * first `rsv_payments` row. Pure database work: the provider is never called
 * here (the App creates the hosted session and binds it afterwards).
 */

type Tx = ReservationWriteTx | TenantDatabase

export const DEFAULT_PAYMENT_HOLD_MINUTES = 20

export type PaymentPurpose = 'deposit' | 'prepay' | 'experience' | 'guarantee'

export type BookingPaymentPlan =
	| { required: false }
	| {
			required: true
			policy: PolicyInput
			snapshot: PolicySnapshot
			purpose: PaymentPurpose
			kind: (typeof rsvPayments.$inferInsert)['kind']
			provider: 'stripe' | 'checkout'
			amountMinor: number
			currency: string
			termsText: string | null
			termsHash: string
	  }

export function toPolicyInput(
	row: typeof rsvPolicies.$inferSelect,
): PolicyInput {
	return {
		id: row.id,
		name: row.name,
		kind: row.kind,
		amountMinor: row.amountMinor,
		perCover: row.perCover,
		currency: row.currency,
		freeCancelUntilMin: row.freeCancelUntilMin,
		lateCancelFeeMinor: row.lateCancelFeeMinor,
		noShowFeeMinor: row.noShowFeeMinor,
		feePerCover: row.feePerCover,
		feeCapMinor: row.feeCapMinor,
		refundRule: row.refundRule,
		partialRefundBp: row.partialRefundBp,
		appliesPartyMin: row.appliesPartyMin,
		termsVersion: row.termsVersion,
		archivedAt: row.archivedAt,
	}
}

async function loadPolicy(
	tx: Tx,
	id: string | null | undefined,
	locationId: string,
): Promise<PolicyInput | null> {
	if (!id) return null
	const row = await tx
		.select()
		.from(rsvPolicies)
		.where(eq(rsvPolicies.id, id))
		.get()
	// A policy of another location never applies.
	if (!row || row.locationId !== locationId) return null
	return toPolicyInput(row)
}

/** Experience policy, then service policy, then the location default. */
export async function selectBookingPolicy(
	tx: Tx,
	params: {
		locationId: string
		serviceId?: string | null
		experienceId?: string | null
		partySize: number
	},
): Promise<PolicyInput | null> {
	const [experienceRow, serviceRow, settings] = await Promise.all([
		params.experienceId
			? tx
					.select({ policyId: rsvExperiences.policyId })
					.from(rsvExperiences)
					.where(eq(rsvExperiences.id, params.experienceId))
					.get()
			: Promise.resolve(undefined),
		params.serviceId
			? tx
					.select({ policyId: rsvServices.policyId })
					.from(rsvServices)
					.where(eq(rsvServices.id, params.serviceId))
					.get()
			: Promise.resolve(undefined),
		tx
			.select({ defaultPolicyId: rsvLocationSettings.defaultPolicyId })
			.from(rsvLocationSettings)
			.where(eq(rsvLocationSettings.locationId, params.locationId))
			.get(),
	])
	const [experience, service, location] = await Promise.all([
		loadPolicy(tx, experienceRow?.policyId, params.locationId),
		loadPolicy(tx, serviceRow?.policyId, params.locationId),
		loadPolicy(tx, settings?.defaultPolicyId, params.locationId),
	])
	return selectPolicy({ experience, service, location }, params.partySize)
}

export function processorToProvider(
	processor: 'connect' | 'checkout',
): 'stripe' | 'checkout' {
	return processor === 'connect' ? 'stripe' : 'checkout'
}

function pickTerms(
	terms: Record<string, string> | null | undefined,
	locale: string,
	org: LocaleOrg,
): string | null {
	// The legal text is never dropped: requested language, organization default,
	// then whatever the operator did write.
	return (
		pickText(terms, locale, org) ??
		Object.values(terms ?? {})
			.find((value) => value?.trim())
			?.trim() ??
		null
	)
}

export function hashPolicyTerms(
	termsText: string | null,
	termsVersion: number,
): string {
	return createHash('sha256')
		.update(`${termsVersion}\n${termsText ?? ''}`)
		.digest('hex')
}

/**
 * Decides whether a booking needs payment. With the `payments` feature off a
 * money policy does not apply (the flag gates deposits, guarantees and fees).
 * With it on, an unavailable processor fails closed with `policy_unavailable`
 * and nothing is written.
 */
export async function planBookingPayment(
	tx: Tx,
	params: {
		context: ReservationsContext | null | undefined
		locationId: string
		serviceId?: string | null
		experienceId?: string | null
		partySize: number
		locale: string
	},
): Promise<BookingPaymentPlan> {
	const context = params.context
	if (!context?.features.payments) return { required: false }
	const policy = await selectBookingPolicy(tx, params)
	if (!policy || !policyRequiresPayment(policy.kind)) return { required: false }
	const payments = context.payments
	const supported =
		policy.kind === 'card_guarantee' ? payments.guarantee : payments.deposit
	if (!payments.processor || !supported) {
		throw new HttpError(409, 'policy_unavailable')
	}
	const settings = await tx
		.select({ currency: rsvLocationSettings.currency })
		.from(rsvLocationSettings)
		.where(eq(rsvLocationSettings.locationId, params.locationId))
		.get()
	let snapshot = snapshotPolicy(
		{ ...policy, currency: settings?.currency ?? policy.currency },
		params.partySize,
	)
	// A priced experience charges its own ticket price, per cover or flat.
	if (
		params.experienceId &&
		(policy.kind === 'deposit' || policy.kind === 'prepay')
	) {
		const experience = await tx
			.select({
				priceMinor: rsvExperiences.priceMinor,
				pricePerCover: rsvExperiences.pricePerCover,
			})
			.from(rsvExperiences)
			.where(eq(rsvExperiences.id, params.experienceId))
			.get()
		if (experience && experience.priceMinor !== null) {
			snapshot = {
				...snapshot,
				amountMinor: experience.priceMinor,
				perCover: experience.pricePerCover,
				totalAmountMinor: experience.pricePerCover
					? experience.priceMinor * params.partySize
					: experience.priceMinor,
			}
		}
	}
	const termsRow = await tx
		.select({ termsI18n: rsvPolicies.termsI18n })
		.from(rsvPolicies)
		.where(eq(rsvPolicies.id, policy.id))
		.get()
	const termsText = pickTerms(
		termsRow?.termsI18n,
		params.locale,
		context.organization,
	)
	const purpose: PaymentPurpose =
		policy.kind === 'card_guarantee'
			? 'guarantee'
			: params.experienceId
				? 'experience'
				: policy.kind === 'prepay'
					? 'prepay'
					: 'deposit'
	return {
		required: true,
		policy,
		snapshot,
		purpose,
		kind:
			purpose === 'guarantee'
				? 'card_setup'
				: policy.kind === 'prepay' || purpose === 'experience'
					? 'prepay_charge'
					: 'deposit_charge',
		provider: processorToProvider(payments.processor),
		amountMinor: snapshot.totalAmountMinor,
		currency: snapshot.currency,
		termsText,
		termsHash: hashPolicyTerms(termsText, policy.termsVersion),
	}
}

/** The first payment row of a booking: no provider session bound yet. */
export async function insertBookingPaymentRow(
	tx: Tx,
	params: {
		reservationId: string
		locationId: string
		plan: Extract<BookingPaymentPlan, { required: true }>
		now: number
	},
): Promise<string> {
	const id = `pay_${randomUUID()}`
	await tx.insert(rsvPayments).values({
		id,
		locationId: params.locationId,
		reservationId: params.reservationId,
		provider: params.plan.provider,
		kind: params.plan.kind,
		purpose: params.plan.purpose,
		amountMinor: params.plan.amountMinor,
		currency: params.plan.currency,
		status: 'created',
		attempt: 1,
		idempotencyKey: `rsv:${params.reservationId}:${params.plan.kind}:1`,
		createdAt: params.now,
		updatedAt: params.now,
	})
	return id
}

export type PaymentBlock = {
	paymentToken: string
	purpose: PaymentPurpose
	amountMinor: number
	currency: string
	expiresAt: string
	payUrl: string | null
}

export function buildPaymentBlock(params: {
	orgId: string
	context: ReservationsContext
	reservation: {
		id: string
		manageTokenVersion: number
		paymentExpiresAt: number | null
		guestLocale: string
	}
	purpose: PaymentPurpose
	amountMinor: number
	currency: string
}): PaymentBlock {
	const paymentToken = deriveReservationPayToken(
		params.orgId,
		params.reservation.id,
		params.reservation.manageTokenVersion,
	)
	const origin = params.context.organization.siteOrigin?.replace(/\/$/, '')
	const { defaultLocale, locales } = params.context.organization
	const locale = params.reservation.guestLocale
	const prefix =
		origin && locale !== defaultLocale && locales.includes(locale)
			? `${origin}/${locale}`
			: origin
	return {
		paymentToken,
		purpose: params.purpose,
		amountMinor: params.amountMinor,
		currency: params.currency,
		expiresAt: new Date(
			params.reservation.paymentExpiresAt ?? Date.now(),
		).toISOString(),
		payUrl: prefix
			? `${prefix}/reserve/pay#r=${params.reservation.id}&t=${paymentToken}`
			: null,
	}
}

export async function paymentHoldMinutes(
	tx: Tx,
	locationId: string,
): Promise<number> {
	const settings = await tx
		.select({ minutes: rsvLocationSettings.paymentHoldMinutes })
		.from(rsvLocationSettings)
		.where(eq(rsvLocationSettings.locationId, locationId))
		.get()
	return settings?.minutes ?? DEFAULT_PAYMENT_HOLD_MINUTES
}

export type HoldPolicyView = {
	requiresPayment: boolean
	policy: {
		kind: string
		purpose: PaymentPurpose
		termsVersion: number
		terms: string | null
		amountMinor: number
		totalAmountMinor: number
		perCover: boolean
		currency: string
		freeCancelUntilMin: number
		lateCancelFeeMinor: number
		noShowFeeMinor: number
	} | null
}

/**
 * What a guest must accept before booking this slot, shown with the hold.
 * Throws `policy_unavailable` when the policy needs a processor that cannot
 * take it, so nothing is held for a booking that could never be paid.
 */
export async function describeBookingPolicy(
	db: TenantDatabase,
	params: Parameters<typeof planBookingPayment>[1],
): Promise<HoldPolicyView> {
	const plan = await planBookingPayment(db, params)
	if (!plan.required) return { requiresPayment: false, policy: null }
	return {
		requiresPayment: true,
		policy: {
			kind: plan.policy.kind,
			purpose: plan.purpose,
			termsVersion: plan.policy.termsVersion,
			terms: plan.termsText,
			amountMinor: plan.snapshot.amountMinor,
			totalAmountMinor: plan.snapshot.totalAmountMinor,
			perCover: plan.snapshot.perCover,
			currency: plan.currency,
			freeCancelUntilMin: plan.snapshot.freeCancelUntilMin,
			lateCancelFeeMinor: plan.snapshot.lateCancelFeeMinor,
			noShowFeeMinor: plan.snapshot.noShowFeeMinor,
		},
	}
}
