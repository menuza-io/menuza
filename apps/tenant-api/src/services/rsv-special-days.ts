import {
	addDays,
	daysBetween,
	resolveServices,
	type SpecialDayRuleInput,
} from '@repo/reservations'
import { rsvSpecialDays } from '@repo/tenant-db'
import { and, eq, gte, lte } from 'drizzle-orm'
import { type DbOrTx } from './rsv-guest-service.ts'

export type SpecialDayRow = typeof rsvSpecialDays.$inferSelect

export function pickI18n(
	map: Record<string, string> | null | undefined,
	locale?: string | null,
	/** Names have a canonical column to fall back to, so they must not borrow another locale's text. */
	fallbackToAnyLocale = true,
): string | null {
	if (!map) return null
	const exact = locale ? map[locale] : undefined
	if (exact) return exact
	const base = locale?.split('-')[0]
	if (base && map[base]) return map[base]!
	if (map.en) return map.en
	return fallbackToAnyLocale ? (Object.values(map).find(Boolean) ?? null) : null
}

/** Expands date-range special days into one engine rule per business date inside the window. */
export function specialDayRules(
	rows: SpecialDayRow[],
	fromDate: string,
	toDate: string,
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
		const note = pickI18n(row.publicNoteI18n)
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
	| { state: 'open' }
	| {
			state: 'closed' | 'online_closed'
			name: string | null
			note: string | null
	  }

/** How a special day treats the staff channel: `closed` stops it, `online_closed` only the guest channel. */
export async function loadStaffDayState(
	db: DbOrTx,
	locationId: string,
	businessDate: string,
): Promise<StaffDayState> {
	const rows = await loadSpecialDayRows(
		db,
		locationId,
		businessDate,
		businessDate,
	)
	const resolved = resolveServices(
		businessDate,
		[],
		specialDayRules(rows, businessDate, businessDate),
	)
	if (resolved.closed || resolved.onlineClosed) {
		return {
			state: resolved.closed ? 'closed' : 'online_closed',
			name: resolved.specialDay?.name ?? null,
			note: resolved.specialDay?.note ?? null,
		}
	}
	return { state: 'open' }
}
