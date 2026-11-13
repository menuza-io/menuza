import { STAFF_CONSENT_COOLING_OFF_DAYS } from '@repo/common/marketing-consent'
import {
	customers,
	customerSubscriptions,
	getTenantDb,
	rsvGuests,
	type CustomerConsentMethod,
	type CustomerSubscription,
	type CustomerUnsubscribeSource,
	type RsvGuestRow,
} from '@repo/tenant-db'
import { and, eq } from 'drizzle-orm'
import {
	emailConsentHash,
	setCustomerSubscription,
} from './marketing-audience.ts'
import { type DbOrTx } from './rsv-guest-service.ts'
import { requestSubscriptionConfirmation } from './subscription-confirmation.ts'

/**
 * `customer_subscriptions` is the ONLY marketing consent store. Nothing here
 * (or anywhere) reads or writes the deprecated `rsv_guests.marketing_*_consent_at`
 * columns.
 *
 * A guest who ticked the marketing box becomes eligible for reservation
 * journeys. Nothing here creates a login: the customer row it may create is
 * unverified and keyed by the phone the guest typed.
 *
 * Anyone can type someone else's phone number, so an existing customer is
 * never rewritten and a verified one (the owner already proved the number) is
 * never linked from a booking form: it joins journeys by signing in.
 */
export const RESERVATION_CONSENT_TOPIC = 'reservations' as const
export const RESERVATION_CONSENT_SOURCE = 'reservation_booking' as const

const STAFF_CONSENT_COOLING_OFF_MS =
	STAFF_CONSENT_COOLING_OFF_DAYS * 24 * 60 * 60 * 1000

type ConsentChannel = 'email' | 'sms'

type ConsentGuest = Pick<
	RsvGuestRow,
	'id' | 'customerId' | 'marketingCustomerId' | 'phoneE164' | 'emailNorm'
> &
	Pick<RsvGuestRow, 'firstName' | 'lastName'>

async function recordSubscriptions(
	tx: DbOrTx,
	customerId: string,
	channels: readonly ConsentChannel[],
	now: number,
	email: string | null,
) {
	const at = new Date(now)
	for (const channel of channels) {
		let confirmedEmail: string | null | undefined
		if (channel === 'email') {
			// Double opt-in: an address typed on a form is not proof of ownership,
			// so the subscription stays pending until its owner follows the emailed
			// link. A re-tick for an address already confirmed keeps it confirmed.
			const existing = await tx
				.select({
					unsubscribedAt: customerSubscriptions.unsubscribedAt,
					confirmedEmailHash: customerSubscriptions.confirmedEmailHash,
				})
				.from(customerSubscriptions)
				.where(
					and(
						eq(customerSubscriptions.customerId, customerId),
						eq(customerSubscriptions.topic, RESERVATION_CONSENT_TOPIC),
						eq(customerSubscriptions.channel, 'email'),
					),
				)
				.get()
			const alreadyConfirmed =
				Boolean(email) &&
				existing &&
				!existing.unsubscribedAt &&
				existing.confirmedEmailHash === emailConsentHash(email!)
			confirmedEmail = alreadyConfirmed ? email : null
		}
		await setCustomerSubscription(tx, {
			customerId,
			topic: RESERVATION_CONSENT_TOPIC,
			channel,
			subscribed: true,
			source: RESERVATION_CONSENT_SOURCE,
			now: at,
			confirmedEmail,
		})
	}
}

/**
 * Records explicit marketing consent given on a booking form for the address
 * the guest profile holds. Returns the customer the journeys run for, or null
 * when the booking is not eligible.
 */
export async function recordReservationMarketingConsent(
	tx: DbOrTx,
	params: {
		guest: ConsentGuest
		/** The consent covers only this address (already normalized). */
		email: string | null
		channels: readonly ConsentChannel[]
		now: number
	},
): Promise<string | null> {
	const { guest, channels, now } = params
	if (channels.length === 0) return null
	if (channels.includes('email')) {
		// Consent only counts for the address the profile holds.
		if (!params.email || guest.emailNorm !== params.email) return null
	}

	// A signed-in (verified) guest: the consent attaches to their own account.
	if (guest.customerId) {
		await recordSubscriptions(tx, guest.customerId, channels, now, params.email)
		return guest.customerId
	}

	if (guest.marketingCustomerId) {
		await recordSubscriptions(
			tx,
			guest.marketingCustomerId,
			channels,
			now,
			params.email,
		)
		return guest.marketingCustomerId
	}

	if (!guest.phoneE164) return null
	const existing = await tx
		.select({
			id: customers.id,
			email: customers.email,
			phoneVerified: customers.phoneVerified,
		})
		.from(customers)
		.where(eq(customers.phone, guest.phoneE164))
		.get()

	let customerId: string
	if (existing) {
		if (existing.phoneVerified) return null
		const sameEmail = !existing.email || existing.email === guest.emailNorm
		if (!sameEmail) return null
		customerId = existing.id
		if (!existing.email && guest.emailNorm) {
			await tx
				.update(customers)
				.set({ email: guest.emailNorm, updatedAt: new Date(now) })
				.where(
					and(
						eq(customers.id, existing.id),
						eq(customers.phoneVerified, false),
					),
				)
		}
	} else {
		const [created] = await tx
			.insert(customers)
			.values({
				name: `${guest.firstName} ${guest.lastName}`.trim(),
				email: guest.emailNorm,
				phone: guest.phoneE164,
				phoneVerified: false,
			})
			.returning({ id: customers.id })
		customerId = created!.id
	}

	await tx
		.update(rsvGuests)
		.set({ marketingCustomerId: customerId, updatedAt: now })
		.where(eq(rsvGuests.id, guest.id))
	await recordSubscriptions(tx, customerId, channels, now, params.email)
	return customerId
}

/**
 * After the booking commits, emails the owner of a booking-form address the
 * link that confirms it (double opt-in): until they follow it, no reservation
 * journey email is sent to that address. Idempotent and throttled per address;
 * a failed send never fails the booking and is retried by the next booking
 * that ticks the box.
 */
export function queueConsentConfirmation(
	afterCommit: (hook: () => void | Promise<void>) => void,
	params: {
		orgId: string
		customerId: string | null
		email: string | null
		name: string
	},
) {
	const { customerId, email } = params
	if (!customerId || !email) return
	afterCommit(async () => {
		const db = await getTenantDb(params.orgId)
		await requestSubscriptionConfirmation(db, {
			orgId: params.orgId,
			customerId,
			topic: RESERVATION_CONSENT_TOPIC,
			email,
			name: params.name,
		})
	})
}

/**
 * One subscription as the operator profile shows it. Additive over the older
 * shape (`topic` .. `source`): who opted out, whether an email opt-in still
 * waits for its owner's confirmation, who recorded a staff consent and how,
 * and until when a guest's own opt-out blocks a staff opt-in. No contact
 * details: `staff.recordedBy` is an opaque operator user id the App resolves
 * to a name.
 */
export type PersonSubscription = {
	topic: string
	channel: string
	/** True while the subscription is active (not unsubscribed). */
	subscribed: boolean
	subscribedAt: number
	unsubscribedAt: number | null
	source: string
	/** Who opted out (`self`, `operator`, `import`); null while active or unknown. */
	unsubscribedSource: CustomerUnsubscribeSource | null
	/** An active email opt-in not yet confirmed for the address on file. */
	pending: boolean
	/** Present when a staff member recorded the consent (`source: 'staff'`). */
	staff: {
		recordedBy: string
		method: CustomerConsentMethod | null
		textVersion: string | null
	} | null
	/**
	 * ISO time until which a staff opt-in is refused because the guest opted
	 * out themselves (`STAFF_CONSENT_COOLING_OFF_DAYS`); null when not blocked.
	 */
	coolingOffUntil: string | null
}

export type GuestMarketingConsent = {
	subscriptions: PersonSubscription[]
}

/** The end of a guest's own opt-out's cooling-off, or null when none applies. */
export function staffCoolingOffUntil(
	row: Pick<CustomerSubscription, 'unsubscribedAt' | 'unsubscribedSource'>,
	now: number = Date.now(),
): Date | null {
	if (!row.unsubscribedAt) return null
	// A null source predates the column and counts as the guest's own.
	if (row.unsubscribedSource && row.unsubscribedSource !== 'self') return null
	const until = row.unsubscribedAt.getTime() + STAFF_CONSENT_COOLING_OFF_MS
	return until > now ? new Date(until) : null
}

export function serializePersonSubscription(
	row: CustomerSubscription,
	customerEmail: string | null | undefined,
	now: number = Date.now(),
): PersonSubscription {
	const active = row.unsubscribedAt === null
	const email = customerEmail?.trim()
	const pending =
		active &&
		row.channel === 'email' &&
		!(email && row.confirmedEmailHash === emailConsentHash(email))
	const coolingOff = staffCoolingOffUntil(row, now)
	return {
		topic: row.topic,
		channel: row.channel,
		subscribed: active,
		subscribedAt: row.subscribedAt.getTime(),
		unsubscribedAt: row.unsubscribedAt?.getTime() ?? null,
		source: row.source,
		unsubscribedSource: active ? null : (row.unsubscribedSource ?? null),
		pending,
		staff:
			row.source === 'staff'
				? {
						recordedBy: row.recordedBy ?? '',
						method: row.consentMethod ?? null,
						textVersion: row.consentTextVersion ?? null,
					}
				: null,
		coolingOffUntil: coolingOff ? coolingOff.toISOString() : null,
	}
}

/**
 * Marketing consent of a guest, read ONLY from `customer_subscriptions` of the
 * customer row the guest is linked to (`customer_id`, else the
 * `marketing_customer_id` a booking-form consent created). `null` when the
 * guest has no customer row: there is no consent to show, never a guess from
 * the deprecated `rsv_guests.marketing_*_consent_at` columns.
 */
export async function loadGuestMarketingConsent(
	db: DbOrTx,
	guest: {
		customerId: string | null
		marketingCustomerId: string | null
	} | null,
	opts?: { now?: number },
): Promise<GuestMarketingConsent | null> {
	const customerId = guest?.customerId ?? guest?.marketingCustomerId ?? null
	if (!customerId) return null
	const rows = await db
		.select()
		.from(customerSubscriptions)
		.where(eq(customerSubscriptions.customerId, customerId))
		.all()
	const customer =
		rows.length > 0
			? await db
					.select({ email: customers.email })
					.from(customers)
					.where(eq(customers.id, customerId))
					.get()
			: undefined
	const now = opts?.now ?? Date.now()
	return {
		subscriptions: rows
			.map((row) => serializePersonSubscription(row, customer?.email, now))
			.sort((a, b) =>
				`${a.topic}:${a.channel}`.localeCompare(`${b.topic}:${b.channel}`),
			),
	}
}
