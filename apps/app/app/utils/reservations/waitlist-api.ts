import {
	ACTIVE_WAITLIST_STATUSES,
	WAITLIST_STATUSES,
	waitlistEntryChangeResponseSchema,
	waitlistEntryResponseSchema,
	waitlistEntrySchema,
	waitlistListingSchema,
	waitlistQuoteSchema,
	type WaitlistEntry,
	type WaitlistListing,
	type WaitlistQuote,
	type WaitlistSeatResolution,
	type WaitlistStatus,
	type WaitlistStatusTarget,
} from '@repo/reservations'
import { z } from 'zod'
import {
	generateIdempotencyKey,
	normalizeReservationView,
	type DayReservationView,
} from '#app/utils/reservations/book-api.ts'
import {
	type ReservationsConditionalResult,
	type ReservationsScopedClient,
} from '#app/utils/reservations/reservations-client.ts'

const WAITLIST_BASE = '/operator/reservations/book/waitlist'
const SETUP_BASE = '/operator/reservations/setup'

export type { WaitlistStatus, WaitlistStatusTarget }
export {
	ACTIVE_WAITLIST_STATUSES,
	WAITLIST_STATUSES,
	waitlistEntrySchema,
	waitlistListingSchema,
	waitlistQuoteSchema,
}
export type { WaitlistEntry, WaitlistListing, WaitlistQuote }

const entryEnvelopeSchema = waitlistEntryResponseSchema
const entryChangeSchema = waitlistEntryChangeResponseSchema

export type WaitlistEntryChange = { entry: WaitlistEntry; changed: boolean }

export function fetchWaitlist(
	client: ReservationsScopedClient,
	params: { locationId: string; date?: string },
	etag?: string | null,
	signal?: AbortSignal,
): Promise<ReservationsConditionalResult<WaitlistListing>> {
	return client
		.requestConditional<unknown>(WAITLIST_BASE, {
			query: { locationId: params.locationId, date: params.date },
			ifNoneMatch: etag,
			signal,
		})
		.then((res) =>
			res.status === 304
				? res
				: {
						status: 200 as const,
						data: waitlistListingSchema.parse(res.data),
						etag: res.etag,
					},
		)
}

export async function fetchWaitlistQuote(
	client: ReservationsScopedClient,
	params: { locationId: string; partySize: number; areaId?: string | null },
	signal?: AbortSignal,
): Promise<WaitlistQuote> {
	const raw = await client.request<unknown>(`${WAITLIST_BASE}/quote`, {
		query: {
			locationId: params.locationId,
			partySize: params.partySize,
			areaId: params.areaId ?? undefined,
		},
		signal,
	})
	return waitlistQuoteSchema.parse(raw)
}

export type AddWaitlistEntryInput = {
	locationId: string
	displayName: string
	partySize: number
	phone?: string | null
	email?: string | null
	smsOptIn?: boolean
	areaPrefId?: string | null
	notes?: string | null
}

export async function addWaitlistEntry(
	client: ReservationsScopedClient,
	input: AddWaitlistEntryInput,
	idempotencyKey = generateIdempotencyKey('wl'),
): Promise<WaitlistEntry> {
	const raw = await client.request<unknown>(WAITLIST_BASE, {
		method: 'POST',
		headers: { 'Idempotency-Key': idempotencyKey },
		body: {
			locationId: input.locationId,
			displayName: input.displayName,
			partySize: input.partySize,
			phone: input.phone || null,
			email: input.email || null,
			smsOptIn: Boolean(input.smsOptIn && input.phone),
			areaPrefId: input.areaPrefId || null,
			notes: input.notes || null,
		},
	})
	return entryEnvelopeSchema.parse(raw).entry
}

export type UpdateWaitlistEntryPatch = {
	expectedVersion: number
	displayName?: string
	partySize?: number
	phone?: string | null
	smsOptIn?: boolean
	areaPrefId?: string | null
	notes?: string | null
}

export async function updateWaitlistEntry(
	client: ReservationsScopedClient,
	entryId: string,
	patch: UpdateWaitlistEntryPatch,
): Promise<WaitlistEntry> {
	const raw = await client.request<unknown>(
		`${WAITLIST_BASE}/${encodeURIComponent(entryId)}`,
		{ method: 'PATCH', body: patch },
	)
	return entryEnvelopeSchema.parse(raw).entry
}

export async function notifyWaitlistEntry(
	client: ReservationsScopedClient,
	entryId: string,
	expectedVersion: number,
): Promise<WaitlistEntryChange> {
	const raw = await client.request<unknown>(
		`${WAITLIST_BASE}/${encodeURIComponent(entryId)}/notify`,
		{ method: 'POST', body: { expectedVersion } },
	)
	const parsed = entryChangeSchema.parse(raw)
	return { entry: parsed.entry, changed: parsed.changed ?? true }
}

export async function setWaitlistEntryStatus(
	client: ReservationsScopedClient,
	entryId: string,
	status: WaitlistStatusTarget,
	expectedVersion: number,
): Promise<WaitlistEntryChange> {
	const raw = await client.request<unknown>(
		`${WAITLIST_BASE}/${encodeURIComponent(entryId)}/status`,
		{ method: 'POST', body: { status, expectedVersion } },
	)
	const parsed = entryChangeSchema.parse(raw)
	return { entry: parsed.entry, changed: parsed.changed ?? true }
}

export type SeatWaitlistInput = {
	tableIds?: string[]
	overbook?: boolean
	overbookReason?: string | null
	/** What to do when the table is taken (a 409 `table_occupied` names the occupant). */
	resolution?: WaitlistSeatResolution
	moveToTableIds?: string[]
	expectedVersion?: number
}

export async function seatWaitlistEntry(
	client: ReservationsScopedClient,
	entryId: string,
	input: SeatWaitlistInput,
	idempotencyKey = generateIdempotencyKey('wlseat'),
): Promise<{ entry: WaitlistEntry; reservation: DayReservationView | null }> {
	const raw = await client.request<Record<string, unknown>>(
		`${WAITLIST_BASE}/${encodeURIComponent(entryId)}/seat`,
		{
			method: 'POST',
			headers: { 'Idempotency-Key': idempotencyKey },
			body: {
				...(input.tableIds && input.tableIds.length > 0
					? { tableIds: input.tableIds }
					: {}),
				...(input.expectedVersion !== undefined
					? { expectedVersion: input.expectedVersion }
					: {}),
				...(input.resolution ? { resolution: input.resolution } : {}),
				...(input.moveToTableIds && input.moveToTableIds.length > 0
					? { moveToTableIds: input.moveToTableIds }
					: {}),
				...(input.overbook
					? {
							overbook: true,
							overbookReason:
								input.overbookReason?.trim() || 'Waitlist overbook',
						}
					: {}),
			},
		},
	)
	const entry = entryEnvelopeSchema.parse(raw).entry
	const reservation =
		raw.reservation && typeof raw.reservation === 'object'
			? normalizeReservationView(raw.reservation as Record<string, unknown>)
			: null
	return { entry, reservation }
}

/** `ids` is the complete new order of the active queue. */
export async function reorderWaitlist(
	client: ReservationsScopedClient,
	params: { locationId: string; ids: readonly string[]; date?: string },
): Promise<WaitlistListing> {
	const raw = await client.request<unknown>(`${WAITLIST_BASE}/reorder`, {
		method: 'POST',
		body: {
			locationId: params.locationId,
			ids: params.ids,
			...(params.date ? { date: params.date } : {}),
		},
	})
	return waitlistListingSchema.parse(raw)
}

export const waitlistSettingsSchema = z.object({
	locationId: z.string(),
	version: z.number().int(),
	waitlistEnabled: z.boolean(),
	waitlistOnline: z.boolean(),
	notifyMeEnabled: z.boolean(),
	waitlistResponseMin: z.number().int(),
	waitlistMaxParties: z.number().int().nullable(),
})

export type WaitlistSettings = z.infer<typeof waitlistSettingsSchema>

export type WaitlistSettingsPatch = {
	expectedVersion: number
	waitlistEnabled?: boolean
	waitlistOnline?: boolean
	notifyMeEnabled?: boolean
	waitlistResponseMin?: number
	waitlistMaxParties?: number | null
}

export async function fetchWaitlistSettings(
	client: ReservationsScopedClient,
	locationId: string,
	signal?: AbortSignal,
): Promise<WaitlistSettings> {
	const raw = await client.request<unknown>(
		`${SETUP_BASE}/locations/${encodeURIComponent(locationId)}/waitlist`,
		{ signal },
	)
	return waitlistSettingsSchema.parse(raw)
}

export async function saveWaitlistSettings(
	client: ReservationsScopedClient,
	locationId: string,
	patch: WaitlistSettingsPatch,
): Promise<WaitlistSettings> {
	const raw = await client.request<unknown>(
		`${SETUP_BASE}/locations/${encodeURIComponent(locationId)}/waitlist`,
		{ method: 'PUT', body: patch },
	)
	return waitlistSettingsSchema.parse(raw)
}

/** Stable text for change detection that ignores the server clock. */
export function waitlistListingSignature(listing: WaitlistListing): string {
	const { now: ignoredNow, ...rest } = listing
	return JSON.stringify(rest)
}
