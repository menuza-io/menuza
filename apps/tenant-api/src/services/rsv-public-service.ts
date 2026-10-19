import {
	addDays,
	daysBetween,
	type ReservationsContext,
} from '@repo/reservations'
import {
	rsvAreas,
	rsvLocationSettings,
	rsvTags,
	type TenantDatabase,
} from '@repo/tenant-db'
import { and, asc, eq, inArray, isNull } from 'drizzle-orm'
import { HttpError } from '../lib/http.ts'
import { pickText, type LocaleOrg } from '../lib/reservations-i18n.ts'
import { buildAlternatives, alternativesWindow } from './rsv-hold-service.ts'
import { type DbOrTx } from './rsv-guest-service.ts'
import {
	describeClosedDay,
	loadPublicEngineState,
	readDayVersion,
	searchPublicDay,
	publicSlotMapper,
	uniqueSlotsByTime,
	type LocationSettingsRow,
} from './rsv-public-engine.ts'

export const MAX_CALENDAR_DAYS = 62

export type BookableLocation = {
	facts: ReservationsContext['locations'][number]
	settings: LocationSettingsRow
}

/** Locations a guest may book: active in the control plane and switched on for online booking. */
export async function listBookableLocations(
	db: DbOrTx,
	ctx: ReservationsContext,
): Promise<BookableLocation[]> {
	const active = ctx.locations.filter((l) => l.isActive)
	if (active.length === 0) return []
	const rows = await db
		.select()
		.from(rsvLocationSettings)
		.where(
			inArray(
				rsvLocationSettings.locationId,
				active.map((l) => l.id),
			),
		)
		.all()
	const byId = new Map(rows.map((r) => [r.locationId, r]))
	return active.flatMap((facts) => {
		const settings = byId.get(facts.id)
		return settings && settings.enabled && settings.onlineEnabled
			? [{ facts, settings }]
			: []
	})
}

export async function requireBookableLocation(
	db: DbOrTx,
	ctx: ReservationsContext,
	locationId: string,
): Promise<BookableLocation> {
	const found = (await listBookableLocations(db, ctx)).find(
		(l) => l.facts.id === locationId,
	)
	if (!found) throw new HttpError(404, 'not_found')
	return found
}

function largePartyBlock(
	location: BookableLocation,
	locale: string | null,
	org: LocaleOrg,
) {
	const { settings, facts } = location
	const phone = settings.contactPhone ?? facts.phone ?? null
	return {
		mode: settings.largePartyMode,
		maxOnlinePartySize: settings.onlinePartyMax,
		phone,
		contact: { name: facts.name, phone },
		note: pickText(settings.largePartyNoteI18n, locale, org),
	}
}

export async function getPublicConfig(
	db: DbOrTx,
	ctx: ReservationsContext,
	locale: string | null,
) {
	const locations = await listBookableLocations(db, ctx)
	const tags = await db
		.select()
		.from(rsvTags)
		.where(and(eq(rsvTags.guestSelectable, true), isNull(rsvTags.archivedAt)))
		.all()
	const areaRows =
		locations.length > 0
			? await db
					.select()
					.from(rsvAreas)
					.where(
						and(
							inArray(
								rsvAreas.locationId,
								locations.map((l) => l.facts.id),
							),
							eq(rsvAreas.guestSelectable, true),
							eq(rsvAreas.onlineBookable, true),
							isNull(rsvAreas.archivedAt),
						),
					)
					.orderBy(asc(rsvAreas.sort))
					.all()
			: []
	const chips = (category: string) =>
		tags
			.filter((t) => t.category === category)
			.map((t) => ({
				id: t.id,
				name: pickText(t.nameI18n, locale, ctx.organization, t.name) ?? t.name,
			}))
	return {
		organization: {
			name: ctx.organization.name,
			defaultLocale: ctx.organization.defaultLocale,
		},
		locations: locations.map((l) => ({
			id: l.facts.id,
			name: l.facts.name,
			address: l.facts.address
				? {
						formattedAddress: l.facts.address.formattedAddress,
						city: l.facts.address.city,
					}
				: null,
			timeZone: l.settings.timeZone,
			phone: l.settings.contactPhone ?? l.facts.phone ?? null,
			partySize: {
				min: l.settings.onlinePartyMin,
				max: l.settings.onlinePartyMax,
			},
			horizonDays: l.settings.horizonDays,
			intervalMin: l.settings.intervalMin,
			holdMinutes: l.settings.holdMinutes,
			largeParty: largePartyBlock(l, locale, ctx.organization),
			waitlist: {
				enabled: ctx.features.waitlist && l.settings.waitlistEnabled,
				online:
					ctx.features.waitlist &&
					ctx.features.online &&
					l.settings.waitlistEnabled &&
					l.settings.waitlistOnline,
			},
			notifyMe: ctx.features.waitlist && l.settings.notifyMeEnabled,
			areas: areaRows
				.filter((a) => a.locationId === l.facts.id)
				.map((a) => ({
					id: a.id,
					name:
						pickText(a.nameI18n, locale, ctx.organization, a.name) ?? a.name,
				})),
			publicNote: pickText(l.settings.publicNoteI18n, locale, ctx.organization),
		})),
		occasions: chips('occasion'),
		dietary: chips('dietary'),
	}
}

export type AvailabilityParams = {
	locationId: string
	date: string
	partySize: number
	localMin?: number | null
	locale?: string | null
	/** Languages of the organization (Website settings); omitted, only `locale` is known. */
	organization?: LocaleOrg
	now?: number
	excludeReservationId?: string
	location: BookableLocation
	/** The organization flags: a switched-off module offers no waitlist or notify-me hint. */
	features: Pick<ReservationsContext['features'], 'waitlist' | 'online'>
}

export async function getPublicAvailability(
	db: TenantDatabase,
	params: AvailabilityParams,
) {
	const now = params.now ?? Date.now()
	const { settings } = params.location
	const window = alternativesWindow(params.date)
	const state = await loadPublicEngineState(db, {
		locationId: params.locationId,
		...window,
		now,
		excludeReservationIds: params.excludeReservationId
			? new Set([params.excludeReservationId])
			: undefined,
		i18n: params.organization
			? {
					locale: params.locale,
					defaultLocale: params.organization.defaultLocale,
				}
			: undefined,
	})
	if (!state) throw new HttpError(404, 'not_found')

	const result = searchPublicDay(state, {
		businessDate: params.date,
		partySize: params.partySize,
		now,
		preferredSlotMin: params.localMin ?? null,
	})
	if (result.status === 'party_out_of_bounds') {
		throw new HttpError(400, 'party_size_invalid')
	}
	if (result.status === 'disabled') throw new HttpError(404, 'not_found')

	const dayVersion = await readDayVersion(db, params.locationId, params.date)
	const slots = uniqueSlotsByTime(result.slots)
	const preferred = params.localMin ?? null
	const wantsAlternatives =
		result.status === 'full' ||
		(preferred !== null && !slots.some((s) => s.slotMin === preferred))
	const alternatives =
		wantsAlternatives &&
		result.status !== 'closed' &&
		result.status !== 'online_closed' &&
		result.status !== 'beyond_horizon'
			? buildAlternatives(state, result, {
					date: params.date,
					localMin: preferred ?? slots[0]?.slotMin ?? 0,
					partySize: params.partySize,
					now,
				})
			: { sameDay: [], otherDates: [] }

	const closedDay =
		result.status === 'closed'
			? describeClosedDay(state, params.date, result)
			: null
	const onlineClosedDay =
		result.status === 'online_closed'
			? describeOnlineClosed(state, params.date)
			: null

	return {
		dayVersion,
		settingsVersion: settings.version,
		timeZone: state.timeZone,
		now: new Date(now).toISOString(),
		locationId: params.locationId,
		date: params.date,
		partySize: params.partySize,
		status: result.status,
		slots: slots.map(publicSlotMapper(state, params.locale)),
		alternatives,
		...(result.status === 'large_party'
			? {
					largeParty: largePartyBlock(
						params.location,
						params.locale ?? null,
						params.organization ?? {
							locales: [],
							defaultLocale: params.locale ?? '',
						},
					),
				}
			: {}),
		...(closedDay
			? {
					closed: {
						reason: closedDay.reason,
						note: closedDay.note,
						name: closedDay.name,
						...(closedDay.source ? { source: closedDay.source } : {}),
					},
				}
			: {}),
		...(onlineClosedDay ? { onlineClosed: onlineClosedDay } : {}),
		notifyMe: params.features.waitlist && settings.notifyMeEnabled,
		waitlist:
			params.features.waitlist &&
			params.features.online &&
			settings.waitlistEnabled &&
			settings.waitlistOnline,
	}
}

function describeOnlineClosed(
	state: Awaited<ReturnType<typeof loadPublicEngineState>> & object,
	date: string,
) {
	const special = state.config.specialDays.find(
		(s) => (s.businessDate ?? s.business_date) === date,
	)
	return { note: special?.note ?? null, name: special?.name ?? null }
}

export async function getPublicCalendar(
	db: TenantDatabase,
	params: {
		locationId: string
		from: string
		to: string
		partySize: number
		now?: number
		location: BookableLocation
	},
) {
	const now = params.now ?? Date.now()
	const span = daysBetween(params.from, params.to) + 1
	if (span < 1 || span > MAX_CALENDAR_DAYS) {
		throw new HttpError(400, 'invalid', undefined, {
			issues: [{ path: 'to', code: 'range_too_large' }],
		})
	}
	const state = await loadPublicEngineState(db, {
		locationId: params.locationId,
		fromDate: params.from,
		toDate: params.to,
		now,
	})
	if (!state) throw new HttpError(404, 'not_found')

	const days = []
	for (let i = 0; i < span; i++) {
		const date = addDays(params.from, i)
		const result = searchPublicDay(state, {
			businessDate: date,
			partySize: params.partySize,
			now,
		})
		if (result.status === 'party_out_of_bounds') {
			throw new HttpError(400, 'party_size_invalid')
		}
		const slots = uniqueSlotsByTime(result.slots)
		days.push({
			date,
			hasAvailability: slots.length > 0,
			status: result.status,
			closed: result.status === 'closed',
			...(result.closed
				? {
						closedSource:
							result.closed.source === 'location_closed'
								? ('location_hours' as const)
								: ('reservation_special_day' as const),
					}
				: {}),
			slotCount: slots.length,
			firstLocalMin: slots[0]?.slotMin ?? null,
			lastLocalMin: slots.at(-1)?.slotMin ?? null,
		})
	}
	return {
		locationId: params.locationId,
		timeZone: state.timeZone,
		now: new Date(now).toISOString(),
		partySize: params.partySize,
		days,
	}
}
