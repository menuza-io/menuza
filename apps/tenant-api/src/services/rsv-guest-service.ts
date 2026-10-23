import { randomUUID } from 'node:crypto'
import {
	rsvAuditLog,
	rsvGuestMerges,
	rsvGuestNotes,
	rsvGuests,
	rsvGuestTags,
	rsvMessages,
	rsvPayments,
	rsvReservations,
	rsvTags,
	rsvWaitlistEntries,
	getTenantDbOrgId,
	RSV_NOTIFY_STATUS_VALUES,
	RSV_WAITLIST_STATUS_VALUES,
	type TenantDatabase,
} from '@repo/tenant-db'
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { queryInChunks } from '../lib/chunked-in.ts'
import { badRequest, forbidden, notFound } from '../lib/http.ts'
import { normalizePhone as normalizeSharedPhone } from '../lib/phone.ts'
import { withSetupWrite } from '../lib/reservations-write.ts'
import {
	cancelPendingReservationMessages,
	enqueueReservationMessage,
} from './rsv-message-queue.ts'
import { linkGuestToVerifiedCustomer } from './rsv-customer-link.ts'
import { deliverMessagesByIds } from './rsv-message-service.ts'

export type DbOrTx =
	TenantDatabase | Parameters<Parameters<TenantDatabase['transaction']>[0]>[0]

function createId(prefix: string): string {
	return `${prefix}_${randomUUID()}`
}

/**
 * Lenient guest phone normalization for operator-typed numbers. Region-aware
 * through the shared normalizer (a Saudi `05XXXXXXXX` is `+966...` on a KSA
 * node, never `+1...`); other numbers of 7+ digits keep the historical
 * `+digits` reading and shorter input is returned as typed.
 */
export function normalizeGuestPhone(phone?: string | null): string | null {
	if (!phone) return null
	const trimmed = phone.trim()
	if (!trimmed) return null
	const digits = trimmed.replace(/[^\d+]/g, '')
	if (!digits) return null
	const regional = normalizeSharedPhone(digits)
	if (regional.startsWith('+')) return regional
	const onlyDigits = digits.replace(/\D/g, '')
	if (onlyDigits.length >= 7) return `+${onlyDigits}`
	return trimmed
}

export function normalizeGuestEmail(email?: string | null): string | null {
	if (!email) return null
	const trimmed = email.trim().toLowerCase()
	return trimmed.length > 0 ? trimmed : null
}

export interface SerializedGuestTag {
	id: string
	scope: string
	category: string
	name: string
	icon: string | null
	colorToken: string
	sensitive: boolean
	systemKey?: string | null
}

/**
 * System tags are computed from the guest's counters and never stored as
 * `rsv_guest_tags` rows, so they can be neither set nor removed by hand. The
 * catalog rows behind these ids are created on first read (`ensureSystemTags`).
 */
export const SYSTEM_GUEST_TAGS = {
	first_visit: {
		id: 'tag_sys_first_visit',
		name: 'First visit',
		colorToken: 'sky',
	},
	frequent_no_show: {
		id: 'tag_sys_frequent_no_show',
		name: 'Frequent no-show',
		colorToken: 'red',
	},
} as const
export type SystemGuestTagKey = keyof typeof SYSTEM_GUEST_TAGS

export const FREQUENT_NO_SHOW_THRESHOLD = 2

export function deriveSystemTagKeys(row: {
	visits: number
	noShows: number
	erasedAt: number | null
}): SystemGuestTagKey[] {
	if (row.erasedAt) return []
	const keys: SystemGuestTagKey[] = []
	if (row.visits === 0) keys.push('first_visit')
	if (row.noShows >= FREQUENT_NO_SHOW_THRESHOLD) keys.push('frequent_no_show')
	return keys
}

function derivedSystemTags(row: {
	visits: number
	noShows: number
	erasedAt: number | null
}): SerializedGuestTag[] {
	return deriveSystemTagKeys(row).map((key) => ({
		id: SYSTEM_GUEST_TAGS[key].id,
		scope: 'guest',
		category: 'system',
		name: SYSTEM_GUEST_TAGS[key].name,
		icon: null,
		colorToken: SYSTEM_GUEST_TAGS[key].colorToken,
		sensitive: false,
		systemKey: key,
	}))
}

export interface SerializedGuestSummary {
	id: string
	name: string
	firstName: string
	first_name: string
	lastName: string
	last_name: string
	phoneE164: string | null
	phone_e164: string | null
	phone: string | null
	emailNorm: string | null
	email_norm: string | null
	email: string | null
	locale: string
	allergyNotes: string | null
	allergy_notes: string | null
	hasAllergy: boolean
	has_allergy: boolean
	visits: number
	covers: number
	noShows: number
	no_shows: number
	lateCancels: number
	late_cancels: number
	cancels: number
	firstVisitAt: number | null
	first_visit_at: number | null
	lastVisitAt: number | null
	last_visit_at: number | null
	erasedAt: number | null
	erased_at: number | null
	/** Opaque: whether a verified tenant customer is linked (never the id). */
	customerLinked: boolean
	mergedIntoId: string | null
	version: number
	tags: SerializedGuestTag[]
	/** Pinned notes shown to hosts; present on book and day-feed summaries. */
	pinnedNotes?: Array<{ id: string; body: string }>
}

export async function loadPinnedNotesMap(
	db: DbOrTx,
	guestIds: string[],
): Promise<Map<string, Array<{ id: string; body: string }>>> {
	const map = new Map<string, Array<{ id: string; body: string }>>()
	if (guestIds.length === 0) return map
	const rows = await queryInChunks(guestIds, (chunk) =>
		db
			.select({
				id: rsvGuestNotes.id,
				guestId: rsvGuestNotes.guestId,
				body: rsvGuestNotes.body,
			})
			.from(rsvGuestNotes)
			.where(
				and(
					inArray(rsvGuestNotes.guestId, chunk),
					eq(rsvGuestNotes.pinned, true),
					isNull(rsvGuestNotes.deletedAt),
				),
			)
			.orderBy(desc(rsvGuestNotes.createdAt))
			.all(),
	)
	for (const row of rows) {
		const list = map.get(row.guestId) ?? []
		list.push({ id: row.id, body: row.body })
		map.set(row.guestId, list)
	}
	return map
}

export async function loadGuestTagsMap(
	db: DbOrTx,
	guestIds: string[],
	opts?: { canReadSensitive?: boolean },
): Promise<Map<string, SerializedGuestTag[]>> {
	const map = new Map<string, SerializedGuestTag[]>()
	if (guestIds.length === 0) return map

	const rows = await queryInChunks(guestIds, (chunk) =>
		db
			.select({
				guestId: rsvGuestTags.guestId,
				id: rsvTags.id,
				scope: rsvTags.scope,
				category: rsvTags.category,
				name: rsvTags.name,
				colorToken: rsvTags.colorToken,
				sensitive: rsvTags.sensitive,
			})
			.from(rsvGuestTags)
			.innerJoin(rsvTags, eq(rsvGuestTags.tagId, rsvTags.id))
			.where(inArray(rsvGuestTags.guestId, chunk))
			.all(),
	)

	const canReadSensitive = opts?.canReadSensitive === true
	for (const r of rows) {
		if (!canReadSensitive && r.sensitive) continue
		const list = map.get(r.guestId) ?? []
		list.push({
			id: r.id,
			scope: r.scope,
			category: r.category,
			name: r.name,
			icon: null,
			colorToken: r.colorToken,
			sensitive: r.sensitive,
		})
		map.set(r.guestId, list)
	}
	return map
}

export function serializeGuestRow(
	row: typeof rsvGuests.$inferSelect,
	tags: SerializedGuestTag[],
	opts?: { canReadSensitive?: boolean },
): SerializedGuestSummary {
	const canReadSensitive = opts?.canReadSensitive === true
	const hasRawAllergy = Boolean(
		row.allergyNotes && row.allergyNotes.trim().length > 0,
	)
	const hasDietaryTag = tags.some((t) => t.category === 'dietary')
	const hasAllergy = hasRawAllergy || hasDietaryTag
	const allergyNotes = canReadSensitive ? row.allergyNotes : null

	const fullName = `${row.firstName} ${row.lastName}`.trim()

	return {
		id: row.id,
		name: fullName,
		firstName: row.firstName,
		first_name: row.firstName,
		lastName: row.lastName,
		last_name: row.lastName,
		phoneE164: row.phoneE164,
		phone_e164: row.phoneE164,
		phone: row.phoneE164,
		emailNorm: row.emailNorm,
		email_norm: row.emailNorm,
		email: row.emailNorm,
		locale: row.locale,
		allergyNotes,
		allergy_notes: allergyNotes,
		hasAllergy,
		has_allergy: hasAllergy,
		visits: row.visits,
		covers: row.covers,
		noShows: row.noShows,
		no_shows: row.noShows,
		lateCancels: row.lateCancels,
		late_cancels: row.lateCancels,
		cancels: row.cancels,
		firstVisitAt: row.firstVisitAt,
		first_visit_at: row.firstVisitAt,
		lastVisitAt: row.lastVisitAt,
		last_visit_at: row.lastVisitAt,
		erasedAt: row.erasedAt,
		erased_at: row.erasedAt,
		customerLinked: row.customerId !== null,
		mergedIntoId: row.mergedIntoId,
		version: row.version,
		tags: [
			...tags.filter((tag) => tag.category !== 'system'),
			...derivedSystemTags(row),
		],
	}
}

export async function searchGuests(
	db: DbOrTx,
	query?: string,
	opts?: number | { limit?: number; canReadSensitive?: boolean },
): Promise<SerializedGuestSummary[]> {
	const resolvedOpts = typeof opts === 'number' ? { limit: opts } : opts
	const limit = Math.min(Math.max(resolvedOpts?.limit ?? 20, 1), 100)
	const q = query?.trim() ?? ''

	let rows: Array<typeof rsvGuests.$inferSelect>
	if (!q) {
		rows = await db
			.select()
			.from(rsvGuests)
			.where(and(isNull(rsvGuests.mergedIntoId), isNull(rsvGuests.erasedAt)))
			.orderBy(desc(rsvGuests.updatedAt))
			.limit(limit)
			.all()
	} else {
		// `%` and `_` typed by the caller are literal characters, not wildcards
		// (a bare `%%` would otherwise match every guest).
		const escape = (value: string) =>
			value.replace(/[\\%_]/g, (ch) => `\\${ch}`)
		const pattern = `%${escape(q)}%`
		const digits = q.replace(/\D/g, '')
		const phonePattern = digits.length >= 3 ? `%${digits}%` : pattern
		rows = await db
			.select()
			.from(rsvGuests)
			.where(
				and(
					isNull(rsvGuests.mergedIntoId),
					isNull(rsvGuests.erasedAt),
					or(
						sql`${rsvGuests.firstName} LIKE ${pattern} ESCAPE '\\'`,
						sql`${rsvGuests.lastName} LIKE ${pattern} ESCAPE '\\'`,
						sql`${rsvGuests.phoneE164} LIKE ${phonePattern} ESCAPE '\\'`,
						sql`${rsvGuests.emailNorm} LIKE ${pattern.toLowerCase()} ESCAPE '\\'`,
					),
				),
			)
			.orderBy(desc(rsvGuests.visits), desc(rsvGuests.updatedAt))
			.limit(limit)
			.all()
	}

	const tagsMap = await loadGuestTagsMap(
		db,
		rows.map((r) => r.id),
		resolvedOpts,
	)

	// Pinned note bodies are private free text: only the guest-data grant sees
	// them, so without it they are not even read.
	const pinned =
		resolvedOpts?.canReadSensitive === true
			? await loadPinnedNotesMap(
					db,
					rows.map((r) => r.id),
				)
			: new Map<string, Array<{ id: string; body: string }>>()
	return rows.map((r) => ({
		...serializeGuestRow(r, tagsMap.get(r.id) ?? [], resolvedOpts),
		pinnedNotes: pinned.get(r.id) ?? [],
	}))
}

export const lookupGuests = searchGuests

export async function createGuestProfile(
	db: DbOrTx,
	input: {
		firstName: string
		lastName?: string
		phone?: string | null
		phoneE164?: string | null
		email?: string | null
		emailNorm?: string | null
		locale?: string
		allergyNotes?: string | null
		tagIds?: string[]
		note?: string | null
		actorId?: string | null
	},
	opts?: { canReadSensitive?: boolean },
): Promise<SerializedGuestSummary> {
	const firstName = input.firstName?.trim()
	if (!firstName) {
		throw badRequest('invalid_guest', 'Guest first name is required')
	}
	const lastName = (input.lastName ?? '').trim()
	const phoneE164 = normalizeGuestPhone(input.phoneE164 ?? input.phone)
	const emailNorm = normalizeGuestEmail(input.emailNorm ?? input.email)
	const now = Date.now()
	const id = createId('gst')

	await db.insert(rsvGuests).values({
		id,
		firstName,
		lastName,
		phoneE164,
		emailNorm,
		locale: input.locale?.trim() ?? '',
		allergyNotes: input.allergyNotes ?? null,
		createdAt: now,
		updatedAt: now,
		version: 1,
	})

	if (input.tagIds && input.tagIds.length > 0) {
		for (const tagId of new Set(input.tagIds)) {
			await db
				.insert(rsvGuestTags)
				.values({
					guestId: id,
					tagId,
				})
				.onConflictDoNothing()
		}
	}

	if (input.note && input.note.trim().length > 0) {
		await db.insert(rsvGuestNotes).values({
			id: createId('gnote'),
			guestId: id,
			body: input.note.trim(),
			pinned: false,
			authorId: input.actorId ?? 'system',
			createdAt: now,
		})
	}

	await linkGuestToVerifiedCustomer(db, {
		id,
		customerId: null,
		phoneE164,
		erasedAt: null,
		mergedIntoId: null,
	})
	const row = await db
		.select()
		.from(rsvGuests)
		.where(eq(rsvGuests.id, id))
		.get()
	const tagsMap = await loadGuestTagsMap(db, [id], opts)
	return serializeGuestRow(row!, tagsMap.get(id) ?? [], opts)
}

async function resolveOrCreateGuestInner(
	db: DbOrTx,
	input: {
		guestId?: string | null
		guest?: {
			id?: string | null
			firstName?: string
			lastName?: string
			phone?: string | null
			phoneE164?: string | null
			email?: string | null
			emailNorm?: string | null
			locale?: string
			allergyNotes?: string | null
			tagIds?: string[]
		} | null
		actorId?: string | null
		/**
		 * The caller cannot read guest details (a host at a till, a member without
		 * the guest permission): a booking for a known guest (by id, phone or
		 * email) links to them but only fills what their profile lacks. It never
		 * replaces a name, phone, email or allergy note it could not even see.
		 */
		keepMatchedProfile?: boolean
	},
): Promise<typeof rsvGuests.$inferSelect> {
	const now = Date.now()
	const requestedId = input.guestId ?? input.guest?.id ?? null

	if (requestedId) {
		let existing = await db
			.select()
			.from(rsvGuests)
			.where(eq(rsvGuests.id, requestedId))
			.get()
		if (existing?.mergedIntoId) {
			const primary = await db
				.select()
				.from(rsvGuests)
				.where(eq(rsvGuests.id, existing.mergedIntoId))
				.get()
			if (primary) existing = primary
		}
		if (!existing) {
			throw notFound('Guest not found')
		}
		const keepProfile = input.keepMatchedProfile === true
		if (
			input.guest?.allergyNotes !== undefined &&
			!(keepProfile && existing.allergyNotes)
		) {
			await db
				.update(rsvGuests)
				.set({
					allergyNotes: input.guest.allergyNotes,
					updatedAt: now,
					version: existing.version + 1,
				})
				.where(eq(rsvGuests.id, existing.id))
			existing = (await db
				.select()
				.from(rsvGuests)
				.where(eq(rsvGuests.id, existing.id))
				.get())!
		}
		if (input.guest?.tagIds && input.guest.tagIds.length > 0) {
			for (const tagId of new Set(input.guest.tagIds)) {
				await db
					.insert(rsvGuestTags)
					.values({
						guestId: existing.id,
						tagId,
					})
					.onConflictDoNothing()
			}
		}
		return existing
	}

	const g = input.guest
	const firstName = g?.firstName?.trim() || 'Walk-in'
	const lastName =
		g?.lastName !== undefined ? g.lastName.trim() : g?.firstName ? '' : 'Guest'
	const phoneE164 = normalizeGuestPhone(g?.phoneE164 ?? g?.phone)
	const emailNorm = normalizeGuestEmail(g?.emailNorm ?? g?.email)

	// Match existing guest by phone or email if present
	let matched: typeof rsvGuests.$inferSelect | undefined
	if (phoneE164) {
		matched = await db
			.select()
			.from(rsvGuests)
			.where(
				and(
					eq(rsvGuests.phoneE164, phoneE164),
					isNull(rsvGuests.mergedIntoId),
					isNull(rsvGuests.erasedAt),
				),
			)
			.get()
	}
	if (!matched && emailNorm) {
		matched = await db
			.select()
			.from(rsvGuests)
			.where(
				and(
					eq(rsvGuests.emailNorm, emailNorm),
					isNull(rsvGuests.mergedIntoId),
					isNull(rsvGuests.erasedAt),
				),
			)
			.get()
	}

	if (matched) {
		const keep = input.keepMatchedProfile === true
		const nextAllergy =
			g?.allergyNotes !== undefined && !(keep && matched.allergyNotes)
				? g.allergyNotes
				: matched.allergyNotes
		await db
			.update(rsvGuests)
			.set({
				firstName: keep
					? matched.firstName
					: g?.firstName?.trim() || matched.firstName,
				lastName: keep
					? matched.lastName
					: g?.lastName?.trim() || matched.lastName,
				phoneE164: keep
					? (matched.phoneE164 ?? phoneE164)
					: (phoneE164 ?? matched.phoneE164),
				emailNorm: keep
					? (matched.emailNorm ?? emailNorm)
					: (emailNorm ?? matched.emailNorm),
				allergyNotes: nextAllergy,
				updatedAt: now,
			})
			.where(eq(rsvGuests.id, matched.id))

		if (g?.tagIds && g.tagIds.length > 0) {
			for (const tagId of new Set(g.tagIds)) {
				await db
					.insert(rsvGuestTags)
					.values({
						guestId: matched.id,
						tagId,
					})
					.onConflictDoNothing()
			}
		}

		return (await db
			.select()
			.from(rsvGuests)
			.where(eq(rsvGuests.id, matched.id))
			.get())!
	}

	const id = createId('gst')
	await db.insert(rsvGuests).values({
		id,
		firstName,
		lastName,
		phoneE164,
		emailNorm,
		locale: g?.locale?.trim() ?? '',
		allergyNotes: g?.allergyNotes ?? null,
		createdAt: now,
		updatedAt: now,
		version: 1,
	})

	if (g?.tagIds && g.tagIds.length > 0) {
		for (const tagId of new Set(g.tagIds)) {
			await db
				.insert(rsvGuestTags)
				.values({
					guestId: id,
					tagId,
				})
				.onConflictDoNothing()
		}
	}

	return (await db.select().from(rsvGuests).where(eq(rsvGuests.id, id)).get())!
}

/**
 * Resolves (or creates) the guest an operator-made booking is for. A guest
 * that carries the verified phone of a customer is linked to it (never on an
 * unverified phone, name or email); a walk-in without contact stays guest-only.
 */
export async function resolveOrCreateGuestForBooking(
	db: DbOrTx,
	input: Parameters<typeof resolveOrCreateGuestInner>[1],
): Promise<typeof rsvGuests.$inferSelect> {
	const guest = await resolveOrCreateGuestInner(db, input)
	if (guest.customerId) return guest
	const customerId = await linkGuestToVerifiedCustomer(db, guest)
	return customerId ? { ...guest, customerId } : guest
}

export async function getGuestSummary(
	db: DbOrTx,
	guestId: string,
	opts?: { canReadSensitive?: boolean; actorId?: string | null },
) {
	const row = await db
		.select()
		.from(rsvGuests)
		.where(eq(rsvGuests.id, guestId))
		.get()
	if (!row) throw notFound('Guest not found')

	const canReadSensitive = opts?.canReadSensitive === true
	const tagsMap = await loadGuestTagsMap(db, [guestId], { canReadSensitive })
	const liveNotes = await db
		.select()
		.from(rsvGuestNotes)
		.where(
			and(eq(rsvGuestNotes.guestId, guestId), isNull(rsvGuestNotes.deletedAt)),
		)
		.orderBy(desc(rsvGuestNotes.pinned), desc(rsvGuestNotes.createdAt))
		.all()
	const notes = canReadSensitive ? liveNotes : []
	const pinnedNotes = (canReadSensitive ? liveNotes : [])
		.filter((n) => n.pinned)
		.map((n) => ({ id: n.id, body: n.body, createdAt: n.createdAt }))

	const reservations = await db
		.select()
		.from(rsvReservations)
		.where(eq(rsvReservations.guestId, guestId))
		.orderBy(desc(rsvReservations.startAt))
		.limit(50)
		.all()

	return {
		guest: serializeGuestRow(row, tagsMap.get(guestId) ?? [], {
			canReadSensitive,
		}),
		notes,
		pinnedNotes,
		reservations: reservations.map((r) => ({
			id: r.id,
			locationId: r.locationId,
			businessDate: r.businessDate,
			localStartMin: r.localStartMin,
			partySize: r.partySize,
			status: r.status,
			channel: r.channel,
			dietaryNotes: canReadSensitive ? r.dietaryNotes : null,
			guestRequests: canReadSensitive ? r.guestRequests : null,
			staffNotes: canReadSensitive ? r.staffNotes : null,
			startAt: r.startAt,
			endAt: r.endAt,
		})),
	}
}

export async function exportGuestProfile(
	db: DbOrTx,
	guestIdOrOpts:
		| string
		| {
				guestId: string
				actorId: string
				includeSensitive: boolean
				canIncludeSensitive?: boolean
		  },
	maybeOpts?: {
		actorId: string
		includeSensitive: boolean
		canIncludeSensitive?: boolean
	},
) {
	const guestId =
		typeof guestIdOrOpts === 'string' ? guestIdOrOpts : guestIdOrOpts.guestId
	const rawOpts = typeof guestIdOrOpts === 'string' ? maybeOpts! : guestIdOrOpts
	const opts = {
		actorId: rawOpts.actorId,
		includeSensitive: Boolean(rawOpts.includeSensitive),
		canIncludeSensitive: rawOpts.canIncludeSensitive ?? true,
	}

	if (opts.includeSensitive && !opts.canIncludeSensitive) {
		throw forbidden(
			'missing_permission',
			'update:reservation_guest:any is required to include sensitive guest fields in export',
		)
	}

	const row = await db
		.select()
		.from(rsvGuests)
		.where(eq(rsvGuests.id, guestId))
		.get()
	if (!row) throw notFound('Guest not found')

	const includeSensitive = Boolean(opts.includeSensitive)
	const tagsMap = await loadGuestTagsMap(db, [guestId], {
		canReadSensitive: includeSensitive,
	})
	const tags = tagsMap.get(guestId) ?? []

	const notes = await db
		.select()
		.from(rsvGuestNotes)
		.where(
			and(eq(rsvGuestNotes.guestId, guestId), isNull(rsvGuestNotes.deletedAt)),
		)
		.orderBy(desc(rsvGuestNotes.createdAt))
		.all()

	const reservations = await db
		.select()
		.from(rsvReservations)
		.where(eq(rsvReservations.guestId, guestId))
		.orderBy(desc(rsvReservations.startAt))
		.all()

	const waitlistEntries = await db
		.select()
		.from(rsvWaitlistEntries)
		.where(eq(rsvWaitlistEntries.guestId, guestId))
		.orderBy(desc(rsvWaitlistEntries.createdAt))
		.all()

	const resIds = reservations.map((r) => r.id)
	const paymentIntents = await queryInChunks(resIds, (chunk) =>
		db
			.select()
			.from(rsvPayments)
			.where(inArray(rsvPayments.reservationId, chunk))
			.all(),
	)

	const messages = await queryInChunks(resIds, (chunk) =>
		db
			.select()
			.from(rsvMessages)
			.where(inArray(rsvMessages.reservationId, chunk))
			.all(),
	)

	const now = Date.now()
	await db.insert(rsvAuditLog).values({
		id: createId('aud'),
		at: now,
		actorKind: 'operator',
		actorId: opts.actorId,
		locationId: reservations[0]?.locationId ?? null,
		action: 'guest.export',
		entityType: 'guest',
		entityId: guestId,
		changes: {
			includeSensitive,
		},
	})

	return {
		exportedAt: now,
		includeSensitive,
		guest: {
			id: row.id,
			firstName: row.firstName,
			lastName: row.lastName,
			phoneE164: row.phoneE164,
			emailNorm: row.emailNorm,
			locale: row.locale,
			allergyNotes: includeSensitive ? row.allergyNotes : null,
			visits: row.visits,
			covers: row.covers,
			noShows: row.noShows,
			lateCancels: row.lateCancels,
			cancels: row.cancels,
			firstVisitAt: row.firstVisitAt,
			lastVisitAt: row.lastVisitAt,
			erasedAt: row.erasedAt,
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
		},
		tags,
		notes: notes.map((n) => ({
			id: n.id,
			locationId: null,
			body: n.body,
			pinned: n.pinned,
			authorId: n.authorId,
			createdAt: n.createdAt,
		})),
		reservations: reservations.map((r) => ({
			id: r.id,
			locationId: r.locationId,
			confirmationCode: r.confirmationCode,
			businessDate: r.businessDate,
			localStartMin: r.localStartMin,
			partySize: r.partySize,
			status: r.status,
			channel: r.channel,
			guestRequests: includeSensitive ? r.guestRequests : null,
			dietaryNotes: includeSensitive ? r.dietaryNotes : null,
			staffNotes: includeSensitive ? r.staffNotes : null,
			startAt: r.startAt,
			endAt: r.endAt,
			createdAt: r.createdAt,
		})),
		waitlistEntries: waitlistEntries.map((w) => ({
			id: w.id,
			locationId: w.locationId,
			businessDate: w.businessDate,
			partySize: w.partySize,
			status: w.status,
			quotedWaitMin: w.quotedMin,
			notes: includeSensitive ? w.notes : null,
			createdAt: w.createdAt,
		})),
		paymentIntents: paymentIntents.map((p) => ({
			id: p.id,
			reservationId: p.reservationId,
			kind: p.kind,
			provider: p.provider,
			amountMinor: p.amountMinor,
			currency: p.currency,
			status: p.status,
			createdAt: p.createdAt,
		})),
		messages: messages.map((m) => ({
			id: m.id,
			reservationId: m.reservationId,
			channel: m.channel,
			kind: m.kind,
			status: m.status,
			sentAt: m.sentAt,
			createdAt: m.createdAt,
		})),
	}
}

const TERMINAL_WAITLIST_STATUSES: readonly string[] = [
	'seated',
	'cancelled',
	'left',
	'no_response',
]
export const OPEN_WAITLIST_STATUSES = RSV_WAITLIST_STATUS_VALUES.filter(
	(status) => !TERMINAL_WAITLIST_STATUSES.includes(status),
)
const TERMINAL_NOTIFY_STATUSES: readonly string[] = [
	'booked',
	'expired',
	'cancelled',
]
export const OPEN_NOTIFY_STATUSES = RSV_NOTIFY_STATUS_VALUES.filter(
	(status) => !TERMINAL_NOTIFY_STATUSES.includes(status),
)

/**
 * The guest plus every guest merged into it, following both merge links
 * (`mergedIntoId` and `rsv_guest_merges`) recursively. A visited set stops a
 * cycle from looping.
 */
export async function collectMergedGuestIds(
	db: DbOrTx,
	rootId: string,
): Promise<string[]> {
	const seen = new Set<string>([rootId])
	let frontier = [rootId]
	while (frontier.length > 0) {
		const found = new Set<string>()
		const byColumn = await queryInChunks(frontier, (chunk) =>
			db
				.select({ id: rsvGuests.id })
				.from(rsvGuests)
				.where(inArray(rsvGuests.mergedIntoId, chunk))
				.all(),
		)
		const byLink = await queryInChunks(frontier, (chunk) =>
			db
				.select({ id: rsvGuestMerges.mergedGuestId })
				.from(rsvGuestMerges)
				.where(inArray(rsvGuestMerges.keptGuestId, chunk))
				.all(),
		)
		for (const row of [...byColumn, ...byLink]) {
			if (!seen.has(row.id)) {
				seen.add(row.id)
				found.add(row.id)
			}
		}
		frontier = [...found]
	}
	return [...seen]
}

export const CANCELLABLE_FUTURE_STATUSES = new Set([
	'pending_payment',
	'pending_approval',
	'booked',
	'confirmed',
])

/**
 * The guest hears about the cancellation while their name and contact still
 * exist: the message is built and sent now, because once the profile is
 * anonymized there is nobody left to write to. A failed send is not allowed to
 * block the erasure.
 */
export async function notifyGuestBeforeErasure(
	db: TenantDatabase,
	guestIds: readonly string[],
	now: number,
) {
	const orgId = getTenantDbOrgId(db)
	if (!orgId) return
	try {
		const upcoming = await queryInChunks(
			[...guestIds],
			(chunk) =>
				db
					.select({ id: rsvReservations.id })
					.from(rsvReservations)
					.where(
						and(
							inArray(rsvReservations.guestId, chunk),
							inArray(rsvReservations.status, [
								...CANCELLABLE_FUTURE_STATUSES,
							] as never[]),
						),
					)
					.all(),
			80,
		)
		if (upcoming.length === 0) return
		const ids = await withSetupWrite(
			db,
			async (tx) => {
				const queued: string[] = []
				for (const reservation of upcoming) {
					await cancelPendingReservationMessages(tx, reservation.id)
					queued.push(
						...(await enqueueReservationMessage(
							tx,
							{ orgId, now },
							{
								reservationId: reservation.id,
								kind: 'cancellation_restaurant',
							},
						)),
					)
				}
				return queued
			},
			orgId,
		)
		await deliverMessagesByIds(orgId, ids, { db, now })
	} catch (error) {
		console.error(
			'[reservations] erasure notice failed',
			error instanceof Error ? error.name : 'error',
		)
	}
}

/**
 * Erases a guest and everything that identifies the same person: see
 * `erasePerson` (`person-erasure-service.ts`), which this delegates to so the
 * operator guest erase, the customer erase and the internal route are one
 * flow. The import is lazy because that module builds on this one.
 */
export async function eraseGuestProfile(
	dbOrOpts:
		| TenantDatabase
		| {
				db?: TenantDatabase
				orgId?: string
				guestId: string
				actorId: string
				now?: number
		  },
	maybeGuestId?: string,
	maybeOpts?: { actorId: string; now?: number },
) {
	let db: TenantDatabase
	let guestId: string
	let opts: { actorId: string; now?: number }

	if (typeof maybeGuestId === 'string') {
		db = dbOrOpts as TenantDatabase
		guestId = maybeGuestId
		opts = maybeOpts ?? { actorId: 'system' }
	} else {
		const obj = dbOrOpts as {
			db?: TenantDatabase
			orgId?: string
			guestId: string
			actorId: string
			now?: number
		}
		if (obj.db) {
			db = obj.db
		} else if (obj.orgId) {
			const { getTenantDb } = await import('@repo/tenant-db')
			db = await getTenantDb(obj.orgId)
		} else {
			throw badRequest('invalid_erase_call', 'db or orgId is required')
		}
		guestId = obj.guestId
		opts = { actorId: obj.actorId, now: obj.now }
	}

	const { erasePerson } = await import('./person-erasure-service.ts')
	const result = await erasePerson(db, { guestId }, opts)
	return {
		erased: true as const,
		cancelledFutureReservations: result.cancelledFutureReservations,
		guest: result.guest!,
		guestsErased: result.guestsErased,
		customersErased: result.customersErased,
	}
}
