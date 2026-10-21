import {
	addDays,
	buildEffectiveDay,
	daysBetween,
	describeLocationClosedReason,
	resolveLocalizedText,
	resolveServices,
	type EffectiveDay,
	type SpecialDayRuleInput,
} from '@repo/reservations'
import { rsvLocationSettings, rsvSpecialDays } from '@repo/tenant-db'
import { and, eq, gte, lte } from 'drizzle-orm'
import { type DbOrTx } from './rsv-guest-service.ts'
import { loadLocationHours } from './rsv-location-hours.ts'

export type SpecialDayRow = typeof rsvSpecialDays.$inferSelect

/**
 * Operator text for a guest: requested language, language base, the
 * organization default, then (only when `fallbackToAnyLocale`) the first
 * language written. No language is hard-coded.
 */
export function pickI18n(
	map: Record<string, string> | null | undefined,
	locale?: string | null,
	defaultLocale?: string | null,
	/** Names have a canonical column to fall back to, so they must not borrow another locale's text. */
	fallbackToAnyLocale = true,
): string | null {
	if (!map) return null
	const found = resolveLocalizedText(map, locale, defaultLocale ?? '')
	if (found) return found
	return fallbackToAnyLocale ? (Object.values(map).find(Boolean) ?? null) : null
}

/** Expands date-range special days into one engine rule per business date inside the window. */
export function specialDayRules(
	rows: SpecialDayRow[],
	fromDate: string,
	toDate: string,
	i18n?: { locale?: string | null; defaultLocale?: string | null },
): SpecialDayRuleInput[] {
	const out: SpecialDayRuleInput[] = []
	for (const row of rows) {
		const start = row.fromDate > fromDate ? row.fromDate : fromDate
		const end = row.toDate < toDate ? row.toDate : toDate
		const patch = row.patch as Record<string, unknown> | null
		const custom = Array.isArray(patch?.customServices)
			? (patch.customServices as SpecialDayRuleInput['customServices'])
			: Array.isArray(patch)
				? (patch as SpecialDayRuleInput['customServices'])
				: []
		const note = pickI18n(row.publicNoteI18n, i18n?.locale, i18n?.defaultLocale)
		const span = daysBetween(start, end)
		for (let i = 0; i <= span; i++) {
			out.push({
				id: row.id,
				businessDate: addDays(start, i),
				type: row.kind,
				name: row.name,
				note,
				customServices: custom,
			})
		}
	}
	return out
}

export async function loadSpecialDayRows(
	db: DbOrTx,
	locationId: string,
	fromDate: string,
	toDate: string,
): Promise<SpecialDayRow[]> {
	return db
		.select()
		.from(rsvSpecialDays)
		.where(
			and(
				eq(rsvSpecialDays.locationId, locationId),
				lte(rsvSpecialDays.fromDate, toDate),
				gte(rsvSpecialDays.toDate, fromDate),
			),
		)
		.all()
}

export type StaffDayState =
	| { state: 'open'; effectiveDay: EffectiveDay }
	| {
			state: 'closed' | 'online_closed'
			name: string | null
			note: string | null
			/** Who closed it: the location hours or a reservations special day. */
			source: 'location_hours' | 'reservation_special_day'
			/** Plain reason, e.g. "Christmas" or "Closed this weekday". */
			reason: string
			/** A reservations special day closes the day (whatever the location says). */
			reservationClosed: boolean
			effectiveDay: EffectiveDay
	  }

/**
 * How the day treats the staff channel. A closed location (special hours,
 * inactive, closed weekday) and a reservations `closed` special day both stop
 * it (`closed_day` unless the staff member overbooks with a reason);
 * `online_closed` only stops the guest channel.
 */
export async function loadStaffDayState(
	db: DbOrTx,
	locationId: string,
	businessDate: string,
): Promise<StaffDayState> {
	const [rows, hours, settings] = await Promise.all([
		loadSpecialDayRows(db, locationId, businessDate, businessDate),
		loadLocationHours(db, locationId),
		db
			.select({ dayStartMin: rsvLocationSettings.dayStartMin })
			.from(rsvLocationSettings)
			.where(eq(rsvLocationSettings.locationId, locationId))
			.get(),
	])
	const resolved = resolveServices(
		businessDate,
		[],
		specialDayRules(rows, businessDate, businessDate),
	)
	const effectiveDay = buildEffectiveDay({
		businessDate,
		hours,
		dayStartMin: settings?.dayStartMin ?? 240,
		reservation: resolved,
	})
	if (!effectiveDay.open) {
		const fromLocation = effectiveDay.source === 'location_closed'
		return {
			state: 'closed',
			reservationClosed: resolved.closed,
			name: fromLocation ? null : (effectiveDay.name ?? null),
			note: effectiveDay.note ?? null,
			source: fromLocation ? 'location_hours' : 'reservation_special_day',
			reason: fromLocation
				? describeLocationClosedReason(
						effectiveDay.closedReason,
						effectiveDay.note,
					)
				: (effectiveDay.name ?? 'Reservations closed'),
			effectiveDay,
		}
	}
	if (effectiveDay.onlineClosed) {
		return {
			state: 'online_closed',
			reservationClosed: false,
			name: effectiveDay.name ?? null,
			note: effectiveDay.note ?? null,
			source: 'reservation_special_day',
			reason: effectiveDay.name ?? 'Online closed',
			effectiveDay,
		}
	}
	return { state: 'open', effectiveDay }
}

/** The wire shape of a staff day state (no instants), with the closed source and a ready label. */
export function publicStaffDayState(dayState: StaffDayState) {
	if (dayState.state === 'open') return { state: 'open' as const }
	const label =
		dayState.state === 'closed'
			? dayState.source === 'location_hours'
				? `Closed: ${dayState.reason} (from location hours)`
				: `Closed: ${dayState.reason} (Reservations)`
			: `Online closed: ${dayState.reason} (Reservations)`
	return {
		state: dayState.state,
		name: dayState.name,
		note: dayState.note,
		closedSource: dayState.source,
		closedReason: dayState.reason,
		closedLabel: label,
	}
}
