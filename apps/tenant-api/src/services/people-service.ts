import {
	customers,
	customerSubscriptions,
	restaurantOrders,
	rsvGuests,
	shopOrders,
	type TenantDatabase,
} from '@repo/tenant-db'
import { and, count, desc, eq, isNull, max, sql, type SQL } from 'drizzle-orm'
import { badRequest, conflict, forbidden, notFound } from '../lib/http.ts'
import {
	FREQUENT_NO_SHOW_THRESHOLD,
	loadGuestTagsMap,
	type DbOrTx,
	type SerializedGuestTag,
} from './rsv-guest-service.ts'
import {
	getGuestProfile,
	mergeGuests,
	updateGuestProfile,
} from './rsv-guestbook-service.ts'
import {
	loadGuestMarketingConsent,
	type GuestMarketingConsent,
} from './rsv-marketing-consent.ts'
import { deriveSystemTagKeys, SYSTEM_GUEST_TAGS } from './rsv-guest-service.ts'

/**
 * One person for the operator: the "Customers" screen is the only people screen.
 *
 * Underneath there are still two tables in the same regional database: the
 * customer (sign-in, orders, consent) and the reservation guest (dining
 * history). A person is ONE row:
 *  - `c_<customerId>`: a customer row, with the live guest linked to it (the
 *    strict verified-phone link, `rsv_guests.customer_id`) as its dining facet;
 *  - `g_<guestId>`: a live guest with no linked customer ("Guest, no sign-in").
 * The unverified customer row a booking-form consent creates
 * (`marketing_customer_id`) is a consent shadow of its guest, not a person: it
 * is hidden from the list and its key resolves to the guest.
 *
 * What a caller may read is decided by the token claims (`PeopleAccess`), never
 * by the request: no claim, no facet.
 */

export type PeopleDiningAccess = 'none' | 'flags' | 'full'

export type PeopleAccess = {
	actorId: string
	/** Customer facet: contact, orders summary, consent. */
	customers: boolean
	/**
	 * Dining facet. `flags`: counters, next booking and non-sensitive tags only.
	 * `full`: adds allergy, sensitive tags and notes (the guest-read grant).
	 */
	dining: PeopleDiningAccess
	canUpdateCustomers: boolean
	canUpdateDining: boolean
	canDelete: boolean
}

export const PEOPLE_PAGE_SIZE = 50
export const PEOPLE_SORTS = ['recent', 'name', 'visits', 'last_visit'] as const
export type PeopleSort = (typeof PEOPLE_SORTS)[number]
export const PEOPLE_ACCOUNT_FILTERS = ['signed_in', 'guest_only'] as const
export type PeopleAccountFilter = (typeof PEOPLE_ACCOUNT_FILTERS)[number]
export const DEFAULT_LAPSED_DAYS = 90
const DAY_MS = 86_400_000

export type PersonStatus = 'signed_in' | 'guest_no_sign_in' | 'unverified'

export type PersonKey = { kind: 'c' | 'g'; id: string }

const PERSON_KEY_PATTERN = /^([cg])_([A-Za-z0-9_-]{1,128})$/

export function parsePersonKey(raw: string): PersonKey | null {
	const match = PERSON_KEY_PATTERN.exec(raw)
	if (!match) return null
	return { kind: match[1] as 'c' | 'g', id: match[2]! }
}

export function personKey(kind: 'c' | 'g', id: string): string {
	return `${kind}_${id}`
}

export function hasDiningFacet(access: PeopleAccess): boolean {
	return access.dining !== 'none'
}

export function requireCustomersFacet(access: PeopleAccess): void {
	if (!access.customers) {
		throw forbidden('insufficient_permissions', 'Customers access is required')
	}
}

export function requireDiningFacet(
	access: PeopleAccess,
	level: 'flags' | 'full' = 'flags',
): void {
	const ok =
		level === 'flags' ? access.dining !== 'none' : access.dining === 'full'
	if (!ok) {
		throw forbidden(
			'insufficient_permissions',
			'Reservation guest access is required',
		)
	}
}

export function requireDiningWrite(access: PeopleAccess): void {
	requireDiningFacet(access, 'full')
	if (!access.canUpdateDining) {
		throw forbidden(
			'insufficient_permissions',
			'Updating reservation guests is not allowed',
		)
	}
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

type Cursor = { v: string | number; id: string }

function encodeCursor(cursor: Cursor): string {
	return Buffer.from(JSON.stringify(cursor)).toString('base64url')
}

function decodeCursor(raw: string | undefined): Cursor | null {
	if (!raw) return null
	try {
		const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
		if (
			parsed &&
			typeof parsed.id === 'string' &&
			(typeof parsed.v === 'string' || typeof parsed.v === 'number')
		) {
			return { v: parsed.v, id: parsed.id }
		}
	} catch {
		// fall through
	}
	throw badRequest('invalid_cursor', 'The page cursor is not valid')
}

function escapeLike(value: string): string {
	return value.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

export type PeopleListInput = {
	q?: string
	vip?: boolean
	allergy?: boolean
	lapsed?: boolean
	lapsedDays?: number
	upcoming?: boolean
	noShowRisk?: boolean
	/** Only people with a dining facet (merge candidates). */
	hasDining?: boolean
	account?: PeopleAccountFilter
	includeWalkIns?: boolean
	sort?: PeopleSort
	cursor?: string
	limit?: number
	now?: number
}

const SORT_SPECS: Record<
	PeopleSort,
	{ expr: SQL; dir: 'asc' | 'desc'; text: boolean }
> = {
	recent: {
		expr: sql`MAX(COALESCE(p.last_visit_at, 0), COALESCE(p.last_order_at, 0), p.created_at)`,
		dir: 'desc',
		text: false,
	},
	name: { expr: sql`lower(p.name)`, dir: 'asc', text: true },
	visits: { expr: sql`COALESCE(p.visits, 0)`, dir: 'desc', text: false },
	last_visit: {
		expr: sql`COALESCE(p.last_visit_at, 0)`,
		dir: 'desc',
		text: false,
	},
}

const GUEST_LIVE = (alias: string) =>
	sql.raw(`${alias}.merged_into_id IS NULL AND ${alias}.erased_at IS NULL`)

const VIP_EXPR = (alias: string) =>
	sql.raw(
		`CASE WHEN EXISTS (SELECT 1 FROM rsv_guest_tags gt JOIN rsv_tags t ON t.id = gt.tag_id WHERE gt.guest_id = ${alias}.id AND t.sensitive = 0 AND (t.category = 'vip' OR lower(t.name) LIKE '%vip%')) THEN 1 ELSE 0 END`,
	)

const ALLERGY_EXPR = (alias: string) =>
	sql.raw(
		`CASE WHEN (${alias}.allergy_notes IS NOT NULL AND trim(${alias}.allergy_notes) <> '') OR EXISTS (SELECT 1 FROM rsv_guest_tags gt JOIN rsv_tags t ON t.id = gt.tag_id WHERE gt.guest_id = ${alias}.id AND t.category = 'dietary') THEN 1 ELSE 0 END`,
	)

const WALK_IN_EXPR = (alias: string) =>
	sql.raw(
		`CASE WHEN (${alias}.phone_e164 IS NULL OR ${alias}.phone_e164 = '') AND (${alias}.email_norm IS NULL OR ${alias}.email_norm = '') THEN 1 ELSE 0 END`,
	)

/** The source CTEs: next booking per guest, orders per customer, and the people union. */
function peopleCte(access: PeopleAccess, now: number): SQL {
	const dining = hasDiningFacet(access)
	const halves: SQL[] = []
	if (access.customers) {
		const guestJoin = dining
			? sql`LEFT JOIN rsv_guests g ON g.customer_id = c.id AND ${GUEST_LIVE('g')}
				LEFT JOIN nb ON nb.guest_id = g.id`
			: sql``
		const guestCols = dining
			? sql`g.id AS guest_id, g.visits AS visits, g.covers AS covers, g.no_shows AS no_shows,
				g.last_visit_at AS last_visit_at, nb.next_at AS next_booking_at,
				CASE WHEN g.id IS NULL THEN NULL ELSE ${VIP_EXPR('g')} END AS is_vip,
				CASE WHEN g.id IS NULL THEN NULL ELSE ${ALLERGY_EXPR('g')} END AS has_allergy,
				trim(COALESCE(g.first_name, '') || ' ' || COALESCE(g.last_name, '')) AS guest_name,
				g.phone_e164 AS guest_phone, g.email_norm AS guest_email`
			: sql`NULL AS guest_id, NULL AS visits, NULL AS covers, NULL AS no_shows,
				NULL AS last_visit_at, NULL AS next_booking_at, NULL AS is_vip, NULL AS has_allergy,
				NULL AS guest_name, NULL AS guest_phone, NULL AS guest_email`
		// A consent shadow (unverified customer created from a booking form) is
		// the same person as its guest, which has its own row.
		const shadow = dining
			? sql`AND NOT (COALESCE(c.phone_verified, 0) = 0 AND EXISTS (
					SELECT 1 FROM rsv_guests s WHERE s.marketing_customer_id = c.id AND ${GUEST_LIVE('s')}))`
			: sql``
		halves.push(sql`
			SELECT 'c_' || c.id AS key, 'c' AS kind, c.id AS customer_id,
				c.name AS name, c.phone AS phone, c.email AS email,
				CASE WHEN COALESCE(c.phone_verified, 0) = 1 THEN 1 ELSE 0 END AS signed_in,
				COALESCE(c.created_at, 0) * 1000 AS created_at,
				${guestCols},
				ord.n AS order_count, ord.last_at AS last_order_at,
				0 AS walk_in
			FROM customers c
			${guestJoin}
			LEFT JOIN ord ON ord.customer_id = c.id
			WHERE 1 = 1 ${shadow}`)
	}
	if (dining) {
		halves.push(sql`
			SELECT 'g_' || g.id AS key, 'g' AS kind, NULL AS customer_id,
				trim(g.first_name || ' ' || g.last_name) AS name,
				g.phone_e164 AS phone, g.email_norm AS email,
				CASE WHEN g.customer_id IS NOT NULL THEN 1 ELSE 0 END AS signed_in,
				g.created_at AS created_at,
				g.id AS guest_id, g.visits AS visits, g.covers AS covers, g.no_shows AS no_shows,
				g.last_visit_at AS last_visit_at, nb.next_at AS next_booking_at,
				${VIP_EXPR('g')} AS is_vip, ${ALLERGY_EXPR('g')} AS has_allergy,
				trim(g.first_name || ' ' || g.last_name) AS guest_name,
				g.phone_e164 AS guest_phone, g.email_norm AS guest_email,
				NULL AS order_count, NULL AS last_order_at,
				${WALK_IN_EXPR('g')} AS walk_in
			FROM rsv_guests g
			LEFT JOIN nb ON nb.guest_id = g.id
			WHERE ${GUEST_LIVE('g')} ${access.customers ? sql`AND g.customer_id IS NULL` : sql``}`)
	}
	return sql`
		WITH nb AS (
			SELECT guest_id, MIN(start_at) AS next_at FROM rsv_reservations
			WHERE start_at >= ${now} AND status IN ('booked', 'confirmed', 'pending_payment')
			GROUP BY guest_id
		), ord AS (
			SELECT customer_id, COUNT(*) AS n, MAX(ts) AS last_at FROM (
				SELECT customer_id, created_at * 1000 AS ts FROM restaurant_orders WHERE customer_id IS NOT NULL
				UNION ALL
				SELECT customer_id, created_at * 1000 AS ts FROM shop_orders WHERE customer_id IS NOT NULL
			) GROUP BY customer_id
		), p AS (
			${sql.join(halves, sql` UNION ALL `)}
		)`
}

function listFilters(
	access: PeopleAccess,
	input: PeopleListInput,
	now: number,
): SQL[] {
	const filters: SQL[] = []
	const dining = hasDiningFacet(access)
	if (!input.includeWalkIns) filters.push(sql`p.walk_in = 0`)

	const q = input.q?.trim().toLowerCase()
	if (q) {
		const like = `%${escapeLike(q)}%`
		const clauses: SQL[] = [
			sql`lower(p.name) LIKE ${like} ESCAPE '\\'`,
			sql`lower(COALESCE(p.guest_name, '')) LIKE ${like} ESCAPE '\\'`,
			sql`lower(COALESCE(p.email, '')) LIKE ${like} ESCAPE '\\'`,
			sql`lower(COALESCE(p.guest_email, '')) LIKE ${like} ESCAPE '\\'`,
		]
		const digits = q.replace(/\D/g, '')
		if (digits.length >= 3) {
			clauses.push(sql`COALESCE(p.phone, '') LIKE ${`%${digits}%`}`)
			clauses.push(sql`COALESCE(p.guest_phone, '') LIKE ${`%${digits}%`}`)
		}
		filters.push(sql`(${sql.join(clauses, sql` OR `)})`)
	}

	const needsDining =
		input.vip ||
		input.allergy ||
		input.lapsed ||
		input.upcoming ||
		input.noShowRisk ||
		input.hasDining
	if (needsDining && !dining) {
		throw forbidden(
			'insufficient_permissions',
			'Reservation guest access is required for this filter',
		)
	}
	if (input.allergy && access.dining !== 'full') {
		throw forbidden(
			'insufficient_permissions',
			'The allergy filter needs the reservation guest read grant',
		)
	}
	if (input.vip) filters.push(sql`p.is_vip = 1`)
	if (input.allergy) filters.push(sql`p.has_allergy = 1`)
	if (input.lapsed) {
		const days = input.lapsedDays ?? DEFAULT_LAPSED_DAYS
		filters.push(
			sql`p.last_visit_at IS NOT NULL AND p.last_visit_at < ${now - days * DAY_MS}`,
		)
	}
	if (input.upcoming) filters.push(sql`p.next_booking_at IS NOT NULL`)
	if (input.noShowRisk) {
		filters.push(sql`p.no_shows >= ${FREQUENT_NO_SHOW_THRESHOLD}`)
	}
	if (input.hasDining) filters.push(sql`p.guest_id IS NOT NULL`)
	if (input.account === 'signed_in') filters.push(sql`p.signed_in = 1`)
	if (input.account === 'guest_only') filters.push(sql`p.kind = 'g'`)
	return filters
}

type RawPerson = {
	key: string
	kind: 'c' | 'g'
	customer_id: string | null
	guest_id: string | null
	name: string
	phone: string | null
	email: string | null
	signed_in: number
	created_at: number
	visits: number | null
	covers: number | null
	no_shows: number | null
	last_visit_at: number | null
	next_booking_at: number | null
	order_count: number | null
	last_order_at: number | null
	is_vip: number | null
	has_allergy: number | null
	walk_in: number
	sort_key: string | number
}

export type PersonTag = {
	id: string
	name: string
	category: string
	colorToken: string
	sensitive: boolean
	system: boolean
}

export type PersonRow = {
	key: string
	kind: 'customer' | 'guest'
	name: string
	phone: string | null
	email: string | null
	status: PersonStatus
	signedIn: boolean
	/** A guest facet exists (reservation history). */
	hasDining: boolean
	/** The dining facet is linked to this customer by the verified phone. */
	customerLinked: boolean
	walkIn: boolean
	dining: {
		visits: number
		covers: number
		noShows: number
		lastVisitAt: number | null
		nextBookingAt: number | null
	} | null
	/** Orders placed while signed in; separate from visits, never summed. */
	orders: { count: number; lastOrderAt: number | null } | null
	flags: {
		vip: boolean
		/** `null` when the caller lacks the guest read grant. */
		allergy: boolean | null
		noShowRisk: boolean
	}
	tags: PersonTag[]
	createdAt: number
	lastActivityAt: number
}

export type PeoplePage = {
	people: PersonRow[]
	nextCursor: string | null
	total: number
	meta: {
		/** The organization has orders by signed-in customers (show Orders). */
		hasOrders: boolean
		/** Live guests without phone and email, hidden unless `includeWalkIns`. */
		walkInCount: number | null
	}
}

function toPersonTag(tag: SerializedGuestTag): PersonTag {
	return {
		id: tag.id,
		name: tag.name,
		category: tag.category,
		colorToken: tag.colorToken,
		sensitive: tag.sensitive,
		system: tag.category === 'system' || tag.systemKey != null,
	}
}

function statusOf(raw: { kind: 'c' | 'g'; signedIn: boolean }): PersonStatus {
	if (raw.signedIn) return 'signed_in'
	return raw.kind === 'c' ? 'unverified' : 'guest_no_sign_in'
}

export function derivedPersonTags(
	visits: number,
	noShows: number,
): PersonTag[] {
	return deriveSystemTagKeys({ visits, noShows, erasedAt: null }).map(
		(key) => ({
			id: SYSTEM_GUEST_TAGS[key].id,
			name: SYSTEM_GUEST_TAGS[key].name,
			category: 'system',
			colorToken: SYSTEM_GUEST_TAGS[key].colorToken,
			sensitive: false,
			system: true,
		}),
	)
}

export async function listPeople(
	db: TenantDatabase,
	access: PeopleAccess,
	input: PeopleListInput,
): Promise<PeoplePage> {
	if (!access.customers && access.dining === 'none') {
		throw forbidden('insufficient_permissions', 'No people access')
	}
	const now = input.now ?? Date.now()
	const limit = Math.min(
		Math.max(input.limit ?? PEOPLE_PAGE_SIZE, 1),
		PEOPLE_PAGE_SIZE,
	)
	const spec = SORT_SPECS[input.sort ?? 'recent']
	const filters = listFilters(access, input, now)
	const where =
		filters.length > 0 ? sql`WHERE ${sql.join(filters, sql` AND `)}` : sql``
	const cte = peopleCte(access, now)

	const totalRows = await db.all<{ n: number }>(
		sql`${cte} SELECT COUNT(*) AS n FROM p ${where}`,
	)
	const total = Number(totalRows[0]?.n ?? 0)

	const cursor = decodeCursor(input.cursor)
	const cursorFilter = cursor
		? sql`WHERE (s.sort_key ${spec.dir === 'asc' ? sql`>` : sql`<`} ${cursor.v} OR (s.sort_key = ${cursor.v} AND s.key > ${cursor.id}))`
		: sql``
	const rows = await db.all<RawPerson>(sql`${cte}
		SELECT * FROM (
			SELECT p.*, ${spec.expr} AS sort_key FROM p ${where}
		) s ${cursorFilter}
		ORDER BY s.sort_key ${spec.dir === 'asc' ? sql`ASC` : sql`DESC`}, s.key ASC
		LIMIT ${limit + 1}`)

	const page = rows.slice(0, limit)
	const last = page.at(-1)
	const nextCursor =
		rows.length > limit && last
			? encodeCursor({
					v: spec.text ? String(last.sort_key) : Number(last.sort_key),
					id: last.key,
				})
			: null

	const guestIds = page
		.map((r) => r.guest_id)
		.filter((id): id is string => typeof id === 'string')
	const tagsMap = await loadGuestTagsMap(db, guestIds, {
		canReadSensitive: access.dining === 'full',
	})

	const people: PersonRow[] = page.map((r) => {
		const signedIn = Number(r.signed_in) === 1
		const hasDining = r.guest_id !== null && r.guest_id !== undefined
		const visits = Number(r.visits ?? 0)
		const noShows = Number(r.no_shows ?? 0)
		const lastVisitAt =
			r.last_visit_at === null ? null : Number(r.last_visit_at)
		const lastOrderAt =
			r.last_order_at === null ? null : Number(r.last_order_at)
		const stored = (hasDining ? (tagsMap.get(r.guest_id!) ?? []) : []).filter(
			(t) => t.category !== 'system',
		)
		return {
			key: r.key,
			kind: r.kind === 'c' ? 'customer' : 'guest',
			name: r.name,
			phone: r.phone,
			email: r.email,
			status: statusOf({ kind: r.kind, signedIn }),
			signedIn,
			hasDining,
			customerLinked: r.kind === 'c' && hasDining,
			walkIn: Number(r.walk_in) === 1,
			dining: hasDining
				? {
						visits,
						covers: Number(r.covers ?? 0),
						noShows,
						lastVisitAt,
						nextBookingAt:
							r.next_booking_at === null ? null : Number(r.next_booking_at),
					}
				: null,
			orders:
				access.customers && r.kind === 'c'
					? { count: Number(r.order_count ?? 0), lastOrderAt }
					: null,
			flags: {
				vip: Number(r.is_vip ?? 0) === 1,
				allergy:
					access.dining === 'full' && hasDining
						? Number(r.has_allergy ?? 0) === 1
						: null,
				noShowRisk: hasDining && noShows >= FREQUENT_NO_SHOW_THRESHOLD,
			},
			tags: hasDining
				? [...stored.map(toPersonTag), ...derivedPersonTags(visits, noShows)]
				: [],
			createdAt: Number(r.created_at),
			lastActivityAt: Math.max(
				Number(r.created_at),
				lastVisitAt ?? 0,
				lastOrderAt ?? 0,
			),
		}
	})

	let hasOrders = false
	if (access.customers) {
		const o = await db.all<{ n: number }>(
			sql`SELECT (EXISTS (SELECT 1 FROM restaurant_orders WHERE customer_id IS NOT NULL) OR EXISTS (SELECT 1 FROM shop_orders WHERE customer_id IS NOT NULL)) AS n`,
		)
		hasOrders = Number(o[0]?.n ?? 0) === 1
	}
	let walkInCount: number | null = null
	if (hasDiningFacet(access)) {
		const w = await db.all<{ n: number }>(
			sql`SELECT COUNT(*) AS n FROM rsv_guests g WHERE ${GUEST_LIVE('g')} AND ${WALK_IN_EXPR('g')} = 1 ${access.customers ? sql`AND g.customer_id IS NULL` : sql``}`,
		)
		walkInCount = Number(w[0]?.n ?? 0)
	}

	return { people, nextCursor, total, meta: { hasOrders, walkInCount } }
}

// ---------------------------------------------------------------------------
// Key resolution
// ---------------------------------------------------------------------------

type GuestRow = typeof rsvGuests.$inferSelect
type CustomerRow = typeof customers.$inferSelect

export type ResolvedPerson = {
	/** The key the person is known by now (merges and shadows resolve). */
	canonicalKey: string
	customer: CustomerRow | null
	guest: GuestRow | null
}

const MAX_MERGE_HOPS = 8

async function followMerged(db: DbOrTx, guestId: string): Promise<GuestRow> {
	let id = guestId
	for (let hop = 0; hop <= MAX_MERGE_HOPS; hop++) {
		const row = await db
			.select()
			.from(rsvGuests)
			.where(eq(rsvGuests.id, id))
			.get()
		if (!row) throw notFound('Person not found')
		if (row.erasedAt) throw notFound('Person not found')
		if (!row.mergedIntoId) return row
		id = row.mergedIntoId
	}
	throw notFound('Person not found')
}

async function liveGuestForCustomer(
	db: DbOrTx,
	customerId: string,
): Promise<GuestRow | null> {
	return (
		(await db
			.select()
			.from(rsvGuests)
			.where(
				and(
					eq(rsvGuests.customerId, customerId),
					isNull(rsvGuests.mergedIntoId),
					isNull(rsvGuests.erasedAt),
				),
			)
			.get()) ?? null
	)
}

/** The live guest a booking-form consent created this unverified customer for. */
async function shadowGuestForCustomer(
	db: DbOrTx,
	customerId: string,
): Promise<GuestRow | null> {
	return (
		(await db
			.select()
			.from(rsvGuests)
			.where(
				and(
					eq(rsvGuests.marketingCustomerId, customerId),
					isNull(rsvGuests.mergedIntoId),
					isNull(rsvGuests.erasedAt),
				),
			)
			.orderBy(desc(rsvGuests.updatedAt), rsvGuests.id)
			.get()) ?? null
	)
}

export async function resolvePerson(
	db: DbOrTx,
	access: PeopleAccess,
	rawKey: string,
): Promise<ResolvedPerson> {
	const parsed = parsePersonKey(rawKey)
	if (!parsed) throw notFound('Person not found')

	if (parsed.kind === 'c') {
		requireCustomersFacet(access)
		const customer = await db
			.select()
			.from(customers)
			.where(eq(customers.id, parsed.id))
			.get()
		if (!customer) throw notFound('Person not found')
		if (hasDiningFacet(access)) {
			const linked = await liveGuestForCustomer(db, customer.id)
			if (linked) {
				return {
					canonicalKey: personKey('c', customer.id),
					customer,
					guest: linked,
				}
			}
			if (!customer.phoneVerified) {
				const shadow = await shadowGuestForCustomer(db, customer.id)
				if (shadow) {
					return {
						canonicalKey: personKey('g', shadow.id),
						customer,
						guest: shadow,
					}
				}
			}
		}
		return { canonicalKey: personKey('c', customer.id), customer, guest: null }
	}

	requireDiningFacet(access)
	const guest = await followMerged(db, parsed.id)
	if (guest.customerId && access.customers) {
		const customer = await db
			.select()
			.from(customers)
			.where(eq(customers.id, guest.customerId))
			.get()
		if (customer) {
			return {
				canonicalKey: personKey('c', customer.id),
				customer,
				guest,
			}
		}
	}
	return { canonicalKey: personKey('g', guest.id), customer: null, guest }
}

/** The guest id a key refers to; the person needs a dining facet. */
export async function resolveGuestId(
	db: DbOrTx,
	access: PeopleAccess,
	rawKey: string,
): Promise<string> {
	const person = await resolvePerson(db, access, rawKey)
	if (!person.guest) {
		throw conflict(
			'no_dining_profile',
			'This customer has no reservation history yet',
		)
	}
	return person.guest.id
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

async function ordersSummary(
	db: DbOrTx,
	customerId: string,
): Promise<{ count: number; lastOrderAt: number | null }> {
	const [restaurant] = await db
		.select({ n: count(), last: max(restaurantOrders.createdAt) })
		.from(restaurantOrders)
		.where(eq(restaurantOrders.customerId, customerId))
	const [shop] = await db
		.select({ n: count(), last: max(shopOrders.createdAt) })
		.from(shopOrders)
		.where(eq(shopOrders.customerId, customerId))
	const stamp = (value: unknown): number | null => {
		if (value instanceof Date) return value.getTime()
		if (typeof value === 'number') return value * 1000
		return null
	}
	const lasts = [stamp(restaurant?.last), stamp(shop?.last)].filter(
		(v): v is number => v !== null,
	)
	return {
		count: Number(restaurant?.n ?? 0) + Number(shop?.n ?? 0),
		lastOrderAt: lasts.length > 0 ? Math.max(...lasts) : null,
	}
}

async function nextBookingAt(
	db: DbOrTx,
	guestId: string,
	now: number,
): Promise<number | null> {
	const rows = await db.all<{ n: number | null }>(
		sql`SELECT MIN(start_at) AS n FROM rsv_reservations WHERE guest_id = ${guestId} AND start_at >= ${now} AND status IN ('booked', 'confirmed', 'pending_payment')`,
	)
	const value = rows[0]?.n
	return value === null || value === undefined ? null : Number(value)
}

export type PersonProfile = Awaited<ReturnType<typeof getPersonProfile>>

export async function getPersonProfile(
	db: DbOrTx,
	access: PeopleAccess,
	rawKey: string,
	opts?: { now?: number },
) {
	const now = opts?.now ?? Date.now()
	const person = await resolvePerson(db, access, rawKey)
	const { customer, guest } = person
	const full = access.dining === 'full'

	let customerFacet: {
		id: string
		name: string
		email: string | null
		phone: string | null
		phoneVerified: boolean
		createdAt: number
		orders: { count: number; lastOrderAt: number | null }
	} | null = null
	if (customer && access.customers) {
		customerFacet = {
			id: customer.id,
			name: customer.name,
			email: customer.email,
			phone: customer.phone,
			phoneVerified: Boolean(customer.phoneVerified),
			createdAt: (customer.createdAt?.getTime() ?? 0) || 0,
			orders: await ordersSummary(db, customer.id),
		}
	}

	let dining: {
		guest: {
			id: string
			firstName: string
			lastName: string
			phone: string | null
			email: string | null
			locale: string
			allergyNotes: string | null
			hasAllergy: boolean | null
			visits: number
			covers: number
			noShows: number
			lateCancels: number
			cancels: number
			firstVisitAt: number | null
			lastVisitAt: number | null
			version: number
			tags: PersonTag[]
		}
		nextBookingAt: number | null
		notes: Array<{
			id: string
			body: string
			pinned: boolean
			createdAt: number
		}>
		pinnedNotes: Array<{ id: string; body: string }>
		reservations: Array<{
			id: string
			locationId: string
			businessDate: string
			localStartMin: number
			partySize: number
			status: string
			channel: string
			lateCancel: boolean
			serviceName: string | null
			guestRequests: string | null
			dietaryNotes: string | null
		}>
	} | null = null
	let marketing: GuestMarketingConsent | null = null

	if (guest && hasDiningFacet(access)) {
		const profile = await getGuestProfile(db, guest.id, {
			canReadSensitive: full,
		})
		const g = profile.guest
		dining = {
			guest: {
				id: g.id,
				firstName: g.firstName,
				lastName: g.lastName,
				phone: g.phoneE164,
				email: g.emailNorm,
				locale: g.locale,
				// Free text and the allergy flag need the guest read grant.
				allergyNotes: full ? g.allergyNotes : null,
				hasAllergy: full ? g.hasAllergy : null,
				visits: g.visits,
				covers: g.covers,
				noShows: g.noShows,
				lateCancels: g.lateCancels,
				cancels: g.cancels,
				firstVisitAt: g.firstVisitAt,
				lastVisitAt: g.lastVisitAt,
				version: g.version,
				tags: g.tags.map(toPersonTag),
			},
			nextBookingAt: await nextBookingAt(db, guest.id, now),
			notes: full
				? profile.notes.map((n) => ({
						id: n.id,
						body: n.body,
						pinned: n.pinned,
						createdAt: n.createdAt,
					}))
				: [],
			pinnedNotes: full ? profile.pinnedNotes : [],
			reservations: profile.reservations.map((r) => ({
				id: r.id,
				locationId: r.locationId,
				businessDate: r.businessDate,
				localStartMin: r.localStartMin,
				partySize: r.partySize,
				status: r.status,
				channel: r.channel,
				lateCancel: Boolean(r.lateCancel),
				serviceName: r.serviceName ?? null,
				// Guest-written and staff-written free text stay behind the grant.
				guestRequests: full ? (r.guestRequests ?? null) : null,
				dietaryNotes: full ? (r.dietaryNotes ?? null) : null,
			})),
		}
	}

	// Consent: customer_subscriptions only. Customers access sees it on every
	// customer; guest readers see it for the guest's linked customer, as before.
	if (customer ?? guest) {
		const customerId = customer?.id ?? guest?.customerId ?? null
		if ((access.customers && customer) || (full && guest)) {
			marketing = await loadGuestMarketingConsent(db, {
				customerId,
				marketingCustomerId: guest?.marketingCustomerId ?? null,
			})
		}
	}

	const kind = person.canonicalKey.startsWith('c_') ? 'customer' : 'guest'
	const signedIn =
		Boolean(customer?.phoneVerified) || Boolean(guest?.customerId)
	const status: PersonStatus = signedIn
		? 'signed_in'
		: customer && !guest
			? 'unverified'
			: 'guest_no_sign_in'
	const name =
		(customerFacet?.name ?? '').trim() ||
		(dining ? `${dining.guest.firstName} ${dining.guest.lastName}`.trim() : '')
	const walkIn =
		Boolean(guest) &&
		!customer &&
		!(guest!.phoneE164 ?? '') &&
		!(guest!.emailNorm ?? '')

	return {
		key: rawKey,
		canonicalKey: person.canonicalKey,
		kind: kind as 'customer' | 'guest',
		status,
		signedIn,
		customerLinked: Boolean(customer && guest),
		walkIn,
		name,
		phone: customerFacet?.phone ?? dining?.guest.phone ?? null,
		email: customerFacet?.email ?? dining?.guest.email ?? null,
		customer: customerFacet,
		dining,
		marketing,
		access: {
			customers: access.customers,
			dining: access.dining,
			canUpdateCustomers: access.canUpdateCustomers,
			canUpdateDining: access.canUpdateDining,
			canDelete: access.canDelete,
		},
	}
}

// ---------------------------------------------------------------------------
// Edit
// ---------------------------------------------------------------------------

export type PersonPatch = {
	name?: string
	email?: string | null
	phone?: string | null
	allergyNotes?: string | null
	expectedVersion?: number
}

export function splitName(name: string): { first: string; last: string } {
	const parts = name.trim().split(/\s+/).filter(Boolean)
	return { first: parts[0] ?? '', last: parts.slice(1).join(' ') }
}

export async function updatePerson(
	db: TenantDatabase,
	access: PeopleAccess,
	rawKey: string,
	patch: PersonPatch,
): Promise<string> {
	const person = await resolvePerson(db, access, rawKey)
	const { customer, guest } = person
	const editsAllergy = patch.allergyNotes !== undefined
	const editsContact =
		patch.name !== undefined ||
		patch.email !== undefined ||
		patch.phone !== undefined

	if (customer) {
		if (!access.canUpdateCustomers) {
			if (editsContact) {
				throw forbidden(
					'insufficient_permissions',
					'Updating customers is not allowed',
				)
			}
		}
		if (
			patch.phone !== undefined &&
			(patch.phone ?? null) !== (customer.phone ?? null)
		) {
			throw badRequest(
				'phone_managed_by_sign_in',
				'A customer phone number is managed through sign-in',
			)
		}
	}
	if (editsAllergy) {
		requireDiningWrite(access)
		if (!guest) {
			throw conflict(
				'no_dining_profile',
				'This customer has no reservation history yet',
			)
		}
	}
	// A guest with no customer is edited under the guest grant.
	if (!customer && editsContact) requireDiningWrite(access)
	if (!customer && !guest) throw notFound('Person not found')

	if (customer && editsContact && access.canUpdateCustomers) {
		await db
			.update(customers)
			.set({
				...(patch.name !== undefined ? { name: patch.name } : {}),
				...(patch.email !== undefined ? { email: patch.email } : {}),
				updatedAt: new Date(),
			})
			.where(eq(customers.id, customer.id))
	}

	// The dining facet follows the customer's contact (name and email), and a
	// guest-only person is edited here directly.
	if (guest && hasDiningFacet(access)) {
		const guestPatch: Parameters<typeof updateGuestProfile>[2] = {
			expectedVersion: patch.expectedVersion ?? guest.version,
			actorId: access.actorId,
		}
		let touched = false
		if (patch.name !== undefined) {
			const { first, last } = splitName(patch.name)
			guestPatch.firstName = first
			guestPatch.lastName = last
			touched = true
		}
		if (patch.email !== undefined) {
			guestPatch.email = patch.email
			touched = true
		}
		if (patch.phone !== undefined && !customer) {
			guestPatch.phone = patch.phone
			touched = true
		}
		if (editsAllergy) {
			guestPatch.allergyNotes = patch.allergyNotes ?? null
			touched = true
		}
		// Contact synced from a customer edit needs only the customer grant.
		if (
			touched &&
			(customer ? access.canUpdateCustomers || editsAllergy : true)
		) {
			if (!customer && patch.expectedVersion === undefined) {
				throw badRequest(
					'expected_version_required',
					'expectedVersion is required to edit a guest',
				)
			}
			await updateGuestProfile(db, guest.id, guestPatch)
		}
	}
	return person.canonicalKey
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

export async function mergePeople(
	db: TenantDatabase,
	access: PeopleAccess,
	input: { keepKey: string; mergeKey: string; keepVersion?: number },
) {
	requireDiningWrite(access)
	const keepId = await resolveGuestId(db, access, input.keepKey)
	const mergeId = await resolveGuestId(db, access, input.mergeKey)
	const result = await mergeGuests(db, {
		keepId,
		mergeId,
		expectedVersions:
			input.keepVersion === undefined
				? undefined
				: { [keepId]: input.keepVersion },
		actorId: access.actorId,
	})
	const survivor = await db
		.select({ customerId: rsvGuests.customerId })
		.from(rsvGuests)
		.where(eq(rsvGuests.id, keepId))
		.get()
	const key =
		survivor?.customerId && access.customers
			? personKey('c', survivor.customerId)
			: personKey('g', keepId)
	return { key, movedCounts: result.movedCounts }
}

export { customerSubscriptions }
