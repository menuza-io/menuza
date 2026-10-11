import { and, eq, gte, isNull, lt, lte } from 'drizzle-orm'
import {
	addDays,
	daysBetween,
	entryPaidMinutes,
	laborCents,
	laborPercent,
	localDateOf,
	paidMinutes,
	singleCurrencyTotal,
	type StaffingTokenClaims,
	staffingTokenAllowsLocation,
	staffingTokenLocationCurrency,
	staffingTokenLocationZone,
	zonedWallTimeToUtc,
} from '@repo/staffing'
import {
	getTenantDb,
	restaurantOrders,
	shifts,
	staffAssignments,
	timeEntries,
} from '@repo/tenant-db'

import { orderCountsTowardSales } from './report-records.ts'
import { type ServiceResult } from './staffing-roster.ts'

type TenantDatabase = Awaited<ReturnType<typeof getTenantDb>>
type Transaction = Parameters<Parameters<TenantDatabase['transaction']>[0]>[0]
type Writer = TenantDatabase | Transaction

export type Rate = { rateCents: number | null; currency: string | null }

const NO_RATE: Rate = { rateCents: null, currency: null }

type AssignmentRate = {
	staffId: string
	positionId: string
	isPrimary: boolean
	rateCents: number | null
	currency: string | null
}

/**
 * The rate for a position, or the person's primary position here when the
 * card or shift has none.
 */
function pickRate(
	rows: readonly AssignmentRate[],
	staffId: string,
	positionId: string | null,
): Rate {
	const mine = rows.filter((row) => row.staffId === staffId)
	const row =
		(positionId && mine.find((item) => item.positionId === positionId)) ||
		mine.find((item) => item.isPrimary)
	if (!row || row.rateCents === null || !row.currency) return NO_RATE
	return { rateCents: row.rateCents, currency: row.currency }
}

const rateColumns = {
	staffId: staffAssignments.staffId,
	positionId: staffAssignments.positionId,
	isPrimary: staffAssignments.isPrimary,
	rateCents: staffAssignments.rateCents,
	currency: staffAssignments.currency,
}

async function locationRates(db: Writer, locationId: string) {
	return db
		.select(rateColumns)
		.from(staffAssignments)
		.where(eq(staffAssignments.locationId, locationId))
}

/** Current rates at a location, for snapshotting many cards at once. */
export async function locationRatePicker(db: Writer, locationId: string) {
	const rows = await locationRates(db, locationId)
	return (staffId: string, positionId: string | null) =>
		pickRate(rows, staffId, positionId)
}

/** The current rate to snapshot onto a new or re-positioned time card. */
export async function assignmentRate(
	db: Writer,
	staffId: string,
	locationId: string,
	positionId: string | null,
): Promise<Rate> {
	const rows = await db
		.select(rateColumns)
		.from(staffAssignments)
		.where(
			and(
				eq(staffAssignments.staffId, staffId),
				eq(staffAssignments.locationId, locationId),
			),
		)
	return pickRate(rows, staffId, positionId)
}

export type LaborSummaryQuery = { locationId: string; from: string; to: string }

type DayBucket = {
	date: string
	workedMinutes: number
	scheduledMinutes: number
	orderCount: number
	labor: { cents: number; currency: string }[]
	scheduledLabor: { cents: number; currency: string }[]
	sales: { cents: number; currency: string }[]
}

/**
 * Hours, labor cost, and online sales for one location, by location-local
 * day. Worked cost uses each card's rate snapshot, falling back to the
 * current rate for cards made before a rate was set; scheduled cost uses
 * current rates. Sales are order subtotals (before tax, delivery, and tip)
 * from orders that count toward sales, on the day they were placed. Dine-in
 * and POS sales are not in this database.
 */
export async function laborSummary(
	orgId: string,
	claims: StaffingTokenClaims,
	query: LaborSummaryQuery,
	now = new Date(),
): Promise<ServiceResult<ReturnType<typeof shapeSummary>>> {
	const timeZone = staffingTokenAllowsLocation(claims, query.locationId)
		? staffingTokenLocationZone(claims, query.locationId)
		: undefined
	if (!timeZone) {
		return { ok: false, status: 400, code: 'unknown_location' }
	}
	const db = await getTenantDb(orgId)
	const startAt = zonedWallTimeToUtc(query.from, '00:00', timeZone)
	const endAt = zonedWallTimeToUtc(addDays(query.to, 1), '00:00', timeZone)
	const [rates, entries, shiftRows, orders] = await Promise.all([
		locationRates(db, query.locationId),
		db
			.select()
			.from(timeEntries)
			.where(
				and(
					eq(timeEntries.locationId, query.locationId),
					gte(timeEntries.localDate, query.from),
					lte(timeEntries.localDate, query.to),
					isNull(timeEntries.deletedAt),
				),
			),
		db
			.select()
			.from(shifts)
			.where(
				and(
					eq(shifts.locationId, query.locationId),
					gte(shifts.localDate, query.from),
					lte(shifts.localDate, query.to),
					isNull(shifts.deletedAt),
				),
			),
		db
			.select({
				status: restaurantOrders.status,
				paymentMethod: restaurantOrders.paymentMethod,
				paymentStatus: restaurantOrders.paymentStatus,
				currency: restaurantOrders.currency,
				subtotalCents: restaurantOrders.subtotalCents,
				createdAt: restaurantOrders.createdAt,
			})
			.from(restaurantOrders)
			.where(
				and(
					eq(restaurantOrders.locationId, query.locationId),
					gte(restaurantOrders.createdAt, startAt),
					lt(restaurantOrders.createdAt, endAt),
				),
			),
	])

	const days = new Map<string, DayBucket>()
	for (let offset = 0; offset <= daysBetween(query.from, query.to); offset++) {
		const date = addDays(query.from, offset)
		days.set(date, {
			date,
			workedMinutes: 0,
			scheduledMinutes: 0,
			orderCount: 0,
			labor: [],
			scheduledLabor: [],
			sales: [],
		})
	}
	let openEntries = 0
	let unratedWorkedMinutes = 0
	let unratedScheduledMinutes = 0

	for (const entry of entries) {
		const day = days.get(entry.localDate)
		if (!day) continue
		if (!entry.clockOutAt) {
			openEntries += 1
			continue
		}
		const minutes = entryPaidMinutes(entry)
		day.workedMinutes += minutes
		const rate =
			entry.rateCents !== null && entry.currency
				? { rateCents: entry.rateCents, currency: entry.currency }
				: pickRate(rates, entry.staffId, entry.positionId)
		if (rate.rateCents === null || !rate.currency) {
			unratedWorkedMinutes += minutes
		} else {
			day.labor.push({
				cents: laborCents(minutes, rate.rateCents),
				currency: rate.currency,
			})
		}
	}

	for (const shift of shiftRows) {
		const day = days.get(shift.localDate)
		if (!day) continue
		const minutes = paidMinutes(shift)
		day.scheduledMinutes += minutes
		const rate = shift.staffId
			? pickRate(rates, shift.staffId, shift.positionId)
			: NO_RATE
		if (rate.rateCents === null || !rate.currency) {
			unratedScheduledMinutes += minutes
		} else {
			day.scheduledLabor.push({
				cents: laborCents(minutes, rate.rateCents),
				currency: rate.currency,
			})
		}
	}

	for (const order of orders) {
		if (!order.createdAt || !orderCountsTowardSales(order)) continue
		const day = days.get(localDateOf(order.createdAt, timeZone))
		if (!day) continue
		day.orderCount += 1
		day.sales.push({
			cents: order.subtotalCents,
			currency: order.currency.toUpperCase(),
		})
	}

	return {
		ok: true,
		data: shapeSummary({
			query,
			timeZone,
			locationCurrency:
				staffingTokenLocationCurrency(claims, query.locationId) ?? null,
			days: [...days.values()],
			openEntries,
			unratedWorkedMinutes,
			unratedScheduledMinutes,
			now,
		}),
	}
}

function shapeSummary(input: {
	query: LaborSummaryQuery
	timeZone: string
	locationCurrency: string | null
	days: DayBucket[]
	openEntries: number
	unratedWorkedMinutes: number
	unratedScheduledMinutes: number
	now: Date
}) {
	const everything = input.days.flatMap((day) => [
		...day.labor,
		...day.scheduledLabor,
		...day.sales,
	])
	// Labor percent compares labor to sales, so one currency must cover both.
	const overall = singleCurrencyTotal(everything)
	const mixedCurrency = overall.mixed
	const cents = (amounts: { cents: number; currency: string }[]) =>
		mixedCurrency ? null : singleCurrencyTotal(amounts).cents
	const days = input.days.map((day) => {
		const labor = cents(day.labor)
		const sales = cents(day.sales)
		return {
			date: day.date,
			workedMinutes: day.workedMinutes,
			scheduledMinutes: day.scheduledMinutes,
			laborCents: labor,
			scheduledLaborCents: cents(day.scheduledLabor),
			salesCents: sales,
			orderCount: day.orderCount,
			laborPercent: laborPercent(labor, sales),
		}
	})
	const labor = cents(input.days.flatMap((day) => day.labor))
	const scheduledLabor = cents(input.days.flatMap((day) => day.scheduledLabor))
	const sales = cents(input.days.flatMap((day) => day.sales))
	return {
		locationId: input.query.locationId,
		timeZone: input.timeZone,
		from: input.query.from,
		to: input.query.to,
		currency: mixedCurrency
			? null
			: (overall.currency ?? input.locationCurrency),
		mixedCurrency,
		days,
		totals: {
			workedMinutes: days.reduce((sum, day) => sum + day.workedMinutes, 0),
			scheduledMinutes: days.reduce(
				(sum, day) => sum + day.scheduledMinutes,
				0,
			),
			laborCents: labor,
			scheduledLaborCents: scheduledLabor,
			salesCents: sales,
			orderCount: days.reduce((sum, day) => sum + day.orderCount, 0),
			laborPercent: laborPercent(labor, sales),
			scheduledLaborPercent: laborPercent(scheduledLabor, sales),
		},
		openEntries: input.openEntries,
		unratedWorkedMinutes: input.unratedWorkedMinutes,
		unratedScheduledMinutes: input.unratedScheduledMinutes,
		generatedAt: input.now.toISOString(),
	}
}
