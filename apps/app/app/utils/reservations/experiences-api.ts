import { z } from 'zod'
import {
	ReservationsApiError,
	type ReservationsScopedClient,
} from '#app/utils/reservations/reservations-client.ts'

/**
 * Experience setup (tasting menus, chef's tables, ticketed events), browser
 * direct with a `setup` token. An experience and its schedules are public
 * catalog configuration: no guest data. Every mutation answers with the whole
 * experience, whose `version` is what the next write must send. The currency
 * always comes from the location.
 */

const BASE = '/operator/reservations/setup/locations'

export const EXPERIENCE_KINDS = ['ticketed', 'prix_fixe'] as const
export type ExperienceKind = (typeof EXPERIENCE_KINDS)[number]
export const EXPERIENCE_STATUSES = ['draft', 'published', 'archived'] as const
export type ExperienceStatus = (typeof EXPERIENCE_STATUSES)[number]
export const EXPERIENCE_LOCALES = ['en', 'ar', 'es', 'fr', 'de', 'zh'] as const
export type ExperienceLocale = (typeof EXPERIENCE_LOCALES)[number]

export const scheduleSchema = z.object({
	id: z.string(),
	experienceId: z.string(),
	fromDate: z.string(),
	toDate: z.string(),
	/** Bit 0 = Monday ... bit 6 = Sunday. */
	daysMask: z.number().int(),
	seatingMins: z.array(z.number().int()).nullable(),
	startMin: z.number().int().nullable(),
	endMin: z.number().int().nullable(),
	intervalMin: z.number().int().nullable(),
	turnMin: z.number().int(),
	coversCapPerSeating: z.number().int().nullable(),
	coversCapPerDay: z.number().int().nullable(),
	areaIds: z.array(z.string()).nullable(),
	serviceId: z.string().nullable(),
	/** The resolved start minutes. */
	seatings: z.array(z.number().int()),
})
export type ExperienceScheduleDto = z.infer<typeof scheduleSchema>

export const experienceSchema = z.object({
	id: z.string(),
	locationId: z.string(),
	slug: z.string(),
	kind: z.enum(EXPERIENCE_KINDS),
	nameI18n: z.record(z.string(), z.string()),
	descriptionI18n: z.record(z.string(), z.string()).nullable(),
	imageUrl: z.string().nullable(),
	priceMinor: z.number().int().nullable(),
	pricePerCover: z.boolean(),
	currency: z.string(),
	policyId: z.string().nullable(),
	partyMin: z.number().int(),
	partyMax: z.number().int(),
	usesTables: z.boolean(),
	exclusive: z.boolean(),
	status: z.enum(EXPERIENCE_STATUSES),
	sort: z.number().int(),
	version: z.number().int(),
	schedules: z.array(scheduleSchema),
})
export type ExperienceDto = z.infer<typeof experienceSchema>

export type ExperienceInput = {
	slug: string
	kind: ExperienceKind
	nameI18n: Partial<Record<ExperienceLocale, string>>
	descriptionI18n?: Partial<Record<ExperienceLocale, string>> | null
	imageUrl?: string | null
	priceMinor?: number | null
	pricePerCover?: boolean
	policyId?: string | null
	partyMin?: number
	partyMax?: number
	usesTables?: boolean
	exclusive?: boolean
	sort?: number
}

export type ExperiencePatch = Partial<ExperienceInput> & {
	expectedVersion: number
}

export type ScheduleBody = {
	fromDate: string
	toDate: string
	daysMask: number
	seatingMins: number[] | null
	startMin: number | null
	endMin: number | null
	intervalMin: number | null
	turnMin: number
	coversCapPerSeating: number | null
	coversCapPerDay: number | null
	areaIds: string[] | null
	serviceId: string | null
}

function malformed(): never {
	throw new ReservationsApiError('malformed_response', 502, {
		error: 'malformed_response',
	})
}

function one(raw: { experience?: unknown }): ExperienceDto {
	const parsed = experienceSchema.safeParse(raw.experience)
	return parsed.success ? parsed.data : malformed()
}

const root = (locationId: string) =>
	`${BASE}/${encodeURIComponent(locationId)}/experiences`
const item = (locationId: string, id: string) =>
	`${root(locationId)}/${encodeURIComponent(id)}`

export async function fetchExperiences(
	client: ReservationsScopedClient,
	locationId: string,
	signal?: AbortSignal,
): Promise<ExperienceDto[]> {
	const raw = await client.request<{ experiences?: unknown }>(
		root(locationId),
		{ signal },
	)
	const parsed = z.array(experienceSchema).safeParse(raw.experiences ?? [])
	return parsed.success ? parsed.data : malformed()
}

export async function fetchExperience(
	client: ReservationsScopedClient,
	locationId: string,
	id: string,
	signal?: AbortSignal,
): Promise<ExperienceDto> {
	return one(
		await client.request<{ experience?: unknown }>(item(locationId, id), {
			signal,
		}),
	)
}

export async function createExperience(
	client: ReservationsScopedClient,
	locationId: string,
	input: ExperienceInput,
): Promise<ExperienceDto> {
	return one(
		await client.request<{ experience?: unknown }>(root(locationId), {
			method: 'POST',
			body: input,
		}),
	)
}

export async function updateExperience(
	client: ReservationsScopedClient,
	locationId: string,
	id: string,
	patch: ExperiencePatch,
): Promise<ExperienceDto> {
	return one(
		await client.request<{ experience?: unknown }>(item(locationId, id), {
			method: 'PATCH',
			body: patch,
		}),
	)
}

export type ExperienceTransition = 'publish' | 'unpublish' | 'archive'

export async function transitionExperience(
	client: ReservationsScopedClient,
	locationId: string,
	id: string,
	action: ExperienceTransition,
	expectedVersion: number,
): Promise<ExperienceDto> {
	return one(
		await client.request<{ experience?: unknown }>(
			`${item(locationId, id)}/${action}`,
			{ method: 'POST', body: { expectedVersion } },
		),
	)
}

export async function createSchedule(
	client: ReservationsScopedClient,
	locationId: string,
	id: string,
	body: ScheduleBody,
	expectedVersion: number,
): Promise<ExperienceDto> {
	return one(
		await client.request<{ experience?: unknown }>(
			`${item(locationId, id)}/schedules`,
			{ method: 'POST', body: { ...body, expectedVersion } },
		),
	)
}

export async function updateSchedule(
	client: ReservationsScopedClient,
	locationId: string,
	id: string,
	scheduleId: string,
	body: ScheduleBody,
	expectedVersion: number,
): Promise<ExperienceDto> {
	return one(
		await client.request<{ experience?: unknown }>(
			`${item(locationId, id)}/schedules/${encodeURIComponent(scheduleId)}`,
			{ method: 'PATCH', body: { ...body, expectedVersion } },
		),
	)
}

export async function deleteSchedule(
	client: ReservationsScopedClient,
	locationId: string,
	id: string,
	scheduleId: string,
	expectedVersion: number,
): Promise<ExperienceDto> {
	return one(
		await client.request<{ experience?: unknown }>(
			`${item(locationId, id)}/schedules/${encodeURIComponent(scheduleId)}`,
			{ method: 'DELETE', query: { expectedVersion } },
		),
	)
}

export type ExperienceContext = {
	currency: string
	areas: Array<{ id: string; name: string }>
	services: Array<{ id: string; name: string }>
	policies: Array<{ id: string; name: string }>
}

/**
 * What the editor needs next to the experience: the location currency, the
 * areas and services a schedule may be limited to, and the payment policies an
 * experience may use. Policies are optional (a restaurant without payments has
 * none), so that call failing does not fail the screen.
 */
export async function fetchExperienceContext(
	client: ReservationsScopedClient,
	locationId: string,
	options: { withPolicies: boolean },
	signal?: AbortSignal,
): Promise<ExperienceContext> {
	const base = `${BASE}/${encodeURIComponent(locationId)}`
	const [settings, areas, services, policies] = await Promise.all([
		client.request<Record<string, unknown>>(`${base}/settings`, { signal }),
		client.request<{ areas?: Array<Record<string, unknown>> }>(
			`${base}/areas`,
			{
				signal,
			},
		),
		client.request<{ services?: Array<Record<string, unknown>> }>(
			`${base}/services`,
			{ signal },
		),
		options.withPolicies
			? client
					.request<{ policies?: Array<Record<string, unknown>> }>(
						`${base}/policies`,
						{ signal },
					)
					.catch(() => ({ policies: [] }))
			: Promise.resolve({ policies: [] as Array<Record<string, unknown>> }),
	])
	const flat = (settings.settings ?? settings) as Record<string, unknown>
	const live = (rows: Array<Record<string, unknown>> | undefined) =>
		(rows ?? [])
			.filter((row) => !row.archivedAt && !row.archived_at && !row.archived)
			.map((row) => ({ id: String(row.id), name: String(row.name ?? row.id) }))
	return {
		currency:
			typeof flat.currency === 'string' && flat.currency
				? flat.currency.toUpperCase()
				: 'USD',
		areas: live(areas.areas),
		services: live(services.services),
		policies: live(policies.policies),
	}
}
