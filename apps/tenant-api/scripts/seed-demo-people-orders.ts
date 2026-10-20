/**
 * Local-only demo data for the People (Customers) and Orders screens.
 *
 *   npm run seed:demo-people -w tenant-api -- acme-demo
 *
 * Writes ONLY to the whitelisted demo organization (see
 * `seed-demo-people-guard.ts`); refuses production and every other org. Fixed
 * ids make reruns update rows instead of duplicating them. It builds on
 * `seed-reservations.ts` (areas, tables, services, guests 1-8 must exist) and
 * adds customers, subscriptions, restaurant orders, reservation history,
 * upcoming reservations (one with a paid deposit), waitlist entries, two
 * experience schedules, guest tags and notes. Reservation guests are linked to
 * customers ONLY through the real `linkGuestsToCustomers` (verified phone).
 */
import { createHash } from 'node:crypto'
import {
	RESTAURANT_ORDER_STATUS_VALUES,
	RESTAURANT_PAYMENT_STATUS_VALUES,
	type PricedOrderLine,
} from '@repo/common/restaurant-orders'
import { snapshotPolicy } from '@repo/reservations'
import {
	customers,
	customerSubscriptions,
	getTenantDb,
	provisionTenantDb,
	refreshReservationsTriggers,
	restaurantOrders,
	RSV_ACTOR_KIND_VALUES,
	RSV_CANCELLED_BY_VALUES,
	RSV_PAYMENT_KIND_VALUES,
	RSV_PAYMENT_PROVIDER_VALUES,
	RSV_PAYMENT_RECORD_STATUS_VALUES,
	RSV_PAYMENT_STATUS_VALUES,
	RSV_RESERVATION_CHANNEL_VALUES,
	RSV_RESERVATION_STATUS_VALUES,
	RSV_WAITLIST_CHANNEL_VALUES,
	RSV_WAITLIST_STATUS_VALUES,
	rsvDayVersions,
	rsvExperienceSchedules,
	rsvGuestNotes,
	rsvGuests,
	rsvGuestTags,
	rsvPayments,
	rsvPolicies,
	rsvReservationEvents,
	rsvReservations,
	rsvReservationTags,
	rsvTableOccupancies,
	rsvTables,
	rsvTags,
	rsvWaitlistEntries,
	type CUSTOMER_SUBSCRIPTION_SOURCES,
} from '@repo/tenant-db'
import {
	addDays,
	businessDayStartMs,
	dayOfWeek,
	localParts,
} from '@repo/zoned-time'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { linkGuestsToCustomers } from '../src/services/rsv-customer-link.ts'
import {
	assertWhitelistedOrgId,
	resolveDemoOrg,
} from './seed-demo-people-guard.ts'

function fail(message: string): never {
	console.error(message)
	process.exit(1)
}

/** Throws when a literal is not a member of its enum constant. */
function oneOf<const T extends readonly string[]>(
	values: T,
	value: string,
): T[number] {
	if (!values.includes(value)) {
		throw new Error(`"${value}" is not one of ${values.join(', ')}`)
	}
	return value as T[number]
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex')

/** Small deterministic PRNG so reruns generate the same history. */
function mulberry32(seed: number) {
	let a = seed
	return () => {
		a |= 0
		a = (a + 0x6d2b79f5) | 0
		let t = Math.imul(a ^ (a >>> 15), 1 | a)
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

// ---------------------------------------------------------------------------
// Static demo data (fake PII only: example.com and +1212555xxxx)
// ---------------------------------------------------------------------------

type DemoCustomer = {
	key: string
	name: string
	email: string
	phone: string
	verified: boolean
	createdDaysAgo: number
	/** Subscription pattern per channel; `undefined` = no row. */
	reservationsEmail?: 'on' | 'off'
	reservationsSms?: 'on' | 'off'
	dropsEmail?: 'on' | 'off'
	dropsSms?: 'on' | 'off'
}

const CUSTOMERS: DemoCustomer[] = [
	{
		key: 'c1',
		name: 'Layla Al-Mansoor',
		email: 'layla@example.com',
		phone: '+966501112201',
		verified: true,
		createdDaysAgo: 190,
		reservationsEmail: 'on',
		reservationsSms: 'on',
		dropsEmail: 'on',
		dropsSms: 'on',
	},
	{
		key: 'c2',
		name: 'Marcus Vance',
		email: 'marcus@example.com',
		phone: '+12125550141',
		verified: true,
		createdDaysAgo: 160,
		reservationsEmail: 'on',
		reservationsSms: 'on',
		dropsEmail: 'on',
		dropsSms: 'on',
	},
	{
		key: 'c3',
		name: 'Elena Rostova',
		email: 'elena@example.com',
		phone: '+12125550145',
		verified: true,
		createdDaysAgo: 120,
		reservationsEmail: 'on',
		dropsEmail: 'on',
	},
	{
		key: 'c4',
		name: 'Devon Brooks',
		email: 'devon@example.com',
		phone: '+12125550146',
		verified: true,
		createdDaysAgo: 95,
		reservationsSms: 'on',
		dropsSms: 'on',
	},
	{
		key: 'c5',
		name: 'James Okafor',
		email: 'james.okafor@example.com',
		phone: '+12125550151',
		verified: true,
		createdDaysAgo: 85,
		reservationsEmail: 'on',
		reservationsSms: 'on',
		dropsEmail: 'on',
		dropsSms: 'on',
	},
	{
		key: 'c6',
		name: 'Priya Raman',
		email: 'priya.raman@example.com',
		phone: '+12125550152',
		verified: true,
		createdDaysAgo: 70,
		reservationsEmail: 'off',
		reservationsSms: 'off',
		dropsEmail: 'off',
		dropsSms: 'off',
	},
	{
		key: 'c7',
		name: 'Sofia Delgado',
		email: 'sofia.delgado@example.com',
		phone: '+12125550153',
		verified: true,
		createdDaysAgo: 58,
		reservationsEmail: 'on',
		reservationsSms: 'on',
		dropsEmail: 'on',
	},
	{
		key: 'c8',
		name: 'Ben Whitaker',
		email: 'ben.whitaker@example.com',
		phone: '+12125550154',
		verified: true,
		createdDaysAgo: 44,
		reservationsEmail: 'on',
		dropsEmail: 'on',
	},
	{
		key: 'c9',
		name: 'Hannah Cho',
		email: 'hannah.cho@example.com',
		phone: '+12125550155',
		verified: true,
		createdDaysAgo: 33,
		reservationsEmail: 'off',
		dropsEmail: 'on',
	},
	{
		key: 'c10',
		name: 'Omar Farouk',
		email: 'omar.farouk@example.com',
		phone: '+12125550156',
		verified: true,
		createdDaysAgo: 21,
	},
	{
		key: 'c11',
		name: 'Diego Santos',
		email: 'diego.santos@example.com',
		phone: '+12125550158',
		verified: true,
		createdDaysAgo: 12,
	},
	// The one unverified customer: its phone also belongs to guest 9 (Chloe),
	// which must NOT link (ADR 048: verified phones only).
	{
		key: 'c12',
		name: 'Chloe Bennett',
		email: 'chloe.bennett@example.com',
		phone: '+12125550157',
		verified: false,
		createdDaysAgo: 4,
	},
]

const TAX_RATE = 0.08875
const DELIVERY_FEE_CENTS = 399

const MENU = [
	{ id: 'itm_demo_margherita', name: 'Margherita Pizza', cents: 1600 },
	{ id: 'itm_demo_shawarma', name: 'Chicken Shawarma Plate', cents: 1800 },
	{ id: 'itm_demo_caesar', name: 'Caesar Salad', cents: 1200 },
	{ id: 'itm_demo_kofta', name: 'Lamb Kofta', cents: 2200 },
	{ id: 'itm_demo_hummus', name: 'Hummus and Pita', cents: 900 },
	{ id: 'itm_demo_fries', name: 'Truffle Fries', cents: 1000 },
	{ id: 'itm_demo_tiramisu', name: 'Tiramisu', cents: 1100 },
	{ id: 'itm_demo_soda', name: 'Lemon Soda', cents: 500 },
	{ id: 'itm_demo_salmon', name: 'Grilled Salmon', cents: 2600 },
]

type Pay = 'online' | 'counter' | 'review'
type OrderSpec = {
	who: string // customer key, or `guest:<name>|<phone>`
	daysAgo: number
	minute: number
	fulfillment: 'pickup' | 'delivery'
	status: string
	pay: Pay
	items: Array<[number, number]>
	tip: number
}

const O = (
	who: string,
	daysAgo: number,
	minute: number,
	fulfillment: 'pickup' | 'delivery',
	status: string,
	pay: Pay,
	items: Array<[number, number]>,
	tip: number,
): OrderSpec => ({ who, daysAgo, minute, fulfillment, status, pay, items, tip })

const ORDERS: OrderSpec[] = [
	O(
		'c1',
		55,
		1140,
		'pickup',
		'completed',
		'online',
		[
			[0, 1],
			[4, 1],
			[7, 2],
		],
		15,
	),
	O(
		'c2',
		52,
		1100,
		'delivery',
		'completed',
		'online',
		[
			[1, 2],
			[5, 1],
		],
		18,
	),
	O(
		'c3',
		49,
		1215,
		'pickup',
		'completed',
		'online',
		[
			[3, 1],
			[2, 1],
		],
		10,
	),
	O('c5', 47, 1130, 'pickup', 'completed', 'counter', [[0, 2]], 0),
	O(
		'c1',
		44,
		1190,
		'delivery',
		'completed',
		'online',
		[
			[8, 1],
			[6, 1],
			[7, 1],
		],
		20,
	),
	O('c7', 41, 1160, 'pickup', 'cancelled', 'counter', [[3, 2]], 0),
	O(
		'c8',
		39,
		1110,
		'pickup',
		'completed',
		'online',
		[
			[1, 1],
			[4, 1],
		],
		15,
	),
	O(
		'c2',
		36,
		1250,
		'delivery',
		'completed',
		'online',
		[
			[0, 1],
			[5, 2],
			[7, 2],
		],
		15,
	),
	O(
		'c4',
		34,
		1180,
		'pickup',
		'completed',
		'online',
		[
			[2, 1],
			[8, 1],
		],
		18,
	),
	O(
		'c6',
		31,
		1130,
		'pickup',
		'completed',
		'counter',
		[
			[0, 1],
			[2, 1],
		],
		0,
	),
	O(
		'c9',
		29,
		1205,
		'delivery',
		'completed',
		'online',
		[
			[3, 1],
			[4, 1],
			[6, 2],
		],
		15,
	),
	O('c3', 27, 1140, 'pickup', 'completed', 'online', [[1, 2]], 10),
	O(
		'c10',
		24,
		1170,
		'pickup',
		'completed',
		'online',
		[
			[8, 2],
			[6, 2],
		],
		20,
	),
	O(
		'c5',
		22,
		1120,
		'delivery',
		'cancelled',
		'counter',
		[
			[0, 1],
			[7, 1],
		],
		0,
	),
	O(
		'c1',
		20,
		1185,
		'pickup',
		'completed',
		'online',
		[
			[3, 1],
			[5, 1],
		],
		15,
	),
	O(
		'c11',
		17,
		1135,
		'pickup',
		'completed',
		'online',
		[
			[1, 1],
			[2, 1],
			[7, 1],
		],
		12,
	),
	O(
		'c2',
		15,
		1225,
		'delivery',
		'completed',
		'online',
		[
			[0, 2],
			[6, 1],
		],
		18,
	),
	O(
		'c7',
		13,
		1150,
		'pickup',
		'completed',
		'counter',
		[
			[4, 2],
			[5, 1],
		],
		0,
	),
	O(
		'c8',
		9,
		1175,
		'delivery',
		'completed',
		'online',
		[
			[1, 1],
			[8, 1],
		],
		15,
	),
	O('c4', 7, 1140, 'pickup', 'cancelled', 'counter', [[2, 2]], 0),
	O(
		'c9',
		5,
		1210,
		'pickup',
		'completed',
		'online',
		[
			[3, 1],
			[2, 1],
		],
		15,
	),
	O(
		'c1',
		3,
		1160,
		'delivery',
		'completed',
		'online',
		[
			[8, 1],
			[4, 1],
		],
		20,
	),
	O(
		'c3',
		2,
		1130,
		'pickup',
		'completed',
		'online',
		[
			[0, 1],
			[7, 1],
		],
		10,
	),
	O(
		'c10',
		1,
		1180,
		'pickup',
		'completed',
		'online',
		[
			[1, 2],
			[6, 1],
		],
		15,
	),
	// Guest checkouts (no customer_id). Nadia and Julian are reservation guests
	// without an account; James and Priya own a verified customer phone.
	O(
		'guest:Nadia Haddad|+12125550142',
		33,
		1165,
		'pickup',
		'completed',
		'online',
		[
			[0, 1],
			[2, 1],
		],
		12,
	),
	O(
		'guest:Julian Mercer|+12125550148',
		12,
		1200,
		'delivery',
		'completed',
		'online',
		[[3, 1]],
		15,
	),
	O(
		'guest:James Okafor|+12125550151',
		6,
		1145,
		'pickup',
		'completed',
		'online',
		[
			[1, 1],
			[5, 1],
		],
		15,
	),
	O(
		'guest:Priya Raman|+12125550152',
		2,
		1190,
		'pickup',
		'completed',
		'counter',
		[
			[0, 1],
			[7, 1],
		],
		0,
	),
	O(
		'guest:Alex Turner|+12125550177',
		0,
		1090,
		'pickup',
		'payment_review',
		'review',
		[
			[8, 1],
			[6, 1],
		],
		15,
	),
	// Today
	O(
		'c3',
		0,
		735,
		'pickup',
		'completed',
		'online',
		[
			[2, 1],
			[7, 1],
		],
		10,
	),
	O(
		'c1',
		0,
		1000,
		'pickup',
		'preparing',
		'online',
		[
			[3, 1],
			[4, 1],
		],
		15,
	),
	O(
		'c5',
		0,
		1030,
		'delivery',
		'ready',
		'online',
		[
			[1, 2],
			[5, 1],
		],
		18,
	),
	O(
		'c2',
		0,
		1060,
		'pickup',
		'accepted',
		'counter',
		[
			[0, 1],
			[7, 1],
		],
		0,
	),
]

// Reservation history: 40 past reservations over the last 60 days.
// Guest index 1-10 (`gst_acme_demo_<n>`); F finished, N no_show, C cancelled,
// L late cancel (cancelled inside the free-cancel window).
const HISTORY_GUESTS = [
	1, 2, 1, 4, 3, 6, 2, 1, 5, 7, 4, 2, 8, 1, 6, 4, 7, 3, 2, 9, 1, 4, 10, 2, 6, 1,
	4, 5, 7, 2, 1, 8, 4, 3, 2, 1, 6, 4, 9, 2,
]
const HISTORY_OVERRIDES: Record<number, 'N' | 'C' | 'L'> = {
	9: 'N',
	16: 'N',
	19: 'N',
	22: 'N',
	31: 'N',
	12: 'C',
	17: 'C',
	38: 'C',
	11: 'L',
	25: 'L',
	35: 'L',
}
const HISTORY_PARTY = [2, 2, 2, 3, 4, 4, 5, 6, 2, 4]
const HISTORY_CHANNELS = [
	'online',
	'phone',
	'host',
	'online',
	'native',
	'online',
] as const

type Upcoming = {
	n: number
	guest: number
	dayOffset: number
	minute: number
	party: number
	status: string
	channel: string
	tableSuffix?: string
	dietary?: string
	requests?: string
	occasion?: 'birthday' | 'anniversary'
	deposit?: boolean
	large?: boolean
}

const UPCOMING: Upcoming[] = [
	{
		n: 1,
		guest: 2,
		dayOffset: 0,
		minute: 1110,
		party: 2,
		status: 'confirmed',
		channel: 'phone',
		tableSuffix: 'm1',
		requests: 'Corner table by the window if possible',
	},
	{
		n: 2,
		guest: 1,
		dayOffset: 1,
		minute: 1140,
		party: 4,
		status: 'booked',
		channel: 'online',
		tableSuffix: 'm3',
		dietary: 'Severe peanut allergy',
	},
	{
		n: 3,
		guest: 5,
		dayOffset: 1,
		minute: 1200,
		party: 2,
		status: 'booked',
		channel: 'online',
		tableSuffix: 'm2',
	},
	{
		n: 4,
		guest: 3,
		dayOffset: 2,
		minute: 1170,
		party: 3,
		status: 'confirmed',
		channel: 'native',
		tableSuffix: 'm4',
		dietary: 'Shellfish allergy',
	},
	{
		n: 5,
		guest: 6,
		dayOffset: 3,
		minute: 1230,
		party: 5,
		status: 'booked',
		channel: 'online',
		tableSuffix: 'm5',
		occasion: 'birthday',
		requests: 'Birthday dessert with a candle',
	},
	{
		n: 6,
		guest: 4,
		dayOffset: 4,
		minute: 1200,
		party: 12,
		status: 'pending_approval',
		channel: 'online',
		large: true,
		requests: 'Family celebration, 12 guests',
	},
	{
		n: 7,
		guest: 8,
		dayOffset: 5,
		minute: 1140,
		party: 4,
		status: 'booked',
		channel: 'online',
		tableSuffix: 'p2',
		deposit: true,
	},
	{
		n: 8,
		guest: 4,
		dayOffset: 6,
		minute: 1110,
		party: 6,
		status: 'confirmed',
		channel: 'phone',
		tableSuffix: 'm6',
	},
]

// ---------------------------------------------------------------------------

async function main() {
	let preset
	try {
		preset = resolveDemoOrg({
			slug: process.argv.slice(2).find((arg) => !arg.startsWith('--')),
			nodeEnv: process.env.NODE_ENV,
		})
		assertWhitelistedOrgId(preset.id)
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error))
	}

	const orgId = preset.id
	const locId = preset.locationId
	const tz = preset.timeZone
	const prefix = 'acme_demo'

	await provisionTenantDb(orgId)
	const db = await getTenantDb(orgId)
	await refreshReservationsTriggers(db)

	const now = Date.now()
	const today = (() => {
		const p = localParts(now, tz)
		return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`
	})()
	const nowSec = Math.floor(now / 1000)

	// Preconditions: the reservations seed must have run for this org.
	const guestRows = await db
		.select({ id: rsvGuests.id })
		.from(rsvGuests)
		.where(
			inArray(
				rsvGuests.id,
				[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `gst_${prefix}_${n}`),
			),
		)
	if (guestRows.length !== 8) {
		fail(
			'Run `npm run seed:reservations -w tenant-api -- acme-demo` first: guests 1-8 are missing.',
		)
	}

	// ---- 1. Customers + subscriptions ------------------------------------
	const customerIds = new Map<string, string>()
	for (const c of CUSTOMERS) {
		const id = `cus_demo_${c.key.slice(1).padStart(2, '0')}`
		customerIds.set(c.key, id)
		const createdAt = new Date((nowSec - c.createdDaysAgo * 86400) * 1000)
		await db
			.insert(customers)
			.values({
				id: id,
				name: c.name,
				email: c.email,
				phone: c.phone,
				phoneVerified: c.verified,
				createdAt,
				updatedAt: createdAt,
			})
			.onConflictDoUpdate({
				target: customers.id,
				set: {
					name: c.name,
					email: c.email,
					phone: c.phone,
					phoneVerified: c.verified,
				},
			})
		const subs: Array<
			[
				'drops' | 'reservations',
				'email' | 'sms',
				'on' | 'off' | undefined,
				(typeof CUSTOMER_SUBSCRIPTION_SOURCES)[number],
			]
		> = [
			['reservations', 'email', c.reservationsEmail, 'reservation_booking'],
			['reservations', 'sms', c.reservationsSms, 'reservation_booking'],
			['drops', 'email', c.dropsEmail, 'menu'],
			['drops', 'sms', c.dropsSms, 'profile'],
		]
		for (const [topic, channel, state, source] of subs) {
			if (!state) continue
			const subscribedAt = new Date(
				(nowSec - Math.max(1, c.createdDaysAgo - 1) * 86400) * 1000,
			)
			const unsubscribedAt =
				state === 'off' ? new Date((nowSec - 10 * 86400) * 1000) : null
			await db
				.insert(customerSubscriptions)
				.values({
					id: `sub_demo_${c.key}_${topic}_${channel}`,
					customerId: id,
					topic,
					channel,
					source,
					subscribedAt,
					unsubscribedAt,
				})
				.onConflictDoUpdate({
					target: customerSubscriptions.id,
					set: { unsubscribedAt, subscribedAt },
				})
		}
	}

	// ---- 2. Restaurant orders --------------------------------------------
	let guestOrders = 0
	const usedNumbers = new Set<string>()
	for (const [index, spec] of ORDERS.entries()) {
		const id = `ord_demo_${String(index + 1).padStart(3, '0')}`
		const customer = CUSTOMERS.find((c) => c.key === spec.who)
		const guest = spec.who.startsWith('guest:')
			? spec.who.slice(6).split('|')
			: null
		const contactName = customer?.name ?? guest?.[0] ?? ''
		const contactPhone = customer?.phone ?? guest?.[1] ?? ''
		const contactEmail =
			customer?.email ??
			`${contactName.toLowerCase().replace(/[^a-z]+/g, '.')}@example.com`
		if (guest) guestOrders += 1

		const lines: PricedOrderLine[] = spec.items.map(([menuIdx, quantity]) => {
			const item = MENU[menuIdx]!
			const total = item.cents * quantity
			return {
				itemId: item.id,
				itemName: item.name,
				variantId: null,
				quantity,
				unitPriceCents: item.cents,
				taxableUnitCents: item.cents,
				totalCents: total,
				taxableCents: total,
				instructions: null,
				options: [],
			}
		})
		const subtotal = lines.reduce((s, l) => s + l.totalCents, 0)
		const tax = Math.round(subtotal * TAX_RATE)
		const delivery = spec.fulfillment === 'delivery' ? DELIVERY_FEE_CENTS : 0
		const tip = Math.round((subtotal * spec.tip) / 100)
		const total = subtotal + tax + delivery + tip

		const day = addDays(today, -spec.daysAgo)
		let createdMs = businessDayStartMs(day, tz, spec.minute)
		if (spec.daysAgo === 0)
			createdMs = Math.min(
				createdMs,
				now - (ORDERS.length - index) * 4 * 60_000,
			)
		const status = oneOf(RESTAURANT_ORDER_STATUS_VALUES, spec.status)
		const paymentStatus = oneOf(
			RESTAURANT_PAYMENT_STATUS_VALUES,
			spec.pay === 'review'
				? 'review'
				: spec.pay === 'online'
					? 'paid'
					: status === 'completed'
						? 'paid'
						: 'unpaid',
		)
		const paid = paymentStatus === 'paid'
		const created = new Date(createdMs)
		const dayKey = created.toISOString().slice(0, 10).replaceAll('-', '')
		let number = `${dayKey}-${String(9000 + index + 1)}`
		while (usedNumbers.has(number)) number += 'x'
		usedNumbers.add(number)
		const readyMs = createdMs + 25 * 60_000
		const row = {
			id,
			orgId,
			customerId: customer ? customerIds.get(customer.key)! : null,
			number,
			locale: 'en',
			status,
			paymentMethod:
				spec.pay === 'counter' ? ('handoff' as const) : ('online' as const),
			paymentStatus,
			paymentProcessor: spec.pay === 'counter' ? null : ('checkout' as const),
			fulfillment: spec.fulfillment,
			locationId: locId,
			locationName: preset.locationName,
			pickupDate: spec.fulfillment === 'pickup' ? day : null,
			pickupTime:
				spec.fulfillment === 'pickup'
					? `${String(Math.floor((spec.minute + 25) / 60)).padStart(2, '0')}:${String((spec.minute + 25) % 60).padStart(2, '0')}`
					: null,
			pickupTimezone: spec.fulfillment === 'pickup' ? tz : null,
			contactName,
			contactPhone,
			contactEmail,
			deliveryAddress:
				spec.fulfillment === 'delivery'
					? `${100 + index} Example Street`
					: null,
			deliveryCity: spec.fulfillment === 'delivery' ? 'New York' : null,
			deliveryUnit:
				spec.fulfillment === 'delivery' ? `Apt ${index + 2}B` : null,
			deliveryPostalCode: spec.fulfillment === 'delivery' ? '10012' : null,
			deliveryNotes: null,
			currency: preset.currency,
			subtotalCents: subtotal,
			taxCents: tax,
			deliveryFeeCents: delivery,
			tipCents: tip,
			tipPercent: spec.tip,
			totalCents: total,
			lines,
			idempotencyKey: `seed-demo-people:${id}`,
			requestHash: sha(`seed-demo-request:${id}`),
			receiptTokenHash: sha(`seed-demo-receipt:${id}`),
			paidAt: paid ? new Date(createdMs + 90_000) : null,
			completedAt:
				status === 'completed' ? new Date(readyMs + 10 * 60_000) : null,
			cancelledAt:
				status === 'cancelled' ? new Date(createdMs + 8 * 60_000) : null,
			createdAt: created,
			updatedAt: new Date(Math.min(now, readyMs)),
		}
		const { id: ignoredId, idempotencyKey: ignoredKey, ...updatable } = row
		void ignoredId
		void ignoredKey
		await db
			.insert(restaurantOrders)
			.values(row)
			.onConflictDoUpdate({ target: restaurantOrders.id, set: updatable })
	}

	// ---- 3. Guests used by the history, tags, notes ----------------------
	const extraGuests = [
		{
			n: 9,
			firstName: 'Chloe',
			lastName: 'Bennett',
			phone: '+12125550157',
			email: 'chloe.bennett@example.com',
		},
		{
			n: 10,
			firstName: 'Victor',
			lastName: 'Reyes',
			phone: '+12125550160',
			email: 'victor.reyes@example.com',
		},
	]
	for (const g of extraGuests) {
		await db
			.insert(rsvGuests)
			.values({
				id: `gst_${prefix}_${g.n}`,
				firstName: g.firstName,
				lastName: g.lastName,
				phoneE164: g.phone,
				emailNorm: g.email,
				locale: 'en',
				createdAt: now - 70 * 86_400_000,
				updatedAt: now,
			})
			.onConflictDoNothing()
	}
	const guestId = (n: number) => `gst_${prefix}_${n}`

	// ---- 4. Reservation history ------------------------------------------
	const allTables = (
		await db
			.select({ id: rsvTables.id, max: rsvTables.maxCovers })
			.from(rsvTables)
			.where(eq(rsvTables.areaId, `area_${prefix}_main`))
	).map((t) => ({ id: t.id, max: t.max }))
	const rand = mulberry32(20261019)
	const historyIds: string[] = []
	for (let i = 0; i < HISTORY_GUESTS.length; i++) {
		const seq = i + 1
		const id = `rsv_demo_h${String(seq).padStart(2, '0')}`
		historyIds.push(id)
		const code = HISTORY_OVERRIDES[i] ?? 'F'
		const daysAgo = 1 + Math.floor(((i * 37 + 11) % 60) * 0.98)
		const date = addDays(today, -daysAgo)
		const dow = dayOfWeek(date)
		const isWeekend = dow === 0 || dow === 6
		const useBrunch = isWeekend && rand() < 0.5
		const useLunch = !isWeekend && rand() < 0.35
		const serviceId = useBrunch
			? `svc_${prefix}_brunch`
			: useLunch
				? `svc_${prefix}_lunch`
				: `svc_${prefix}_dinner`
		const slot = useBrunch
			? 600 + 15 * Math.floor(rand() * 18)
			: useLunch
				? 720 + 15 * Math.floor(rand() * 10)
				: 1050 + 15 * Math.floor(rand() * 20)
		const party = HISTORY_PARTY[(i * 3 + 1) % HISTORY_PARTY.length]!
		const startAt = businessDayStartMs(date, tz, slot)
		const turn = 55 + Math.floor(rand() * 60)
		const durationMin = party <= 2 ? 75 : party <= 4 ? 90 : 105
		const endAt = startAt + durationMin * 60_000
		const channel = oneOf(
			RSV_RESERVATION_CHANNEL_VALUES,
			HISTORY_CHANNELS[i % HISTORY_CHANNELS.length]!,
		)
		const arrivedAt = startAt + Math.floor(rand() * 8 - 3) * 60_000
		const seatedAt =
			Math.max(arrivedAt, startAt) + Math.floor(rand() * 9) * 60_000
		const finishedAt = seatedAt + turn * 60_000
		const status = oneOf(
			RSV_RESERVATION_STATUS_VALUES,
			code === 'F' ? 'finished' : code === 'N' ? 'no_show' : 'cancelled',
		)
		const cancelledAt =
			code === 'C'
				? startAt - (36 + Math.floor(rand() * 48)) * 3_600_000
				: code === 'L'
					? startAt - (20 + Math.floor(rand() * 90)) * 60_000
					: null
		const values = {
			id,
			locationId: locId,
			guestId: guestId(HISTORY_GUESTS[i]!),
			confirmationCode: `DH${String(seq).padStart(4, '0')}`,
			businessDate: date,
			localStartMin: slot,
			timeZone: tz,
			startAt,
			endAt,
			durationMin,
			serviceId,
			partySize: party,
			arrivedCovers: code === 'F' ? party : null,
			seatedCovers: code === 'F' ? party : null,
			coversActual: code === 'F' ? party : null,
			status,
			channel,
			guestLocale: 'en',
			createdByKind: oneOf(
				RSV_ACTOR_KIND_VALUES,
				channel === 'online' || channel === 'native' ? 'guest' : 'operator',
			),
			createdById:
				channel === 'online' || channel === 'native'
					? null
					: 'seed-demo-people',
			arrivedAt: code === 'F' ? arrivedAt : null,
			seatedAt: code === 'F' ? seatedAt : null,
			finishedAt: code === 'F' ? finishedAt : null,
			noShowAt: code === 'N' ? startAt + 20 * 60_000 : null,
			cancelledAt,
			cancelledBy: cancelledAt ? oneOf(RSV_CANCELLED_BY_VALUES, 'guest') : null,
			cancelReason: cancelledAt ? 'Plans changed' : null,
			lateCancel: code === 'L',
			createdAt: startAt - (2 + (i % 9)) * 86_400_000,
			updatedAt: finishedAt,
		}
		const { id: ignoredId, ...updatable } = values
		void ignoredId
		// customerId is deliberately not in the update set: links come only from
		// linkGuestsToCustomers.
		await db
			.insert(rsvReservations)
			.values(values)
			.onConflictDoUpdate({ target: rsvReservations.id, set: updatable })

		const evtId = `evt_${id}_init`
		await db
			.insert(rsvReservationEvents)
			.values({
				id: evtId,
				reservationId: id,
				at: startAt - 86_400_000,
				actorKind: oneOf(RSV_ACTOR_KIND_VALUES, 'system'),
				actorId: 'seed-demo-people',
				type: 'seeded',
				fromStatus: null,
				toStatus: status,
			})
			.onConflictDoNothing()

		if (code === 'F') {
			const fit = allTables
				.filter((t) => t.max >= party)
				.sort((a, b) => a.max - b.max || a.id.localeCompare(b.id))
			const table = fit[i % Math.min(fit.length, 3)]
			if (table) {
				await db
					.insert(rsvTableOccupancies)
					.values({
						id: `occ_${id}`,
						locationId: locId,
						tableId: table.id,
						kind: 'reservation',
						reservationId: id,
						startAt: seatedAt,
						endAt: finishedAt,
						active: false,
						createdAt: startAt - 86_400_000,
					})
					.onConflictDoNothing()
			}
		}
	}

	// ---- 5. Upcoming reservations ----------------------------------------
	const [policy] = await db
		.select()
		.from(rsvPolicies)
		.where(
			and(
				eq(rsvPolicies.locationId, locId),
				eq(rsvPolicies.name, 'Dinner deposit'),
			),
		)
		.limit(1)
	const touchedDates = new Set<string>()
	for (const u of UPCOMING) {
		const id = `rsv_demo_u${String(u.n).padStart(2, '0')}`
		const date = addDays(today, u.dayOffset)
		touchedDates.add(date)
		const startAt = businessDayStartMs(date, tz, u.minute)
		const durationMin = u.party <= 2 ? 75 : u.party <= 4 ? 90 : 105
		const endAt = startAt + durationMin * 60_000
		const status = oneOf(RSV_RESERVATION_STATUS_VALUES, u.status)
		let paymentStatus: (typeof RSV_PAYMENT_STATUS_VALUES)[number] = 'none'
		let policySnapshot: Record<string, unknown> | null = null
		let policyAcceptedAt: number | null = null
		if (u.deposit) {
			if (!policy) {
				console.warn(
					'Policy "Dinner deposit" not found; skipping the deposit booking.',
				)
				continue
			}
			paymentStatus = oneOf(RSV_PAYMENT_STATUS_VALUES, 'paid')
			policySnapshot = snapshotPolicy(policy as never, u.party) as never
			policyAcceptedAt = now - 86_400_000
		}
		const values = {
			id,
			locationId: locId,
			guestId: guestId(u.guest),
			confirmationCode: `DU${String(u.n).padStart(4, '0')}`,
			businessDate: date,
			localStartMin: u.minute,
			timeZone: tz,
			startAt,
			endAt,
			durationMin,
			serviceId: `svc_${prefix}_dinner`,
			partySize: u.party,
			status,
			channel: oneOf(RSV_RESERVATION_CHANNEL_VALUES, u.channel),
			guestLocale: 'en',
			occasionTagId: u.occasion ? `tag_${prefix}_${u.occasion}` : null,
			dietaryNotes: u.dietary ?? null,
			guestRequests: u.requests ?? null,
			staffNotes: u.large
				? 'Large party: needs manager approval and a deposit conversation'
				: null,
			paymentStatus,
			policySnapshot,
			policyAcceptedAt,
			requestDeadlineAt:
				status === 'pending_approval' ? now + 24 * 3_600_000 : null,
			createdByKind: oneOf(
				RSV_ACTOR_KIND_VALUES,
				u.channel === 'online' || u.channel === 'native' ? 'guest' : 'operator',
			),
			createdById:
				u.channel === 'online' || u.channel === 'native'
					? null
					: 'seed-demo-people',
			createdAt: now - 86_400_000,
			updatedAt: now,
		}
		const { id: ignoredId, ...updatable } = values
		void ignoredId
		await db
			.insert(rsvReservations)
			.values(values)
			.onConflictDoUpdate({ target: rsvReservations.id, set: updatable })
		await db
			.insert(rsvReservationEvents)
			.values({
				id: `evt_${id}_init`,
				reservationId: id,
				at: now - 86_400_000,
				actorKind: oneOf(RSV_ACTOR_KIND_VALUES, 'system'),
				actorId: 'seed-demo-people',
				type: 'seeded',
				fromStatus: null,
				toStatus: status,
			})
			.onConflictDoNothing()
		const tagIds = [
			...(u.occasion ? [`tag_${prefix}_${u.occasion}`] : []),
			...(u.dietary ? [`tag_${prefix}_allergy`] : []),
		]
		for (const tagId of tagIds) {
			await db
				.insert(rsvReservationTags)
				.values({ reservationId: id, tagId })
				.onConflictDoNothing()
		}
		if (u.tableSuffix) {
			const occId = `occ_${id}`
			const [existingOcc] = await db
				.select({ id: rsvTableOccupancies.id })
				.from(rsvTableOccupancies)
				.where(eq(rsvTableOccupancies.id, occId))
				.limit(1)
			// The overlap trigger fires before ON CONFLICT, so check first.
			if (existingOcc) {
				await db
					.update(rsvTableOccupancies)
					.set({ startAt, endAt: endAt + 15 * 60_000, active: true })
					.where(eq(rsvTableOccupancies.id, occId))
			} else {
				await db.insert(rsvTableOccupancies).values({
					id: occId,
					locationId: locId,
					tableId: `tbl_${prefix}_${u.tableSuffix}`,
					kind: 'reservation',
					reservationId: id,
					startAt,
					endAt: endAt + 15 * 60_000,
					active: true,
					createdAt: now,
				})
			}
		}
		if (u.deposit && policy) {
			const snapshot = policySnapshot as {
				totalAmountMinor: number
				currency: string
			}
			await db
				.insert(rsvPayments)
				.values({
					id: `pay_demo_${id}`,
					locationId: locId,
					reservationId: id,
					provider: oneOf(RSV_PAYMENT_PROVIDER_VALUES, 'stripe'),
					kind: oneOf(RSV_PAYMENT_KIND_VALUES, 'deposit_charge'),
					purpose: 'deposit',
					amountMinor: snapshot.totalAmountMinor,
					currency: snapshot.currency,
					status: oneOf(RSV_PAYMENT_RECORD_STATUS_VALUES, 'succeeded'),
					attempt: 1,
					providerRef: `pi_demo_${id}`,
					cardBrand: 'visa',
					cardLast4: '4242',
					cardExpMonth: 12,
					cardExpYear: 2030,
					idempotencyKey: `rsv:${id}:deposit_charge:1`,
					createdAt: now - 86_400_000,
					updatedAt: now - 86_400_000,
				})
				.onConflictDoNothing()
		}
	}

	// ---- 6. Waitlist (today) ---------------------------------------------
	const waitlist = [
		{
			n: 1,
			guestN: 9,
			name: 'Chloe Bennett',
			phone: '+12125550157',
			party: 2,
			quoted: 15,
			channel: 'walk_in',
			status: 'waiting',
		},
		{
			n: 2,
			guestN: null,
			name: 'Ryan Patel',
			phone: '+12125550181',
			party: 3,
			quoted: 25,
			channel: 'walk_in',
			status: 'notified',
		},
		{
			n: 3,
			guestN: null,
			name: 'Mei Tanaka',
			phone: '+12125550182',
			party: 5,
			quoted: 40,
			channel: 'remote',
			status: 'waiting',
		},
	]
	for (const [index, w] of waitlist.entries()) {
		const status = oneOf(RSV_WAITLIST_STATUS_VALUES, w.status)
		await db
			.insert(rsvWaitlistEntries)
			.values({
				id: `wl_demo_t${w.n}`,
				locationId: locId,
				areaPrefId: `area_${prefix}_main`,
				guestId: w.guestN ? guestId(w.guestN) : null,
				businessDate: today,
				displayName: w.name,
				phoneE164: w.phone,
				partySize: w.party,
				channel: oneOf(RSV_WAITLIST_CHANNEL_VALUES, w.channel),
				joinedAt: now - (30 - index * 8) * 60_000,
				quotedMin: w.quoted,
				status,
				notifiedAt: status === 'notified' ? now - 5 * 60_000 : null,
				responseDeadlineAt: status === 'notified' ? now + 5 * 60_000 : null,
				sortKey: 10 + w.n,
				locale: 'en',
				createdAt: now - 30 * 60_000,
			})
			.onConflictDoUpdate({
				target: rsvWaitlistEntries.id,
				set: { businessDate: today, status, sortKey: 10 + w.n },
			})
	}

	// ---- 7. Experience schedules (next week, Monday to Sunday) -----------
	const nextMonday = addDays(today, 7 - ((dayOfWeek(today) + 6) % 7))
	const schedules = [
		{ id: 'sched_demo_1', mask: 0b1100000, mins: [1080, 1230], cap: 12 }, // Fri, Sat
		{ id: 'sched_demo_2', mask: 0b0000001, mins: [1020], cap: 8 }, // Sun
	]
	for (const s of schedules) {
		await db
			.insert(rsvExperienceSchedules)
			.values({
				id: s.id,
				experienceId: `exp_${prefix}_chefs_tasting`,
				fromDate: nextMonday,
				toDate: addDays(nextMonday, 6),
				daysMask: s.mask,
				seatingMins: s.mins,
				turnMin: 120,
				coversCapPerSeating: s.cap,
				serviceId: `svc_${prefix}_dinner`,
			})
			.onConflictDoUpdate({
				target: rsvExperienceSchedules.id,
				set: {
					fromDate: nextMonday,
					toDate: addDays(nextMonday, 6),
					daysMask: s.mask,
					seatingMins: s.mins,
				},
			})
	}

	// ---- 8. Guest tags and notes -----------------------------------------
	await db
		.insert(rsvTags)
		.values({
			id: `tag_${prefix}_allergy_sensitive`,
			scope: 'guest',
			category: 'dietary',
			name: 'Allergy-sensitive',
			colorToken: 'red',
			sensitive: true,
			guestSelectable: false,
		})
		.onConflictDoNothing()
	const guestTags: Array<[number, string]> = [
		[2, 'vip'],
		[4, 'vip'],
		[1, 'regular'],
		[5, 'regular'],
		[6, 'regular'],
		[3, 'allergy_sensitive'],
	]
	for (const [n, tag] of guestTags) {
		await db
			.insert(rsvGuestTags)
			.values({ guestId: guestId(n), tagId: `tag_${prefix}_${tag}` })
			.onConflictDoNothing()
	}
	const notes: Array<[string, number, string, boolean]> = [
		[
			'n1',
			2,
			'Prefers the corner table by the window. Orders the Barolo.',
			true,
		],
		[
			'n2',
			1,
			'Hosts a monthly family dinner, usually 6 or more guests.',
			false,
		],
		[
			'n3',
			3,
			'Tree nut allergy: confirm with the kitchen at every visit.',
			true,
		],
		[
			'n4',
			4,
			'Long-time regular. Likes the chef counter on quiet nights.',
			false,
		],
		[
			'n5',
			7,
			'Two no-shows this season: ask for a deposit on large parties.',
			false,
		],
	]
	for (const [key, n, body, pinned] of notes) {
		await db
			.insert(rsvGuestNotes)
			.values({
				id: `gnote_demo_${key}`,
				guestId: guestId(n),
				body,
				pinned,
				authorId: 'seed-demo-people',
				createdAt: now - 14 * 86_400_000,
			})
			.onConflictDoUpdate({
				target: rsvGuestNotes.id,
				set: { body, pinned },
			})
	}

	// Day versions for every date touched (no-op when present).
	for (const date of new Set([today, ...touchedDates])) {
		await db
			.insert(rsvDayVersions)
			.values({
				locationId: locId,
				businessDate: date,
				version: 1,
				updatedAt: now,
			})
			.onConflictDoNothing()
	}

	// ---- 9. Guest counters from the real rows, then the real link --------
	const guestKeys = Array.from({ length: 10 }, (_, i) => guestId(i + 1))
	await db.run(sql`
		UPDATE rsv_guests SET
			visits = (SELECT COUNT(*) FROM rsv_reservations r WHERE r.guest_id = rsv_guests.id AND r.status = 'finished'),
			covers = (SELECT COALESCE(SUM(COALESCE(r.covers_actual, r.party_size)), 0) FROM rsv_reservations r WHERE r.guest_id = rsv_guests.id AND r.status = 'finished'),
			no_shows = (SELECT COUNT(*) FROM rsv_reservations r WHERE r.guest_id = rsv_guests.id AND r.status = 'no_show'),
			cancels = (SELECT COUNT(*) FROM rsv_reservations r WHERE r.guest_id = rsv_guests.id AND r.status = 'cancelled'),
			late_cancels = (SELECT COUNT(*) FROM rsv_reservations r WHERE r.guest_id = rsv_guests.id AND r.status = 'cancelled' AND r.late_cancel = 1),
			first_visit_at = (SELECT MIN(COALESCE(r.finished_at, r.seated_at, r.start_at)) FROM rsv_reservations r WHERE r.guest_id = rsv_guests.id AND r.status = 'finished'),
			last_visit_at = (SELECT MAX(COALESCE(r.finished_at, r.seated_at, r.start_at)) FROM rsv_reservations r WHERE r.guest_id = rsv_guests.id AND r.status = 'finished'),
			updated_at = ${now}
		WHERE id IN (${sql.join(
			guestKeys.map((k) => sql`${k}`),
			sql`, `,
		)})
	`)
	const link = await linkGuestsToCustomers(db, { orgId, now })

	const counts = async (table: string) =>
		(
			await db.all<{ n: number }>(sql.raw(`SELECT COUNT(*) AS n FROM ${table}`))
		)[0]!.n
	console.info(
		`Seeded demo people and orders for "${preset.slug}" (${orgId}): ` +
			`${CUSTOMERS.length} customers, ${ORDERS.length} orders (${guestOrders} guest checkout), ` +
			`${HISTORY_GUESTS.length} history + ${UPCOMING.length} upcoming reservations, ` +
			`${waitlist.length} waitlist entries, ${schedules.length} experience schedules; ` +
			`guest links: +${link.linked} new, ${link.alreadyLinked} already linked. ` +
			`Table totals: customers ${await counts('customers')}, orders ${await counts('restaurant_orders')}, ` +
			`reservations ${await counts('rsv_reservations')}.`,
	)
}

await main()
process.exit(0)
