import {
	STAFF_CONSENT_TEXT_VERSION,
	type StaffConsentMethod,
} from '@repo/common/marketing-consent'
import { sendSms } from '@repo/sms'
import {
	customers,
	customerSubscriptions,
	rsvAuditLog,
	type CustomerSubscriptionChannel,
	type TenantDatabase,
} from '@repo/tenant-db'
import { and, eq } from 'drizzle-orm'
import { badRequest, conflict, forbidden } from '../lib/http.ts'
import { findActiveOrganizationById } from '../lib/origin.ts'
import { checkGlobalSendCap } from '../lib/rate-limit.ts'
import { withSetupWrite } from '../lib/reservations-write.ts'
import { smsRouteAvailable } from '../lib/sms-route.ts'
import {
	emailConsentHash,
	isInStaffConsentCoolingOff,
	setCustomerSubscription,
} from './marketing-audience.ts'
import { resolvePerson, type PeopleAccess } from './people-service.ts'
import { smsRestaurantName } from './pos-ready-text-service.ts'
import {
	serializePersonSubscription,
	staffCoolingOffUntil,
	type PersonSubscription,
} from './rsv-marketing-consent.ts'
import {
	RESEND_INTERVAL_MS,
	requestSubscriptionConfirmation,
} from './subscription-confirmation.ts'

/**
 * Staff recording a guest's marketing consent on their behalf (#302): the
 * guest agreed in person, on a paper form or by phone, and a member holding
 * `update:marketing_consent:any` records it on the guest's profile.
 *
 * - The topic is always `marketing` (broadcasts).
 * - Turning ON needs how the guest agreed (`method`) and the staff member's
 *   attestation. A guest's own opt-out younger than the cooling-off period
 *   refuses it (409 `cooling_off`), so staff cannot undo a fresh unsubscribe.
 * - Email is NEVER confirmed by staff: the subscription is pending until the
 *   address's owner follows the emailed link (the same link and resend
 *   throttle as every other opt-in). An already active subscription is left
 *   as it is (its original provenance is the record); a pending one only gets
 *   the confirmation link again, through the throttle.
 * - Texts are recorded active at once: the staff attestation is the consent.
 *   They are delivered only once the phone is verified (`loadBroadcastAudience`),
 *   which `deliverable` reports. A new text opt-in gets one confirmation text
 *   on the US node when the phone is verified (see `sendConsentText`).
 * - Turning OFF is one call, says nothing to the guest, and records the
 *   opt-out as `operator`, which does not start a cooling-off. Opting out a
 *   subscription that is already off (or absent) writes nothing, so a guest's
 *   own opt-out keeps its source.
 * Every change writes an `rsv_audit_log` row (actor, channel, on or off,
 * method): ids and vocabulary only, never contact details.
 */

export const STAFF_CONSENT_TOPIC = 'marketing' as const

export type PersonConsentInput = {
	channel: CustomerSubscriptionChannel
	subscribed: boolean
	method?: StaffConsentMethod
	attested?: boolean
	textVersion?: string
}

export type PersonConsentResult = {
	/** The subscription as the profile shows it; null when none exists. */
	subscription: PersonSubscription | null
	/**
	 * Texts only: whether a broadcast would reach this guest now (active and
	 * a verified phone). False until the guest verifies their phone.
	 */
	deliverable?: boolean
	confirmationSms?: 'sent' | 'skipped'
	confirmationEmail?: 'sent' | 'throttled' | 'skipped'
}

type Deps = {
	sendSms?: (input: { to: string; message: string }) => Promise<unknown>
	now?: number
}

/** A previous opt-in this recent sends no second confirmation text. */
export const CONSENT_TEXT_REPEAT_MS = 24 * 60 * 60 * 1000

export function consentConfirmationText(restaurant: string): string {
	return `You're subscribed to ${smsRestaurantName(restaurant)} offers. Reply STOP to unsubscribe.`
}

async function readSubscription(
	db: TenantDatabase,
	customerId: string,
	channel: CustomerSubscriptionChannel,
) {
	return db
		.select()
		.from(customerSubscriptions)
		.where(
			and(
				eq(customerSubscriptions.customerId, customerId),
				eq(customerSubscriptions.topic, STAFF_CONSENT_TOPIC),
				eq(customerSubscriptions.channel, channel),
			),
		)
		.get()
}

/** The customer row consent attaches to; never created here. */
async function consentCustomer(
	db: TenantDatabase,
	access: PeopleAccess,
	rawKey: string,
) {
	const person = await resolvePerson(db, access, rawKey)
	if (person.customer) return person.customer
	// A guest-only person whose booking-form consent created an unverified
	// customer row: that row is where their consent already lives.
	const shadowId = person.guest?.marketingCustomerId
	if (shadowId) {
		const shadow = await db
			.select()
			.from(customers)
			.where(eq(customers.id, shadowId))
			.get()
		if (shadow) return shadow
	}
	throw conflict(
		'no_customer',
		'This guest has no customer record to attach consent to',
	)
}

export async function recordPersonConsent(
	db: TenantDatabase,
	access: PeopleAccess,
	rawKey: string,
	input: PersonConsentInput,
	opts: { orgId: string } & Deps,
): Promise<PersonConsentResult> {
	if (!access.customers || access.canUpdateMarketingConsent !== true) {
		throw forbidden(
			'insufficient_permissions',
			'Recording marketing consent is not allowed',
		)
	}
	if (input.subscribed) {
		if (!input.method) {
			throw badRequest('method_required', 'Say how the guest agreed')
		}
		if (input.attested !== true) {
			throw badRequest(
				'attestation_required',
				'Confirm that the guest agreed to receive offers',
			)
		}
	}
	const now = opts.now ?? Date.now()
	const at = new Date(now)
	const customer = await consentCustomer(db, access, rawKey)
	const channel = input.channel

	type Outcome = {
		changed: boolean
		newSmsOptIn: boolean
		emailToConfirm: string | null
	}
	const outcome: Outcome = await withSetupWrite(db, async (tx) => {
		const result: Outcome = {
			changed: false,
			newSmsOptIn: false,
			emailToConfirm: null,
		}
		// Re-read inside the write: the profile may have changed since.
		const fresh = await tx
			.select()
			.from(customers)
			.where(eq(customers.id, customer.id))
			.get()
		if (!fresh) throw conflict('no_customer', 'The customer record is gone')
		const existing = await readSubscription(tx, fresh.id, channel)
		const active = Boolean(existing && !existing.unsubscribedAt)

		if (!input.subscribed) {
			if (!active) return result
			await setCustomerSubscription(tx, {
				customerId: fresh.id,
				topic: STAFF_CONSENT_TOPIC,
				channel,
				subscribed: false,
				source: 'staff',
				now: at,
				unsubscribedSource: 'operator',
			})
			await audit(tx, {
				actorId: access.actorId,
				customerId: fresh.id,
				now,
				changes: { topic: STAFF_CONSENT_TOPIC, channel, subscribed: false },
			})
			result.changed = true
			return result
		}

		if (
			await isInStaffConsentCoolingOff(tx, {
				customerId: fresh.id,
				topic: STAFF_CONSENT_TOPIC,
				channel,
				now: at,
			})
		) {
			const until = existing ? staffCoolingOffUntil(existing, now) : null
			throw conflict(
				'cooling_off',
				'The guest unsubscribed recently; ask them to opt in themselves',
				until ? { until: until.toISOString() } : undefined,
			)
		}

		if (channel === 'email') {
			const email = fresh.email?.trim()
			if (!email) {
				throw conflict('email_required', 'Add an email address first')
			}
			if (active) {
				// Already subscribed: never reset a confirmed address to pending,
				// and never rewrite the original provenance. A pending one gets
				// its link again (throttled).
				if (existing!.confirmedEmailHash !== emailConsentHash(email)) {
					result.emailToConfirm = email
				}
				return result
			}
			await setCustomerSubscription(tx, {
				customerId: fresh.id,
				topic: STAFF_CONSENT_TOPIC,
				channel,
				subscribed: true,
				source: 'staff',
				now: at,
				// Staff cannot vouch for an address: pending until its owner confirms.
				confirmedEmail: null,
				recordedBy: access.actorId,
				consentMethod: input.method!,
				consentTextVersion: input.textVersion ?? STAFF_CONSENT_TEXT_VERSION,
			})
			result.emailToConfirm = email
		} else {
			if (!fresh.phone?.trim()) {
				throw conflict('phone_required', 'Add a phone number first')
			}
			if (active) return result
			await setCustomerSubscription(tx, {
				customerId: fresh.id,
				topic: STAFF_CONSENT_TOPIC,
				channel,
				subscribed: true,
				source: 'staff',
				now: at,
				recordedBy: access.actorId,
				consentMethod: input.method!,
				consentTextVersion: input.textVersion ?? STAFF_CONSENT_TEXT_VERSION,
			})
			// One confirmation text per new opt-in, but not again for an
			// on-off-on within a day (each text costs money and reaches the guest).
			const lastOptIn = existing?.subscribedAt?.getTime() ?? 0
			result.newSmsOptIn =
				!existing || now - lastOptIn >= CONSENT_TEXT_REPEAT_MS
		}
		await audit(tx, {
			actorId: access.actorId,
			customerId: fresh.id,
			now,
			changes: {
				topic: STAFF_CONSENT_TOPIC,
				channel,
				subscribed: true,
				method: input.method!,
				textVersion: input.textVersion ?? STAFF_CONSENT_TEXT_VERSION,
			},
		})
		result.changed = true
		return result
	})

	// ---- after commit: messages never fail the request ----------------------
	const after = await db
		.select()
		.from(customers)
		.where(eq(customers.id, customer.id))
		.get()
	const result: PersonConsentResult = { subscription: null }

	if (input.subscribed && channel === 'email') {
		result.confirmationEmail = outcome.emailToConfirm
			? await confirmEmail(db, {
					orgId: opts.orgId,
					customerId: customer.id,
					email: outcome.emailToConfirm,
					name: after?.name ?? customer.name,
					now,
				})
			: 'skipped'
	}
	if (input.subscribed && channel === 'sms') {
		result.confirmationSms =
			outcome.newSmsOptIn && after
				? await sendConsentText(
						{
							orgId: opts.orgId,
							customerId: customer.id,
							phone: after.phone,
							phoneVerified: Boolean(after.phoneVerified),
						},
						opts.sendSms ?? sendSms,
					)
				: 'skipped'
	}

	const row = await readSubscription(db, customer.id, channel)
	result.subscription = row
		? serializePersonSubscription(row, after?.email, now)
		: null
	if (channel === 'sms') {
		result.deliverable = Boolean(
			row && !row.unsubscribedAt && after?.phone?.trim() && after.phoneVerified,
		)
	}
	return result
}

async function audit(
	tx: TenantDatabase,
	params: {
		actorId: string
		customerId: string
		now: number
		changes: Record<string, unknown>
	},
) {
	await tx.insert(rsvAuditLog).values({
		id: `aud_${crypto.randomUUID()}`,
		at: params.now,
		actorKind: 'operator',
		actorId: params.actorId,
		locationId: null,
		action: 'customer.marketing_consent',
		entityType: 'customer',
		entityId: params.customerId,
		changes: { ...params.changes, source: 'staff' },
	})
}

async function confirmEmail(
	db: TenantDatabase,
	params: {
		orgId: string
		customerId: string
		email: string
		name: string
		now: number
	},
): Promise<'sent' | 'throttled' | 'skipped'> {
	const row = await readSubscription(db, params.customerId, 'email')
	if (
		row?.confirmationSentHash === emailConsentHash(params.email) &&
		row.confirmationSentAt &&
		params.now - row.confirmationSentAt.getTime() < RESEND_INTERVAL_MS
	) {
		return 'throttled'
	}
	const sent = await requestSubscriptionConfirmation(db, {
		orgId: params.orgId,
		customerId: params.customerId,
		topic: STAFF_CONSENT_TOPIC,
		email: params.email,
		name: params.name,
		now: params.now,
	})
	return sent ? 'sent' : 'skipped'
}

/**
 * The one "You're subscribed" text for a new staff-recorded text opt-in.
 * Skipped (consent stays recorded) when: this node cannot text guests (only
 * the US node can), the phone is not verified (a number only counts once its
 * owner proved control of it), the restaurant name is unknown, or the
 * node-wide send cap is reached. A failed send is logged by id only.
 */
async function sendConsentText(
	params: {
		orgId: string
		customerId: string
		phone: string | null
		phoneVerified: boolean
	},
	send: (input: { to: string; message: string }) => Promise<unknown>,
): Promise<'sent' | 'skipped'> {
	const phone = params.phone?.trim()
	if (!phone || !params.phoneVerified || !smsRouteAvailable()) return 'skipped'
	try {
		const organization = await findActiveOrganizationById(params.orgId)
		const restaurant =
			organization && 'name' in organization
				? (organization.name ?? '').trim()
				: ''
		if (!restaurant) return 'skipped'
		if (checkGlobalSendCap().limited) return 'skipped'
		await send({ to: phone, message: consentConfirmationText(restaurant) })
		return 'sent'
	} catch (error) {
		console.warn('Consent confirmation text failed', {
			orgId: params.orgId,
			customerId: params.customerId,
			error: error instanceof Error ? error.name : 'unknown',
		})
		return 'skipped'
	}
}
