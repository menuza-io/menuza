import { type ReservationsScopedClient } from '#app/utils/reservations/reservations-client.ts'

const GUESTS_BASE = '/operator/reservations/guests'

export const GUEST_PAGE_SIZE = 50

export const GUEST_SORTS = ['updated', 'name', 'visits', 'last_visit'] as const
export type GuestSort = (typeof GUEST_SORTS)[number]

export type GuestTag = {
	id: string
	name: string
	category: string
	colorToken: string
	sensitive: boolean
	/** Derived from counters; never set or removed by hand. */
	system: boolean
}

export type GuestRow = {
	id: string
	firstName: string
	lastName: string
	name: string
	phone: string | null
	email: string | null
	locale: string
	allergyNotes: string | null
	hasAllergy: boolean
	visits: number
	covers: number
	noShows: number
	cancels: number
	lateCancels: number
	firstVisitAt: number | null
	lastVisitAt: number | null
	/** Soonest upcoming booking (list rows only; null when none or unknown). */
	nextBookingAt: number | null
	erasedAt: number | null
	customerLinked: boolean
	version: number
	tags: GuestTag[]
}

export type GuestNote = {
	id: string
	body: string
	pinned: boolean
	createdAt: number
}

export type GuestVisit = {
	id: string
	locationId: string
	businessDate: string
	localStartMin: number
	partySize: number
	status: string
	channel: string
	lateCancel: boolean
	serviceName: string | null
}

export type GuestProfile = {
	guest: GuestRow
	notes: GuestNote[]
	pinnedNotes: Array<{ id: string; body: string }>
	visits: GuestVisit[]
}

export type GuestPage = {
	guests: GuestRow[]
	nextCursor: string | null
	total: number
}

type Raw = Record<string, unknown>

const str = (value: unknown, fallback = ''): string =>
	typeof value === 'string' ? value : fallback
const num = (value: unknown, fallback = 0): number =>
	typeof value === 'number' && Number.isFinite(value) ? value : fallback
const nullableNum = (value: unknown): number | null =>
	typeof value === 'number' && Number.isFinite(value) ? value : null
const nullableStr = (value: unknown): string | null =>
	typeof value === 'string' ? value : null

function asRecord(value: unknown): Raw {
	return value && typeof value === 'object' ? (value as Raw) : {}
}

export function normalizeGuestTag(raw: unknown): GuestTag {
	const r = asRecord(raw)
	return {
		id: str(r.id),
		name: str(r.name),
		category: str(r.category, 'general'),
		colorToken: str(r.colorToken, 'slate'),
		sensitive: Boolean(r.sensitive),
		system: r.category === 'system' || typeof r.systemKey === 'string',
	}
}

export function normalizeGuestRow(raw: unknown): GuestRow {
	const r = asRecord(raw)
	const firstName = str(r.firstName)
	const lastName = str(r.lastName)
	return {
		id: str(r.id),
		firstName,
		lastName,
		name: str(r.name) || `${firstName} ${lastName}`.trim(),
		phone: nullableStr(r.phoneE164) ?? nullableStr(r.phone),
		email: nullableStr(r.email) ?? nullableStr(r.emailNorm),
		locale: str(r.locale, 'en'),
		allergyNotes: nullableStr(r.allergyNotes),
		hasAllergy: Boolean(r.hasAllergy),
		visits: num(r.visits),
		covers: num(r.covers),
		noShows: num(r.noShows),
		cancels: num(r.cancels),
		lateCancels: num(r.lateCancels),
		firstVisitAt: nullableNum(r.firstVisitAt),
		lastVisitAt: nullableNum(r.lastVisitAt),
		nextBookingAt: nullableNum(r.nextBookingAt),
		erasedAt: nullableNum(r.erasedAt),
		customerLinked: Boolean(r.customerLinked),
		version: num(r.version, 1),
		tags: (Array.isArray(r.tags) ? r.tags : []).map(normalizeGuestTag),
	}
}

export function normalizeGuestNote(raw: unknown): GuestNote {
	const r = asRecord(raw)
	return {
		id: str(r.id),
		body: str(r.body),
		pinned: Boolean(r.pinned),
		createdAt: num(r.createdAt),
	}
}

function normalizeVisit(raw: unknown): GuestVisit {
	const r = asRecord(raw)
	return {
		id: str(r.id),
		locationId: str(r.locationId),
		businessDate: str(r.businessDate),
		localStartMin: num(r.localStartMin),
		partySize: num(r.partySize),
		status: str(r.status),
		channel: str(r.channel),
		lateCancel: Boolean(r.lateCancel),
		serviceName: nullableStr(r.serviceName),
	}
}

export function normalizeGuestProfile(raw: unknown): GuestProfile {
	const r = asRecord(raw)
	return {
		guest: normalizeGuestRow(r.guest),
		notes: (Array.isArray(r.notes) ? r.notes : []).map(normalizeGuestNote),
		pinnedNotes: (Array.isArray(r.pinnedNotes) ? r.pinnedNotes : []).map(
			(n) => ({ id: str(asRecord(n).id), body: str(asRecord(n).body) }),
		),
		visits: (Array.isArray(r.reservations) ? r.reservations : []).map(
			normalizeVisit,
		),
	}
}

export async function fetchGuestPage(
	client: ReservationsScopedClient,
	params: {
		q?: string
		tagId?: string | null
		sort?: GuestSort
		cursor?: string | null
	},
	signal?: AbortSignal,
): Promise<GuestPage> {
	const raw = asRecord(
		await client.request<unknown>(GUESTS_BASE, {
			query: {
				q: params.q?.trim() || undefined,
				tag: params.tagId || undefined,
				sort: params.sort,
				cursor: params.cursor || undefined,
				limit: GUEST_PAGE_SIZE,
			},
			signal,
		}),
	)
	return {
		guests: (Array.isArray(raw.guests) ? raw.guests : []).map(
			normalizeGuestRow,
		),
		nextCursor: nullableStr(raw.nextCursor),
		total: num(raw.total),
	}
}

export async function fetchGuestTags(
	client: ReservationsScopedClient,
	signal?: AbortSignal,
): Promise<GuestTag[]> {
	const raw = asRecord(
		await client.request<unknown>(`${GUESTS_BASE}/tags`, { signal }),
	)
	return (Array.isArray(raw.tags) ? raw.tags : []).map(normalizeGuestTag)
}

export async function createGuestTag(
	client: ReservationsScopedClient,
	input: { name: string; category?: string },
): Promise<GuestTag> {
	const raw = asRecord(
		await client.request<unknown>(`${GUESTS_BASE}/tags`, {
			method: 'POST',
			body: { name: input.name.trim(), category: input.category },
		}),
	)
	return normalizeGuestTag(raw.tag)
}

export async function fetchGuestProfile(
	client: ReservationsScopedClient,
	guestId: string,
	signal?: AbortSignal,
): Promise<GuestProfile> {
	return normalizeGuestProfile(
		await client.request<unknown>(
			`${GUESTS_BASE}/${encodeURIComponent(guestId)}`,
			{ signal },
		),
	)
}

export type GuestProfilePatch = {
	expectedVersion: number
	firstName?: string
	lastName?: string
	phone?: string | null
	email?: string | null
	allergyNotes?: string | null
}

export async function updateGuestProfile(
	client: ReservationsScopedClient,
	guestId: string,
	patch: GuestProfilePatch,
): Promise<GuestRow> {
	const raw = asRecord(
		await client.request<unknown>(
			`${GUESTS_BASE}/${encodeURIComponent(guestId)}`,
			{ method: 'PATCH', body: patch },
		),
	)
	return normalizeGuestRow(raw.guest)
}

export async function assignGuestTag(
	client: ReservationsScopedClient,
	guestId: string,
	tagId: string,
): Promise<void> {
	await client.request<unknown>(
		`${GUESTS_BASE}/${encodeURIComponent(guestId)}/tags`,
		{ method: 'POST', body: { tagId } },
	)
}

export async function removeGuestTag(
	client: ReservationsScopedClient,
	guestId: string,
	tagId: string,
): Promise<void> {
	await client.request<unknown>(
		`${GUESTS_BASE}/${encodeURIComponent(guestId)}/tags/${encodeURIComponent(tagId)}`,
		{ method: 'DELETE' },
	)
}

export async function addGuestNote(
	client: ReservationsScopedClient,
	guestId: string,
	input: { body: string; pinned?: boolean },
): Promise<GuestNote> {
	const raw = asRecord(
		await client.request<unknown>(
			`${GUESTS_BASE}/${encodeURIComponent(guestId)}/notes`,
			{ method: 'POST', body: input },
		),
	)
	return normalizeGuestNote(raw.note)
}

export async function updateGuestNote(
	client: ReservationsScopedClient,
	guestId: string,
	noteId: string,
	patch: { body?: string; pinned?: boolean },
): Promise<GuestNote> {
	const raw = asRecord(
		await client.request<unknown>(
			`${GUESTS_BASE}/${encodeURIComponent(guestId)}/notes/${encodeURIComponent(noteId)}`,
			{ method: 'PATCH', body: patch },
		),
	)
	return normalizeGuestNote(raw.note)
}

export async function deleteGuestNote(
	client: ReservationsScopedClient,
	guestId: string,
	noteId: string,
): Promise<void> {
	await client.request<unknown>(
		`${GUESTS_BASE}/${encodeURIComponent(guestId)}/notes/${encodeURIComponent(noteId)}`,
		{ method: 'DELETE' },
	)
}

export async function mergeGuests(
	client: ReservationsScopedClient,
	input: {
		keepId: string
		mergeId: string
		keepVersion: number
		mergeVersion: number
	},
): Promise<GuestRow> {
	const raw = asRecord(
		await client.request<unknown>(`${GUESTS_BASE}/merge`, {
			method: 'POST',
			body: {
				keepId: input.keepId,
				mergeId: input.mergeId,
				expectedVersions: {
					[input.keepId]: input.keepVersion,
					[input.mergeId]: input.mergeVersion,
				},
			},
		}),
	)
	return normalizeGuestRow(raw.guest)
}

export async function exportGuest(
	client: ReservationsScopedClient,
	guestId: string,
	includeSensitive: boolean,
): Promise<unknown> {
	return client.request<unknown>(
		`${GUESTS_BASE}/${encodeURIComponent(guestId)}/export`,
		{ query: { includeSensitive: includeSensitive ? '1' : undefined } },
	)
}

export async function eraseGuest(
	client: ReservationsScopedClient,
	guestId: string,
): Promise<void> {
	await client.request<unknown>(
		`${GUESTS_BASE}/${encodeURIComponent(guestId)}/erase`,
		{
			method: 'POST',
			body: {},
		},
	)
}
