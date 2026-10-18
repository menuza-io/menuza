import {
	addDays,
	currentBusinessDate,
	experienceSeatingsOn,
	formatHhmm,
	type ReservationsContext,
} from '@repo/reservations'
import {
	rsvExperienceSchedules,
	rsvExperiences,
	rsvPolicies,
	type RsvExperienceRow,
	type RsvExperienceScheduleRow,
	type TenantDatabase,
} from '@repo/tenant-db'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { queryInChunks } from '../lib/chunked-in.ts'
import { HttpError } from '../lib/http.ts'
import {
	loadExperienceWithSchedules,
	searchExperienceDay,
	toScheduleInput,
} from './rsv-experience-engine.ts'
import { type DbOrTx } from './rsv-guest-service.ts'
import {
	loadPublicEngineState,
	pickI18n,
	readDayVersion,
} from './rsv-public-engine.ts'
import {
	listBookableLocations,
	type BookableLocation,
} from './rsv-public-service.ts'

/**
 * Public, non-PII Experience data (`architecture.md` 7.3). Drafts and archived
 * experiences never leave this module. `uses_tables`, `exclusive`, areas,
 * services, caps and the policy's money terms are never exposed: the guest sees
 * the catalog text, the price, the party range, upcoming seating times and the
 * policy TERMS text with its version.
 */

/** How far ahead the list and detail pages preview seating times. */
export const EXPERIENCE_PREVIEW_DAYS = 14

type PolicyTerms = { terms: string | null; termsVersion: number } | null

export type PublicExperience = {
	id: string
	slug: string
	locationId: string
	locationName: string | null
	kind: RsvExperienceRow['kind']
	name: string
	description: string | null
	imageUrl: string | null
	price: {
		priceMinor: number
		perCover: boolean
		currency: string
	} | null
	partyMin: number
	partyMax: number
	timeZone: string
	seatings: Array<{
		date: string
		times: Array<{ localMin: number; time: string }>
	}>
	policy: PolicyTerms
}

function upcomingSeatings(
	schedules: readonly RsvExperienceScheduleRow[],
	today: string,
	horizonDays: number,
): PublicExperience['seatings'] {
	const inputs = schedules.map(toScheduleInput)
	const out: PublicExperience['seatings'] = []
	const days = Math.min(EXPERIENCE_PREVIEW_DAYS, horizonDays + 1)
	for (let i = 0; i < days; i++) {
		const date = addDays(today, i)
		const times = experienceSeatingsOn(inputs, date).map((s) => ({
			localMin: s.seatingMin,
			time: formatHhmm(s.seatingMin),
		}))
		if (times.length > 0) out.push({ date, times })
	}
	return out
}

async function loadPolicyTerms(
	db: DbOrTx,
	policyIds: readonly string[],
	locale: string | null,
): Promise<Map<string, NonNullable<PolicyTerms>>> {
	const unique = [...new Set(policyIds)]
	const out = new Map<string, NonNullable<PolicyTerms>>()
	if (unique.length === 0) return out
	const rows = await queryInChunks(unique, (chunk) =>
		db.select().from(rsvPolicies).where(inArray(rsvPolicies.id, chunk)).all(),
	)
	for (const row of rows) {
		if (row.archivedAt !== null) continue
		out.set(row.id, {
			terms: pickI18n(row.termsI18n, locale),
			termsVersion: row.termsVersion,
		})
	}
	return out
}

function present(
	row: RsvExperienceRow,
	schedules: readonly RsvExperienceScheduleRow[],
	location: BookableLocation,
	policies: ReadonlyMap<string, NonNullable<PolicyTerms>>,
	locale: string | null,
	now: number,
): PublicExperience {
	const { settings, facts } = location
	const today = currentBusinessDate(
		now,
		settings.timeZone,
		settings.dayStartMin,
	)
	return {
		id: row.id,
		slug: row.slug,
		locationId: row.locationId,
		locationName: facts.name,
		kind: row.kind,
		name: pickI18n(row.nameI18n, locale) ?? row.slug,
		description: pickI18n(row.descriptionI18n, locale),
		imageUrl: row.imageUrl,
		price:
			row.priceMinor === null
				? null
				: {
						priceMinor: row.priceMinor,
						perCover: row.pricePerCover,
						currency: row.currency,
					},
		partyMin: row.partyMin,
		partyMax: row.partyMax,
		timeZone: settings.timeZone,
		seatings: upcomingSeatings(schedules, today, settings.horizonDays),
		policy: row.policyId ? (policies.get(row.policyId) ?? null) : null,
	}
}

async function publishedFor(
	db: DbOrTx,
	locationIds: readonly string[],
	slug?: string,
): Promise<RsvExperienceRow[]> {
	if (locationIds.length === 0) return []
	return queryInChunks(locationIds, (chunk) =>
		db
			.select()
			.from(rsvExperiences)
			.where(
				and(
					inArray(rsvExperiences.locationId, chunk),
					eq(rsvExperiences.status, 'published'),
					...(slug ? [eq(rsvExperiences.slug, slug)] : []),
				),
			)
			.orderBy(asc(rsvExperiences.sort), asc(rsvExperiences.slug))
			.all(),
	)
}

async function schedulesByExperience(
	db: DbOrTx,
	experienceIds: readonly string[],
): Promise<Map<string, RsvExperienceScheduleRow[]>> {
	const rows = await queryInChunks(experienceIds, (chunk) =>
		db
			.select()
			.from(rsvExperienceSchedules)
			.where(inArray(rsvExperienceSchedules.experienceId, chunk))
			.orderBy(
				asc(rsvExperienceSchedules.fromDate),
				asc(rsvExperienceSchedules.id),
			)
			.all(),
	)
	const out = new Map<string, RsvExperienceScheduleRow[]>()
	for (const row of rows) {
		const list = out.get(row.experienceId) ?? []
		list.push(row)
		out.set(row.experienceId, list)
	}
	return out
}

async function buildPublic(
	db: DbOrTx,
	ctx: ReservationsContext,
	rows: RsvExperienceRow[],
	locations: BookableLocation[],
	locale: string | null,
	now: number,
): Promise<PublicExperience[]> {
	const byLocation = new Map(locations.map((l) => [l.facts.id, l]))
	const schedules = await schedulesByExperience(
		db,
		rows.map((r) => r.id),
	)
	const policies = await loadPolicyTerms(
		db,
		rows.flatMap((r) => (r.policyId ? [r.policyId] : [])),
		locale,
	)
	void ctx
	return rows.flatMap((row) => {
		const location = byLocation.get(row.locationId)
		if (!location) return []
		return [
			present(
				row,
				schedules.get(row.id) ?? [],
				location,
				policies,
				locale,
				now,
			),
		]
	})
}

/** Published experiences of every bookable location, in setup order. */
export async function listPublicExperiences(
	db: DbOrTx,
	ctx: ReservationsContext,
	params: { locale: string | null; now?: number },
): Promise<PublicExperience[]> {
	const now = params.now ?? Date.now()
	const locations = await listBookableLocations(db, ctx)
	const rows = await publishedFor(
		db,
		locations.map((l) => l.facts.id),
	)
	return buildPublic(db, ctx, rows, locations, params.locale, now)
}

/** One published experience by slug; a slug shared across locations needs `locationId`. */
export async function getPublicExperience(
	db: DbOrTx,
	ctx: ReservationsContext,
	params: {
		slug: string
		locationId?: string | null
		locale: string | null
		now?: number
	},
): Promise<PublicExperience> {
	const now = params.now ?? Date.now()
	const locations = (await listBookableLocations(db, ctx)).filter(
		(l) => !params.locationId || l.facts.id === params.locationId,
	)
	const rows = await publishedFor(
		db,
		locations.map((l) => l.facts.id),
		params.slug,
	)
	const [first] = await buildPublic(
		db,
		ctx,
		rows.slice(0, 1),
		locations,
		params.locale,
		now,
	)
	if (!first) throw new HttpError(404, 'not_found')
	return first
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

export type ExperienceAvailabilityParams = {
	locationId: string
	experienceId: string
	date: string
	partySize: number
	now?: number
	location: BookableLocation
	features: Pick<ReservationsContext['features'], 'online' | 'experiences'>
}

/**
 * `GET /reservations/availability?experienceId=`: the experience's seatings on
 * a date as slots, same envelope as regular availability. A seating that cannot
 * take the party (cap reached, or no table in its areas) is left out of `slots`
 * and listed in `soldOut`, so a page can show it as sold out.
 */
export async function getPublicExperienceAvailability(
	db: TenantDatabase,
	params: ExperienceAvailabilityParams,
) {
	if (!params.features.online || !params.features.experiences) {
		throw new HttpError(404, 'not_found')
	}
	const now = params.now ?? Date.now()
	const loaded = await loadExperienceWithSchedules(
		db,
		params.locationId,
		params.experienceId,
	)
	if (!loaded || loaded.row.status !== 'published') {
		throw new HttpError(404, 'not_found')
	}
	const state = await loadPublicEngineState(db, {
		locationId: params.locationId,
		fromDate: params.date,
		toDate: params.date,
		now,
	})
	if (!state) throw new HttpError(404, 'not_found')
	const result = await searchExperienceDay(db, state, loaded, {
		businessDate: params.date,
		partySize: params.partySize,
		now,
		channel: 'online',
	})
	if (result.status === 'disabled') throw new HttpError(404, 'not_found')
	if (result.status === 'party_out_of_bounds') {
		throw new HttpError(400, 'party_size_invalid')
	}
	const dayVersion = await readDayVersion(db, params.locationId, params.date)
	return {
		dayVersion,
		settingsVersion: params.location.settings.version,
		timeZone: state.timeZone,
		now: new Date(now).toISOString(),
		locationId: params.locationId,
		date: params.date,
		partySize: params.partySize,
		experienceId: params.experienceId,
		status: result.status,
		slots: result.slots.map((s) => ({
			localMin: s.slotMin,
			time: s.slotHhmm,
			serviceId: s.serviceId,
			serviceName: s.serviceName,
			areaId: null,
			areaLabel: null,
			experienceId: params.experienceId,
		})),
		soldOut: result.soldOut.map((m) => ({
			localMin: m,
			time: formatHhmm(m),
		})),
		alternatives: { sameDay: [], otherDates: [] },
		notifyMe: false,
		waitlist: false,
	}
}
