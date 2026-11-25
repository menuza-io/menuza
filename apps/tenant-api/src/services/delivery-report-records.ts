import { anonymousDriverLabel } from '@repo/reports/token'
import {
	definitionRange,
	resolveTimeframeRange,
	type FilterCondition,
	type ReportDefinition,
	type ReportRecord,
} from '@repo/reports'
import { isValidTimeZone } from '@repo/reservations'
import {
	deliveryRuns,
	deliveryRunStops,
	restaurantOrders,
	staffMembers,
	type TenantDatabase,
} from '@repo/tenant-db'
import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm'
import { loadOrderStepRows } from './order-steps.ts'
import { fetchOrderContext } from './order-service.ts'

/**
 * Records for the own-driver delivery reports (#324), read from the regional run
 * and stop tables and the order step rows. A record holds a zone, minutes and
 * money; a guest's name, phone and address are never read here. The driver's
 * name is staff data: it is put on a record only when the token carries the
 * staff grant (`includeStaffNames`), otherwise the record says "Driver 1",
 * "Driver 2" and the totals stay.
 */

export const DELIVERY_REPORT_MAX_ROWS = 50_000

export type DeliveryReportContext = {
	db: TenantDatabase
	orgId: string
	/** The token's locations; null is every location, an empty list none. */
	locationIds: readonly string[] | null
	now: Date
	includeStaffNames: boolean
	/** Zone names by id; read from the organization's locations when left out. */
	zoneNames?: ReadonlyMap<string, string>
}

type StopFact = {
	stopId: string
	driverStaffId: string
	driverName: string
	locationId: string
	locationName: string
	timeZone: string
	zoneId: string
	status: 'delivered' | 'problem'
	problemKind: string | null
	endedAt: number
	pickedUpAt: number | null
	readyAt: number | null
	placedAt: number
	promisedAt: number | null
	cashCollectedCents: number
	tipCents: number
	currency: string
}

const MINUTE_MS = 60_000
const minutes = (from: number, to: number) =>
	Math.round(((to - from) / MINUTE_MS) * 10) / 10

/** Zone names by id for the whole organization (ids stand in when it cannot be read). */
async function zoneNamesFor(
	orgId: string,
): Promise<ReadonlyMap<string, string>> {
	const names = new Map<string, string>()
	try {
		const context = await fetchOrderContext(orgId, null, null)
		if (context.ok) {
			for (const location of context.data.menu.locations) {
				for (const zone of location.deliveryZones ?? []) {
					if (zone.name) names.set(zone.id, zone.name)
				}
			}
		}
	} catch {
		// Names are a courtesy: the id stands in.
	}
	return names
}

/** The stops that ended in a window, with everything the figures need. */
async function loadStopFacts(
	ctx: DeliveryReportContext,
	window: { fromMs: number; toMs: number },
	options: { locationId?: string | null } = {},
): Promise<{ facts: StopFact[]; truncated: boolean }> {
	if (ctx.locationIds !== null && ctx.locationIds.length === 0) {
		return { facts: [], truncated: false }
	}
	const endedAt = sql<number>`coalesce(${deliveryRunStops.deliveredAt}, ${deliveryRunStops.problemAt})`
	const conditions: SQL[] = [
		inArray(deliveryRunStops.status, ['delivered', 'problem']),
		sql`${endedAt} >= ${window.fromMs}`,
		sql`${endedAt} <= ${window.toMs}`,
	]
	if (ctx.locationIds !== null) {
		// bounded: the token's locations mirror the control plane's (well under 100).
		conditions.push(inArray(deliveryRuns.locationId, [...ctx.locationIds]))
	}
	if (options.locationId) {
		conditions.push(eq(deliveryRuns.locationId, options.locationId))
	}
	const rows = await ctx.db
		.select({
			stopId: deliveryRunStops.id,
			orderId: deliveryRunStops.orderId,
			driverStaffId: deliveryRuns.driverStaffId,
			firstName: staffMembers.firstName,
			lastName: staffMembers.lastName,
			locationId: deliveryRuns.locationId,
			locationName: restaurantOrders.locationName,
			locationTimezone: restaurantOrders.locationTimezone,
			pickupTimezone: restaurantOrders.pickupTimezone,
			zoneId: deliveryRunStops.zoneId,
			status: deliveryRunStops.status,
			problemKind: deliveryRunStops.problemKind,
			endedAt,
			pickedUpAt: deliveryRunStops.pickedUpAt,
			cashCollectedCents: deliveryRunStops.cashCollectedCents,
			createdAt: restaurantOrders.createdAt,
			promisedAt: restaurantOrders.promisedAt,
			promisedUntil: restaurantOrders.promisedUntil,
			tipCents: restaurantOrders.tipCents,
			currency: restaurantOrders.currency,
		})
		.from(deliveryRunStops)
		.innerJoin(deliveryRuns, eq(deliveryRuns.id, deliveryRunStops.runId))
		.innerJoin(restaurantOrders, eq(restaurantOrders.id, deliveryRunStops.orderId))
		.innerJoin(staffMembers, eq(staffMembers.id, deliveryRuns.driverStaffId))
		.where(and(...conditions))
		.orderBy(desc(endedAt))
		.limit(DELIVERY_REPORT_MAX_ROWS + 1)
	const truncated = rows.length > DELIVERY_REPORT_MAX_ROWS
	const used = truncated ? rows.slice(0, DELIVERY_REPORT_MAX_ROWS) : rows
	const steps = await loadOrderStepRows(
		ctx.db,
		used.map((row) => row.orderId),
	)
	const facts = used.flatMap((row): StopFact[] => {
		if (row.endedAt == null) return []
		let readyAt: number | null = null
		for (const step of steps.get(row.orderId) ?? []) {
			if (step.step === 'ready') readyAt = step.event === 'done' ? step.at : null
		}
		const zone = [row.locationTimezone, row.pickupTimezone].find(
			(candidate): candidate is string =>
				Boolean(candidate) && isValidTimeZone(candidate!),
		)
		const promised = row.promisedUntil ?? row.promisedAt
		return [
			{
				stopId: row.stopId,
				driverStaffId: row.driverStaffId,
				driverName: [row.firstName, row.lastName].filter(Boolean).join(' '),
				locationId: row.locationId,
				locationName: row.locationName ?? '',
				timeZone: zone ?? '',
				zoneId: row.zoneId ?? '',
				status: row.status as 'delivered' | 'problem',
				problemKind: row.problemKind ?? null,
				endedAt: Number(row.endedAt),
				pickedUpAt: row.pickedUpAt ?? null,
				readyAt,
				placedAt: row.createdAt ? row.createdAt.getTime() : 0,
				promisedAt: promised ? promised.getTime() : null,
				cashCollectedCents: row.cashCollectedCents,
				tipCents: row.tipCents,
				currency: row.currency || 'USD',
			},
		]
	})
	return { facts, truncated }
}

/**
 * Who each driver is called in this report: the name for a member who may see
 * staff names, else "Driver 1", "Driver 2" by the order of the drivers' ids (the
 * same order every run, so a row can be opened again).
 */
function driverLabels(
	facts: readonly StopFact[],
	includeStaffNames: boolean,
): Map<string, { label: string; key: string }> {
	const ids = [...new Set(facts.map((fact) => fact.driverStaffId))].sort()
	const out = new Map<string, { label: string; key: string }>()
	ids.forEach((id, index) => {
		const fact = facts.find((candidate) => candidate.driverStaffId === id)!
		out.set(
			id,
			includeStaffNames
				? { label: fact.driverName || anonymousDriverLabel(index + 1), key: id }
				: { label: anonymousDriverLabel(index + 1), key: `driver-${index + 1}` },
		)
	})
	return out
}

const allows = (value: string, condition: FilterCondition) => {
	const wanted = condition.value
	switch (condition.operator) {
		case 'eq':
			return value === String(wanted)
		case 'neq':
			return value !== String(wanted)
		case 'in':
			return Array.isArray(wanted) && wanted.includes(value)
		default:
			return true
	}
}

/** One record per delivery (or problem) in the report's window. */
export async function loadDeliveryRecords(
	ctx: DeliveryReportContext,
	definition: ReportDefinition,
): Promise<{ records: ReportRecord[]; truncated: boolean }> {
	const range = resolveTimeframeRange(
		definition.timeframe.preset,
		ctx.now,
		definition.timeframe,
	)
	const { facts, truncated } = await loadStopFacts(ctx, {
		fromMs: range.start ? range.start.getTime() : 0,
		toMs: Math.min(range.end.getTime(), ctx.now.getTime()),
	})
	const zoneNames = ctx.zoneNames ?? (await zoneNamesFor(ctx.orgId))
	const drivers = driverLabels(facts, ctx.includeStaffNames)
	const records = facts.map((fact): ReportRecord => {
		const driver = drivers.get(fact.driverStaffId)!
		const delivered = fact.status === 'delivered'
		const pickedUp = fact.pickedUpAt
		const promised = fact.promisedAt
		const lateMinutes =
			delivered && promised !== null ? minutes(promised, fact.endedAt) : null
		return {
			deliveredAt: new Date(fact.endedAt),
			driver: driver.label,
			driverKey: driver.key,
			location: fact.locationName,
			locationId: fact.locationId,
			locationTimeZone: fact.timeZone,
			zone: zoneNames.get(fact.zoneId) ?? fact.zoneId,
			outcome: fact.status,
			deliveries: delivered ? 1 : 0,
			minutesReadyToPickedUp:
				fact.readyAt !== null && pickedUp !== null && pickedUp >= fact.readyAt
					? minutes(fact.readyAt, pickedUp)
					: null,
			minutesPickedUpToDelivered:
				delivered && pickedUp !== null && fact.endedAt >= pickedUp
					? minutes(pickedUp, fact.endedAt)
					: null,
			minutesActual:
				delivered && fact.placedAt > 0 ? minutes(fact.placedAt, fact.endedAt) : null,
			minutesPromised:
				promised !== null && fact.placedAt > 0 && promised >= fact.placedAt
					? minutes(fact.placedAt, promised)
					: null,
			minutesLate: lateMinutes,
			lateDeliveries: lateMinutes !== null && lateMinutes > 0 ? 1 : 0,
			promisedDeliveries: lateMinutes !== null ? 1 : 0,
			cashCollected: delivered ? fact.cashCollectedCents / 100 : 0,
			tips: delivered ? fact.tipCents / 100 : 0,
			problems: delivered ? 0 : 1,
			problemKind: fact.problemKind ?? 'none',
			currency: fact.currency,
		}
	})
	return { records, truncated }
}

function average(values: ReadonlyArray<number | null>): number | null {
	const present = values.filter((value): value is number => value !== null)
	if (present.length === 0) return null
	return Math.round((present.reduce((a, b) => a + b, 0) / present.length) * 10) / 10
}

/**
 * One record per driver (and currency) for the report's period: the deliveries
 * figures added up, with the driver's name only for a member who may see it. A
 * `location` filter is applied here, because a driver's record spans every
 * location they worked (see `splitLoaderFilters`).
 */
export async function loadDriverSummaryRecords(
	ctx: DeliveryReportContext,
	definition: ReportDefinition,
	options: { timeZone: string; loaderFilters: readonly FilterCondition[] },
): Promise<{ records: ReportRecord[]; truncated: boolean }> {
	const range = definitionRange(definition, ctx.now, options.timeZone)
	const toMs = Math.min(range.end.getTime(), ctx.now.getTime())
	const fromMs = range.start ? range.start.getTime() : 0
	if (toMs < fromMs) return { records: [], truncated: false }
	const { facts, truncated } = await loadStopFacts(ctx, { fromMs, toMs })
	const wanted = facts.filter((fact) =>
		options.loaderFilters.every((condition) => {
			if (condition.field === 'locationId') return allows(fact.locationId, condition)
			if (condition.field === 'location') return allows(fact.locationName, condition)
			return true
		}),
	)
	const drivers = driverLabels(wanted, ctx.includeStaffNames)
	const groups = new Map<string, StopFact[]>()
	for (const fact of wanted) {
		const key = `${fact.driverStaffId}|${fact.currency}`
		groups.set(key, [...(groups.get(key) ?? []), fact])
	}
	const periodEnd = new Date(toMs)
	const records = [...groups.values()].map((group): ReportRecord => {
		const first = group[0]!
		const driver = drivers.get(first.driverStaffId)!
		const delivered = group.filter((fact) => fact.status === 'delivered')
		return {
			periodEnd,
			driver: driver.label,
			driverKey: driver.key,
			// Placeholders: the loader already applied these.
			location: '',
			locationId: '',
			locationTimeZone: '',
			deliveries: delivered.length,
			avgMinutesReadyToPickedUp: average(
				group.map((fact) =>
					fact.readyAt !== null && fact.pickedUpAt !== null && fact.pickedUpAt >= fact.readyAt
						? minutes(fact.readyAt, fact.pickedUpAt)
						: null,
				),
			),
			avgMinutesPickedUpToDelivered: average(
				delivered.map((fact) =>
					fact.pickedUpAt !== null && fact.endedAt >= fact.pickedUpAt
						? minutes(fact.pickedUpAt, fact.endedAt)
						: null,
				),
			),
			lateDeliveries: delivered.filter(
				(fact) => fact.promisedAt !== null && fact.endedAt > fact.promisedAt,
			).length,
			cashCollected: delivered.reduce((sum, fact) => sum + fact.cashCollectedCents, 0) / 100,
			tips: delivered.reduce((sum, fact) => sum + fact.tipCents, 0) / 100,
			problems: group.length - delivered.length,
			currency: first.currency,
		}
	})
	return { records, truncated }
}
