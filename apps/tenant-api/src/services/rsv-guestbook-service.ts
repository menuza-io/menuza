import { randomUUID } from 'node:crypto'
import {
	customers,
	rsvAuditLog,
	rsvDayVersions,
	rsvGuestMerges,
	rsvGuestNotes,
	rsvGuests,
	rsvGuestTags,
	rsvNotifyRequests,
	rsvReservationEvents,
	rsvReservations,
	rsvServices,
	rsvTags,
	rsvWaitlistEntries,
	type TenantDatabase,
} from '@repo/tenant-db'
import {
	and,
	asc,
	desc,
	eq,
	gte,
	inArray,
	isNull,
	sql,
	type SQL,
} from 'drizzle-orm'
import { queryInChunks } from '../lib/chunked-in.ts'
import { badRequest, conflict, notFound } from '../lib/http.ts'
import { withSetupWrite } from '../lib/reservations-write.ts'
import { linkGuestToVerifiedCustomer } from './rsv-customer-link.ts'
import { loadGuestMarketingConsent } from './rsv-marketing-consent.ts'
import {
	deriveSystemTagKeys,
	FREQUENT_NO_SHOW_THRESHOLD,
	getGuestSummary,
	loadGuestTagsMap,
	normalizeGuestEmail,
	normalizeGuestPhone,
	serializeGuestRow,
	SYSTEM_GUEST_TAGS,
	type DbOrTx,
	type SerializedGuestSummary,
	type SerializedGuestTag,
	type SystemGuestTagKey,
} from './rsv-guest-service.ts'

export const GUESTBOOK_PAGE_SIZE = 50

function createId(prefix: string): string {
	return `${prefix}_${randomUUID()}`
}

// ---------------------------------------------------------------------------
// Tag catalog
// ---------------------------------------------------------------------------

export const GUEST_TAG_CATEGORIES = [
	'vip',
	'dietary',
	'regular',
	'seating',
	'custom',
] as const
export type GuestTagCategory = (typeof GUEST_TAG_CATEGORIES)[number]

const SYSTEM_TAG_ID_SET = new Set<string>(
	Object.values(SYSTEM_GUEST_TAGS).map((t) => t.id),
)

export function isSystemGuestTagId(id: string): boolean {
	return SYSTEM_TAG_ID_SET.has(id)
}

/** Creates the catalog rows for the computed system tags when they are missing. */
export async function ensureSystemTags(db: DbOrTx): Promise<void> {
	for (const [key, def] of Object.entries(SYSTEM_GUEST_TAGS)) {
		await db
			.insert(rsvTags)
			.values({
				id: def.id,
				scope: 'guest',
				category: 'system',
				name: def.name,
				colorToken: def.colorToken,
				sensitive: false,
				systemKey: key as SystemGuestTagKey,
				guestSelectable: false,
			})
			.onConflictDoNothing()
	}
}

function serializeCatalogTag(row: typeof rsvTags.$inferSelect) {
	return {
		id: row.id,
		scope: row.scope,
		category: row.category,
		name: row.name,
		colorToken: row.colorToken,
		sensitive: row.sensitive,
		systemKey: row.systemKey,
		/** System tags are derived from counters and cannot be edited by hand. */
		editable: row.systemKey === null,
		archived: row.archivedAt !== null,
	}
}

export async function listGuestTags(db: DbOrTx) {
	await ensureSystemTags(db)
	const rows = await db
		.select()
		.from(rsvTags)
		.where(and(eq(rsvTags.scope, 'guest'), isNull(rsvTags.archivedAt)))
		.orderBy(asc(rsvTags.category), asc(rsvTags.name))
		.all()
	return rows.map(serializeCatalogTag)
}

async function assertTagNameFree(
	db: DbOrTx,
	name: string,
	exceptId?: string,
): Promise<void> {
	const rows = await db
		.select({ id: rsvTags.id })
		.from(rsvTags)
		.where(
			and(
				eq(rsvTags.scope, 'guest'),
				isNull(rsvTags.archivedAt),
				sql`lower(${rsvTags.name}) = ${name.toLowerCase()}`,
			),
		)
		.all()
	if (rows.some((r) => r.id !== exceptId)) {
		throw conflict('tag_exists', 'A tag with this name already exists')
	}
}

export async function createGuestTag(
	db: TenantDatabase,
	input: {
		name: string
		category?: GuestTagCategory
		colorToken?: string
		actorId: string
	},
) {
	const name = input.name.trim()
	if (!name) throw badRequest('invalid_tag', 'Tag name is required')
	const category = input.category ?? 'custom'
	return withSetupWrite(db, async (tx) => {
		await assertTagNameFree(tx, name)
		const id = createId('tag')
		await tx.insert(rsvTags).values({
			id,
			scope: 'guest',
			category,
			name,
			colorToken: input.colorToken ?? 'neutral',
			// Dietary tags carry allergy facts, so they follow the allergy rules.
			sensitive: category === 'dietary',
			guestSelectable: false,
		})
		await tx.insert(rsvAuditLog).values({
			id: createId('aud'),
			at: Date.now(),
			actorKind: 'operator',
			actorId: input.actorId,
			action: 'guest_tag.create',
			entityType: 'tag',
			entityId: id,
			changes: { category },
		})
		const row = await tx.select().from(rsvTags).where(eq(rsvTags.id, id)).get()
		return serializeCatalogTag(row!)
	})
}

export async function updateGuestTag(
	db: TenantDatabase,
	tagId: string,
	input: {
		name?: string
		colorToken?: string
		archived?: boolean
		actorId: string
	},
) {
	return withSetupWrite(db, async (tx) => {
		const row = await tx
			.select()
			.from(rsvTags)
			.where(and(eq(rsvTags.id, tagId), eq(rsvTags.scope, 'guest')))
			.get()
		if (!row) throw notFound('Tag not found')
		if (row.systemKey !== null) {
			throw badRequest('system_tag', 'System tags cannot be edited')
		}
		const patch: Partial<typeof rsvTags.$inferInsert> = {}
		if (input.name !== undefined) {
			const name = input.name.trim()
			if (!name) throw badRequest('invalid_tag', 'Tag name is required')
			await assertTagNameFree(tx, name, row.id)
			patch.name = name
		}
		if (input.colorToken !== undefined) patch.colorToken = input.colorToken
		if (input.archived !== undefined) {
			patch.archivedAt = input.archived ? Date.now() : null
		}
		if (Object.keys(patch).length > 0) {
			await tx.update(rsvTags).set(patch).where(eq(rsvTags.id, row.id))
			await tx.insert(rsvAuditLog).values({
				id: createId('aud'),
				at: Date.now(),
				actorKind: 'operator',
				actorId: input.actorId,
				action: 'guest_tag.update',
				entityType: 'tag',
				entityId: row.id,
				changes: { fields: Object.keys(patch) },
			})
		}
		const next = await tx
			.select()
			.from(rsvTags)
			.where(eq(rsvTags.id, row.id))
			.get()
		return serializeCatalogTag(next!)
	})
}

// ---------------------------------------------------------------------------
// List and search
// ---------------------------------------------------------------------------

export const GUEST_SORTS = ['updated', 'name', 'visits', 'last_visit'] as const
export type GuestSort = (typeof GUEST_SORTS)[number]

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

function searchPredicate(query: string): SQL {
	const q = query.toLowerCase()
	const like = `%${escapeLike(q)}%`
	const clauses: SQL[] = [
		sql`lower(${rsvGuests.firstName}) LIKE ${like} ESCAPE '\\'`,
		sql`lower(${rsvGuests.lastName}) LIKE ${like} ESCAPE '\\'`,
		sql`lower(${rsvGuests.firstName} || ' ' || ${rsvGuests.lastName}) LIKE ${like} ESCAPE '\\'`,
		sql`${rsvGuests.emailNorm} LIKE ${like} ESCAPE '\\'`,
	]
	const digits = query.replace(/\D/g, '')
	if (digits.length >= 3) {
		clauses.push(sql`${rsvGuests.phoneE164} LIKE ${`%${digits}%`}`)
	}
	return sql`(${sql.join(clauses, sql` OR `)})`
}

function tagPredicate(tagId: string): SQL {
	if (tagId === SYSTEM_GUEST_TAGS.first_visit.id) {
		return sql`${rsvGuests.visits} = 0`
	}
	if (tagId === SYSTEM_GUEST_TAGS.frequent_no_show.id) {
		return sql`${rsvGuests.noShows} >= ${FREQUENT_NO_SHOW_THRESHOLD}`
	}
	return sql`EXISTS (SELECT 1 FROM rsv_guest_tags gt WHERE gt.guest_id = ${rsvGuests.id} AND gt.tag_id = ${tagId})`
}

const SORT_SPECS: Record<
	GuestSort,
	{ expr: SQL; dir: 'asc' | 'desc'; text: boolean }
> = {
	updated: { expr: sql`${rsvGuests.updatedAt}`, dir: 'desc', text: false },
	name: {
		expr: sql`lower(${rsvGuests.lastName} || ' ' || ${rsvGuests.firstName})`,
		dir: 'asc',
		text: true,
	},
	visits: { expr: sql`${rsvGuests.visits}`, dir: 'desc', text: false },
	last_visit: {
		expr: sql`COALESCE(${rsvGuests.lastVisitAt}, 0)`,
		dir: 'desc',
		text: false,
	},
}

export async function listGuests(
	db: DbOrTx,
	input: {
		q?: string
		tagId?: string
		sort?: GuestSort
		cursor?: string
		limit?: number
		canReadSensitive?: boolean
	},
): Promise<{
	guests: Array<SerializedGuestSummary & { nextBookingAt: number | null }>
	nextCursor: string | null
	total: number
}> {
	const limit = Math.min(
		Math.max(input.limit ?? GUESTBOOK_PAGE_SIZE, 1),
		GUESTBOOK_PAGE_SIZE,
	)
	const spec = SORT_SPECS[input.sort ?? 'updated']
	const filters: SQL[] = [
		isNull(rsvGuests.mergedIntoId),
		isNull(rsvGuests.erasedAt),
	]
	const q = input.q?.trim()
	if (q) filters.push(searchPredicate(q))
	if (input.tagId) filters.push(tagPredicate(input.tagId))

	const totalRow = await db
		.select({ n: sql<number>`count(*)` })
		.from(rsvGuests)
		.where(and(...filters))
		.get()

	const cursor = decodeCursor(input.cursor)
	const pageFilters = [...filters]
	if (cursor) {
		const op = spec.dir === 'asc' ? sql`>` : sql`<`
		pageFilters.push(
			sql`(${spec.expr} ${op} ${cursor.v} OR (${spec.expr} = ${cursor.v} AND ${rsvGuests.id} > ${cursor.id}))`,
		)
	}
	const keyExpr = sql<string | number>`${spec.expr}`.as('sort_key')
	const rows = await db
		.select({ guest: rsvGuests, key: keyExpr })
		.from(rsvGuests)
		.where(and(...pageFilters))
		.orderBy(
			spec.dir === 'asc' ? asc(sql`${spec.expr}`) : desc(sql`${spec.expr}`),
			asc(rsvGuests.id),
		)
		.limit(limit + 1)
		.all()

	const page = rows.slice(0, limit)
	const last = page.at(-1)
	const nextCursor =
		rows.length > limit && last
			? encodeCursor({
					v: spec.text ? String(last.key) : Number(last.key),
					id: last.guest.id,
				})
			: null

	const canReadSensitive = input.canReadSensitive === true
	const tagsMap = await loadGuestTagsMap(
		db,
		page.map((r) => r.guest.id),
		{ canReadSensitive },
	)
	// The soonest upcoming booking per guest, so the list can show who is
	// coming next without opening each profile.
	const nextRows = await queryInChunks(
		page.map((r) => r.guest.id),
		(chunk) =>
			db
				.select({
					guestId: rsvReservations.guestId,
					nextAt: sql<number>`MIN(${rsvReservations.startAt})`,
				})
				.from(rsvReservations)
				.where(
					and(
						inArray(rsvReservations.guestId, chunk),
						gte(rsvReservations.startAt, Date.now()),
						inArray(rsvReservations.status, [
							'booked',
							'confirmed',
							'pending_payment',
						]),
					),
				)
				.groupBy(rsvReservations.guestId)
				.all(),
	)
	const nextByGuest = new Map(
		nextRows.map((r) => [r.guestId, Number(r.nextAt)]),
	)
	return {
		guests: page.map((r) => ({
			...serializeGuestRow(r.guest, tagsMap.get(r.guest.id) ?? [], {
				canReadSensitive,
			}),
			nextBookingAt: nextByGuest.get(r.guest.id) ?? null,
		})),
		nextCursor,
		total: Number(totalRow?.n ?? 0),
	}
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

export async function getGuestProfile(
	db: DbOrTx,
	guestId: string,
	opts: { canReadSensitive: boolean },
) {
	const base = await getGuestSummary(db, guestId, opts)
	const links = await db
		.select({
			customerId: rsvGuests.customerId,
			marketingCustomerId: rsvGuests.marketingCustomerId,
		})
		.from(rsvGuests)
		.where(eq(rsvGuests.id, guestId))
		.get()
	const marketing = await loadGuestMarketingConsent(db, links ?? null)
	const history = await db
		.select({
			id: rsvReservations.id,
			locationId: rsvReservations.locationId,
			businessDate: rsvReservations.businessDate,
			localStartMin: rsvReservations.localStartMin,
			partySize: rsvReservations.partySize,
			coversActual: rsvReservations.coversActual,
			status: rsvReservations.status,
			channel: rsvReservations.channel,
			lateCancel: rsvReservations.lateCancel,
			cancelledBy: rsvReservations.cancelledBy,
			startAt: rsvReservations.startAt,
			endAt: rsvReservations.endAt,
			serviceName: rsvServices.name,
			guestRequests: rsvReservations.guestRequests,
			dietaryNotes: rsvReservations.dietaryNotes,
		})
		.from(rsvReservations)
		.leftJoin(rsvServices, eq(rsvReservations.serviceId, rsvServices.id))
		.where(eq(rsvReservations.guestId, guestId))
		.orderBy(desc(rsvReservations.startAt))
		.limit(200)
		.all()
	return {
		guest: base.guest,
		notes: base.notes,
		pinnedNotes: base.pinnedNotes,
		/** Marketing consent from the linked customer's subscriptions; null when unlinked. */
		marketing,
		reservations: history.map((r) => ({
			...r,
			guestRequests: opts.canReadSensitive ? r.guestRequests : null,
			dietaryNotes: opts.canReadSensitive ? r.dietaryNotes : null,
		})),
	}
}

export async function updateGuestProfile(
	db: TenantDatabase,
	guestId: string,
	input: {
		expectedVersion: number
		firstName?: string
		lastName?: string
		phone?: string | null
		email?: string | null
		locale?: string
		allergyNotes?: string | null
		actorId: string
	},
) {
	return withSetupWrite(db, async (tx) => {
		const row = await tx
			.select()
			.from(rsvGuests)
			.where(eq(rsvGuests.id, guestId))
			.get()
		if (!row) throw notFound('Guest not found')
		if (row.erasedAt) throw conflict('guest_erased', 'This guest was erased')
		if (row.mergedIntoId) {
			throw conflict('guest_merged', 'This guest was merged into another', {
				mergedIntoId: row.mergedIntoId,
			})
		}
		if (row.version !== input.expectedVersion) {
			throw conflict('stale_version', 'The guest changed since it was loaded', {
				currentVersion: row.version,
			})
		}
		const patch: Partial<typeof rsvGuests.$inferInsert> = {}
		if (input.firstName !== undefined) {
			const first = input.firstName.trim()
			if (!first) throw badRequest('invalid_guest', 'First name is required')
			patch.firstName = first
		}
		if (input.lastName !== undefined) patch.lastName = input.lastName.trim()
		if (input.phone !== undefined) {
			patch.phoneE164 = normalizeGuestPhone(input.phone)
		}
		if (input.email !== undefined) {
			patch.emailNorm = normalizeGuestEmail(input.email)
		}
		if (input.locale !== undefined) patch.locale = input.locale.trim()
		if (input.allergyNotes !== undefined) {
			patch.allergyNotes = input.allergyNotes?.trim() || null
		}
		const now = Date.now()
		// The link to a customer is the verified phone: when the guest's phone
		// changes it stops holding unless it still equals that customer's phone.
		if (
			patch.phoneE164 !== undefined &&
			patch.phoneE164 !== row.phoneE164 &&
			row.customerId
		) {
			const customer = await tx
				.select({ phone: customers.phone, verified: customers.phoneVerified })
				.from(customers)
				.where(eq(customers.id, row.customerId))
				.get()
			if (
				!customer ||
				!customer.verified ||
				customer.phone !== patch.phoneE164
			) {
				patch.customerId = null
			}
		}
		const updated = await tx
			.update(rsvGuests)
			.set({ ...patch, updatedAt: now, version: row.version + 1 })
			.where(and(eq(rsvGuests.id, guestId), eq(rsvGuests.version, row.version)))
			.returning({ id: rsvGuests.id })
		if (updated.length === 0) {
			throw conflict('stale_version', 'The guest changed since it was loaded')
		}
		if (
			patch.phoneE164 &&
			!(patch.customerId === undefined && row.customerId)
		) {
			await linkGuestToVerifiedCustomer(
				tx,
				{
					id: guestId,
					customerId: null,
					phoneE164: patch.phoneE164,
					erasedAt: null,
					mergedIntoId: null,
				},
				now,
			)
		}
		await tx.insert(rsvAuditLog).values({
			id: createId('aud'),
			at: now,
			actorKind: 'operator',
			actorId: input.actorId,
			action: 'guest.update',
			entityType: 'guest',
			entityId: guestId,
			changes: { fields: Object.keys(patch) },
		})
		const next = await tx
			.select()
			.from(rsvGuests)
			.where(eq(rsvGuests.id, guestId))
			.get()
		// Only holders of the guest-write grant reach this, so they may read it all.
		const tagsMap = await loadGuestTagsMap(tx, [guestId], {
			canReadSensitive: true,
		})
		return serializeGuestRow(next!, tagsMap.get(guestId) ?? [], {
			canReadSensitive: true,
		})
	})
}

// ---------------------------------------------------------------------------
// Tags on a guest
// ---------------------------------------------------------------------------

async function loadLiveGuest(db: DbOrTx, guestId: string) {
	const row = await db
		.select()
		.from(rsvGuests)
		.where(eq(rsvGuests.id, guestId))
		.get()
	if (!row) throw notFound('Guest not found')
	if (row.erasedAt) throw conflict('guest_erased', 'This guest was erased')
	if (row.mergedIntoId) {
		throw conflict('guest_merged', 'This guest was merged into another', {
			mergedIntoId: row.mergedIntoId,
		})
	}
	return row
}

async function touchGuest(db: DbOrTx, guestId: string, now: number) {
	await db
		.update(rsvGuests)
		.set({ updatedAt: now })
		.where(eq(rsvGuests.id, guestId))
}

export async function assignGuestTag(
	db: TenantDatabase,
	guestId: string,
	tagId: string,
): Promise<SerializedGuestTag[]> {
	return withSetupWrite(db, async (tx) => {
		await loadLiveGuest(tx, guestId)
		const tag = await tx
			.select()
			.from(rsvTags)
			.where(eq(rsvTags.id, tagId))
			.get()
		if (!tag || tag.scope !== 'guest' || tag.archivedAt !== null) {
			throw notFound('Tag not found')
		}
		if (tag.systemKey !== null || isSystemGuestTagId(tag.id)) {
			throw badRequest(
				'system_tag',
				'System tags are derived from visit history and cannot be assigned',
			)
		}
		await tx
			.insert(rsvGuestTags)
			.values({ guestId, tagId })
			.onConflictDoNothing()
		await touchGuest(tx, guestId, Date.now())
		const map = await loadGuestTagsMap(tx, [guestId])
		return map.get(guestId) ?? []
	})
}

export async function removeGuestTag(
	db: TenantDatabase,
	guestId: string,
	tagId: string,
): Promise<SerializedGuestTag[]> {
	return withSetupWrite(db, async (tx) => {
		await loadLiveGuest(tx, guestId)
		if (isSystemGuestTagId(tagId)) {
			throw badRequest(
				'system_tag',
				'System tags are derived from visit history and cannot be removed',
			)
		}
		const tag = await tx
			.select({ systemKey: rsvTags.systemKey })
			.from(rsvTags)
			.where(eq(rsvTags.id, tagId))
			.get()
		if (tag?.systemKey) {
			throw badRequest(
				'system_tag',
				'System tags are derived from visit history and cannot be removed',
			)
		}
		const removed = await tx
			.delete(rsvGuestTags)
			.where(
				and(eq(rsvGuestTags.guestId, guestId), eq(rsvGuestTags.tagId, tagId)),
			)
			.returning({ tagId: rsvGuestTags.tagId })
		if (removed.length === 0) throw notFound('Tag is not on this guest')
		await touchGuest(tx, guestId, Date.now())
		const map = await loadGuestTagsMap(tx, [guestId])
		return map.get(guestId) ?? []
	})
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

function serializeNote(row: typeof rsvGuestNotes.$inferSelect) {
	return {
		id: row.id,
		guestId: row.guestId,
		body: row.body,
		pinned: row.pinned,
		authorId: row.authorId,
		createdAt: row.createdAt,
	}
}

export async function addGuestNote(
	db: TenantDatabase,
	guestId: string,
	input: { body: string; pinned?: boolean; actorId: string },
) {
	const body = input.body.trim()
	if (!body) throw badRequest('invalid_note', 'Note text is required')
	return withSetupWrite(db, async (tx) => {
		await loadLiveGuest(tx, guestId)
		const now = Date.now()
		const id = createId('gnote')
		await tx.insert(rsvGuestNotes).values({
			id,
			guestId,
			body,
			pinned: input.pinned ?? false,
			authorId: input.actorId,
			createdAt: now,
		})
		await touchGuest(tx, guestId, now)
		const row = await tx
			.select()
			.from(rsvGuestNotes)
			.where(eq(rsvGuestNotes.id, id))
			.get()
		return serializeNote(row!)
	})
}

async function loadLiveNote(db: DbOrTx, guestId: string, noteId: string) {
	const row = await db
		.select()
		.from(rsvGuestNotes)
		.where(
			and(
				eq(rsvGuestNotes.id, noteId),
				eq(rsvGuestNotes.guestId, guestId),
				isNull(rsvGuestNotes.deletedAt),
			),
		)
		.get()
	if (!row) throw notFound('Note not found')
	return row
}

export async function updateGuestNote(
	db: TenantDatabase,
	guestId: string,
	noteId: string,
	input: { body?: string; pinned?: boolean },
) {
	return withSetupWrite(db, async (tx) => {
		await loadLiveGuest(tx, guestId)
		const note = await loadLiveNote(tx, guestId, noteId)
		const patch: Partial<typeof rsvGuestNotes.$inferInsert> = {}
		if (input.body !== undefined) {
			const body = input.body.trim()
			if (!body) throw badRequest('invalid_note', 'Note text is required')
			patch.body = body
		}
		if (input.pinned !== undefined) patch.pinned = input.pinned
		if (Object.keys(patch).length > 0) {
			await tx
				.update(rsvGuestNotes)
				.set(patch)
				.where(eq(rsvGuestNotes.id, note.id))
			await touchGuest(tx, guestId, Date.now())
		}
		const next = await tx
			.select()
			.from(rsvGuestNotes)
			.where(eq(rsvGuestNotes.id, note.id))
			.get()
		return serializeNote(next!)
	})
}

export async function deleteGuestNote(
	db: TenantDatabase,
	guestId: string,
	noteId: string,
) {
	return withSetupWrite(db, async (tx) => {
		await loadLiveGuest(tx, guestId)
		const note = await loadLiveNote(tx, guestId, noteId)
		const now = Date.now()
		await tx
			.update(rsvGuestNotes)
			.set({ deletedAt: now, pinned: false })
			.where(eq(rsvGuestNotes.id, note.id))
		await touchGuest(tx, guestId, now)
		return { deleted: true as const, id: note.id }
	})
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

export type MergeExpectedVersions = Record<string, number>

function expectedVersionFor(
	versions: MergeExpectedVersions | undefined,
	role: 'keep' | 'merge',
	guestId: string,
): number | undefined {
	if (!versions) return undefined
	const aliases =
		role === 'keep'
			? ['keep', 'kept', 'keepId', 'keptId', 'keepGuest']
			: ['merge', 'merged', 'mergeId', 'mergedId', 'mergeGuest']
	for (const key of [guestId, ...aliases]) {
		const value = versions[key]
		if (typeof value === 'number') return value
	}
	return undefined
}

export async function mergeGuests(
	db: TenantDatabase,
	input: {
		keepId: string
		mergeId: string
		expectedVersions?: MergeExpectedVersions
		actorId: string
	},
) {
	if (input.keepId === input.mergeId) {
		throw badRequest('invalid_merge', 'Choose two different guests to merge')
	}
	return withSetupWrite(db, async (tx) => {
		const keep = await tx
			.select()
			.from(rsvGuests)
			.where(eq(rsvGuests.id, input.keepId))
			.get()
		const merged = await tx
			.select()
			.from(rsvGuests)
			.where(eq(rsvGuests.id, input.mergeId))
			.get()
		if (!keep || !merged) throw notFound('Guest not found')
		for (const row of [keep, merged]) {
			if (row.erasedAt) {
				throw conflict('guest_erased', 'An erased guest cannot be merged')
			}
			if (row.mergedIntoId) {
				throw conflict(
					'already_merged',
					'This guest was already merged into another guest',
					{ guestId: row.id, mergedIntoId: row.mergedIntoId },
				)
			}
		}
		// Two people with a verified sign-in each are never silently joined: the
		// merged guest's customer link would be dropped and that customer would
		// become unrelated to the survivor.
		if (
			keep.customerId !== null &&
			merged.customerId !== null &&
			keep.customerId !== merged.customerId
		) {
			throw conflict(
				'merge_conflicting_customers',
				'Both guests are linked to different customers and cannot be merged',
			)
		}
		const keepExpected = expectedVersionFor(
			input.expectedVersions,
			'keep',
			keep.id,
		)
		const mergeExpected = expectedVersionFor(
			input.expectedVersions,
			'merge',
			merged.id,
		)
		if (
			(keepExpected !== undefined && keepExpected !== keep.version) ||
			(mergeExpected !== undefined && mergeExpected !== merged.version)
		) {
			throw conflict('stale_version', 'A guest changed since it was loaded', {
				currentVersions: { keep: keep.version, merge: merged.version },
			})
		}

		const now = Date.now()
		const moved = await tx
			.select({
				id: rsvReservations.id,
				locationId: rsvReservations.locationId,
				businessDate: rsvReservations.businessDate,
			})
			.from(rsvReservations)
			.where(eq(rsvReservations.guestId, merged.id))
			.all()

		if (moved.length > 0) {
			await tx
				.update(rsvReservations)
				.set({ guestId: keep.id })
				.where(eq(rsvReservations.guestId, merged.id))
			for (const r of moved) {
				await tx.insert(rsvReservationEvents).values({
					id: createId('rev'),
					reservationId: r.id,
					at: now,
					actorKind: 'operator',
					actorId: input.actorId,
					type: 'merged_guest',
					data: { keptGuestId: keep.id, mergedGuestId: merged.id },
				})
			}
			const dayKeys = new Set(
				moved.map((r) => `${r.locationId}::${r.businessDate}`),
			)
			for (const key of dayKeys) {
				const [locationId, businessDate] = key.split('::')
				await tx
					.insert(rsvDayVersions)
					.values({
						locationId: locationId!,
						businessDate: businessDate!,
						version: 1,
						updatedAt: now,
					})
					.onConflictDoUpdate({
						target: [rsvDayVersions.locationId, rsvDayVersions.businessDate],
						set: {
							version: sql`${rsvDayVersions.version} + 1`,
							updatedAt: now,
						},
					})
			}
		}

		const waitlistMoved = await tx
			.update(rsvWaitlistEntries)
			.set({ guestId: keep.id })
			.where(eq(rsvWaitlistEntries.guestId, merged.id))
			.returning({ id: rsvWaitlistEntries.id })
		await tx
			.update(rsvNotifyRequests)
			.set({ guestId: keep.id })
			.where(eq(rsvNotifyRequests.guestId, merged.id))

		const mergedTagRows = await tx
			.select({ tagId: rsvGuestTags.tagId })
			.from(rsvGuestTags)
			.where(eq(rsvGuestTags.guestId, merged.id))
			.all()
		for (const t of mergedTagRows) {
			await tx
				.insert(rsvGuestTags)
				.values({ guestId: keep.id, tagId: t.tagId })
				.onConflictDoNothing()
		}
		await tx.delete(rsvGuestTags).where(eq(rsvGuestTags.guestId, merged.id))

		const notesMoved = await tx
			.update(rsvGuestNotes)
			.set({ guestId: keep.id })
			.where(eq(rsvGuestNotes.guestId, merged.id))
			.returning({ id: rsvGuestNotes.id })

		// The unique customer link must be released before the survivor can take it.
		const takeCustomer = keep.customerId === null && merged.customerId !== null
		if (merged.customerId !== null) {
			await tx
				.update(rsvGuests)
				.set({ customerId: null })
				.where(eq(rsvGuests.id, merged.id))
		}

		const firstCandidates = [keep.firstVisitAt, merged.firstVisitAt].filter(
			(v): v is number => v !== null,
		)
		const lastCandidates = [keep.lastVisitAt, merged.lastVisitAt].filter(
			(v): v is number => v !== null,
		)
		await tx
			.update(rsvGuests)
			.set({
				visits: keep.visits + merged.visits,
				covers: keep.covers + merged.covers,
				noShows: keep.noShows + merged.noShows,
				lateCancels: keep.lateCancels + merged.lateCancels,
				cancels: keep.cancels + merged.cancels,
				firstVisitAt: firstCandidates.length
					? Math.min(...firstCandidates)
					: null,
				lastVisitAt: lastCandidates.length ? Math.max(...lastCandidates) : null,
				phoneE164: keep.phoneE164 ?? merged.phoneE164,
				emailNorm: keep.emailNorm ?? merged.emailNorm,
				allergyNotes: keep.allergyNotes ?? merged.allergyNotes,
				...(takeCustomer ? { customerId: merged.customerId } : {}),
				marketingCustomerId:
					keep.marketingCustomerId ?? merged.marketingCustomerId,
				updatedAt: now,
				version: keep.version + 1,
			})
			.where(eq(rsvGuests.id, keep.id))
		await tx
			.update(rsvGuests)
			.set({
				mergedIntoId: keep.id,
				marketingCustomerId: null,
				updatedAt: now,
				version: merged.version + 1,
			})
			.where(eq(rsvGuests.id, merged.id))

		const movedCounts = {
			reservations: moved.length,
			notes: notesMoved.length,
			tags: mergedTagRows.length,
			waitlistEntries: waitlistMoved.length,
		}
		await tx.insert(rsvGuestMerges).values({
			id: createId('gmerge'),
			keptGuestId: keep.id,
			mergedGuestId: merged.id,
			actorId: input.actorId,
			at: now,
			movedCounts,
		})
		await tx.insert(rsvAuditLog).values({
			id: createId('aud'),
			at: now,
			actorKind: 'operator',
			actorId: input.actorId,
			action: 'guest.merge',
			entityType: 'guest',
			entityId: keep.id,
			changes: { mergedGuestId: merged.id, movedCounts },
		})

		const next = await tx
			.select()
			.from(rsvGuests)
			.where(eq(rsvGuests.id, keep.id))
			.get()
		const tagsMap = await loadGuestTagsMap(tx, [keep.id], {
			canReadSensitive: true,
		})
		return {
			guest: serializeGuestRow(next!, tagsMap.get(keep.id) ?? [], {
				canReadSensitive: true,
			}),
			movedCounts,
		}
	})
}

// ---------------------------------------------------------------------------
// Counter repair
// ---------------------------------------------------------------------------

const RECONCILE_WINDOW_MS = 2 * 24 * 60 * 60 * 1000
const RECONCILE_BATCH = 500

/**
 * Recomputes the denormalized guest counters from the reservations of guests
 * touched recently, so a missed or doubled increment heals itself. Merged and
 * erased guests are skipped: their history lives on the survivor or is gone.
 */
export async function reconcileGuestCounters(
	db: TenantDatabase,
	now: number,
	opts?: { guestIds?: string[]; windowMs?: number },
): Promise<{ checked: number; repaired: number }> {
	const since = now - (opts?.windowMs ?? RECONCILE_WINDOW_MS)
	let ids: string[]
	if (opts?.guestIds) {
		ids = opts.guestIds
	} else {
		const touched = await db
			.select({ id: rsvGuests.id })
			.from(rsvGuests)
			.where(
				and(
					isNull(rsvGuests.mergedIntoId),
					isNull(rsvGuests.erasedAt),
					// Only real status transitions count as touching: seeded or imported
					// guests keep their stored history until something actually changes.
					sql`EXISTS (SELECT 1 FROM rsv_reservations r JOIN rsv_reservation_events e ON e.reservation_id = r.id WHERE r.guest_id = ${rsvGuests.id} AND e.at >= ${since} AND e.type IN ('finished', 'no_show', 'cancelled', 'status_undo', 'merged_guest'))`,
				),
			)
			.limit(RECONCILE_BATCH)
			.all()
		ids = touched.map((r) => r.id)
	}
	if (ids.length === 0) return { checked: 0, repaired: 0 }

	const stats = await queryInChunks(ids, (chunk) =>
		db
			.select({
				guestId: rsvReservations.guestId,
				visits: sql<number>`SUM(CASE WHEN ${rsvReservations.status} = 'finished' THEN 1 ELSE 0 END)`,
				covers: sql<number>`SUM(CASE WHEN ${rsvReservations.status} = 'finished' THEN COALESCE(${rsvReservations.coversActual}, ${rsvReservations.seatedCovers}, ${rsvReservations.partySize}) ELSE 0 END)`,
				noShows: sql<number>`SUM(CASE WHEN ${rsvReservations.status} = 'no_show' THEN 1 ELSE 0 END)`,
				cancels: sql<number>`SUM(CASE WHEN ${rsvReservations.status} = 'cancelled' AND COALESCE(${rsvReservations.cancelReason}, '') <> 'guest_erased' THEN 1 ELSE 0 END)`,
				lateCancels: sql<number>`SUM(CASE WHEN ${rsvReservations.status} = 'cancelled' AND ${rsvReservations.lateCancel} = 1 AND COALESCE(${rsvReservations.cancelReason}, '') <> 'guest_erased' THEN 1 ELSE 0 END)`,
				firstVisitAt: sql<
					number | null
				>`MIN(CASE WHEN ${rsvReservations.status} = 'finished' THEN ${rsvReservations.finishedAt} END)`,
				lastVisitAt: sql<
					number | null
				>`MAX(CASE WHEN ${rsvReservations.status} = 'finished' THEN ${rsvReservations.finishedAt} END)`,
			})
			.from(rsvReservations)
			.where(inArray(rsvReservations.guestId, chunk))
			.groupBy(rsvReservations.guestId)
			.all(),
	)
	const byGuest = new Map(stats.map((s) => [s.guestId, s]))

	const guests = await queryInChunks(ids, (chunk) =>
		db.select().from(rsvGuests).where(inArray(rsvGuests.id, chunk)).all(),
	)
	let repaired = 0
	for (const guest of guests) {
		if (guest.mergedIntoId || guest.erasedAt) continue
		const s = byGuest.get(guest.id)
		const next = {
			visits: Number(s?.visits ?? 0),
			covers: Number(s?.covers ?? 0),
			noShows: Number(s?.noShows ?? 0),
			cancels: Number(s?.cancels ?? 0),
			lateCancels: Number(s?.lateCancels ?? 0),
			firstVisitAt: s?.firstVisitAt ?? null,
			lastVisitAt: s?.lastVisitAt ?? null,
		}
		const same =
			guest.visits === next.visits &&
			guest.covers === next.covers &&
			guest.noShows === next.noShows &&
			guest.cancels === next.cancels &&
			guest.lateCancels === next.lateCancels &&
			guest.firstVisitAt === next.firstVisitAt &&
			guest.lastVisitAt === next.lastVisitAt
		if (same) continue
		// updatedAt stays put: repairing must not make a guest look touched again.
		await db.update(rsvGuests).set(next).where(eq(rsvGuests.id, guest.id))
		repaired += 1
	}
	return { checked: guests.length, repaired }
}

export { deriveSystemTagKeys }
