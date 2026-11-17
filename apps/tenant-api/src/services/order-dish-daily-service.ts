/**
 * Daily quantity caps per dish or modifier option (#409), the data layer.
 *
 * What counts: every order claims its units of each capped dish or option in
 * `order_dish_daily_claims`, one row per order and counter key. A claim is
 * `held` while an online order waits for payment (an "open cart" holding
 * stock), `sold` once the order counts, and `released` when it is cancelled,
 * rejected, expired or sent to payment review. The state is derived from the
 * order itself (`dailyDishClaimState`) and kept in step by a trigger on
 * `restaurant_orders` (migration 0050), so no code path that changes an order
 * can forget it, and repeating an event cannot count a dish twice.
 *
 * The allowance is the configured limit (read live from the order context, so
 * editing it mid-day takes effect at once) plus the day's top-ups, minus
 * claims that are held or sold. The business date is the location's own day
 * (its time zone and day start), so a 01:00 order still belongs to the dinner
 * shift's day.
 *
 * Placement checks and records inside the org lock and the placement
 * transaction, so two guests cannot both take the last unit.
 */
import {
	collectDailyDishLimits,
	dailyDishDemand,
	dailyDishLinesFromStored,
	type DailyDishDemandLine,
	type DailyDishLimitEntry,
} from '@repo/common/daily-dish-catalog'
import {
	DAILY_DISH_SOLD_OUT_CODE,
	type DailyDishAvailability,
	dailyDishClaimState,
	dailyDishRemaining,
	dailyDishShowsRemaining,
	parseDailyDishKey,
} from '@repo/common/daily-dish-limits'
import type { RestaurantOrderContext } from '@repo/common/restaurant-orders'
import {
	orderDishDailyClaims,
	orderDishDailyTopups,
	type RestaurantOrder,
	type TenantDatabase,
	type TenantTransaction,
} from '@repo/tenant-db'
import { businessDateOf, isValidTimeZone } from '@repo/zoned-time'
import { and, eq, inArray, sql } from 'drizzle-orm'

import { insertRowsInChunks } from '../lib/chunked-in.ts'
import { resolveLocationTime } from './inventory-location-settings.ts'

type Reader = TenantDatabase | TenantTransaction

type DailyContext = Pick<RestaurantOrderContext, 'menu' | 'dailyDishLimits'>

export type DailyDishStatusRow = DailyDishLimitEntry & {
	toppedUpUnits: number
	soldUnits: number
	heldUnits: number
	/** Units still orderable today. */
	remaining: number
}

export type DailyDishStatus = {
	enabled: boolean
	/** The location's business date the figures belong to. */
	businessDate: string
	rows: DailyDishStatusRow[]
}

export type DailyDishFailure = {
	status: 422
	code: typeof DAILY_DISH_SOLD_OUT_CODE
	message: string
	details: {
		/** Every dish or option that cannot cover the order, by counter key. */
		short: Array<{
			key: string
			kind: 'item' | 'option'
			id: string
			/** Only when the operator allows "Only N left"; otherwise never sent. */
			remaining?: number
		}>
	}
}

/** The location's business date for an instant: its zone and day start. */
export async function dailyDishBusinessDate(
	db: Reader,
	context: Pick<RestaurantOrderContext, 'menu'>,
	locationId: string,
	atMs: number,
): Promise<string> {
	const location = context.menu.locations.find((l) => l.id === locationId)
	const time = await resolveLocationTime(db, locationId)
	const zone =
		location?.timezone && isValidTimeZone(location.timezone)
			? location.timezone
			: (time.timeZone ?? 'UTC')
	return businessDateOf(atMs, zone, time.dayStartMin)
}

type Usage = { soldUnits: number; heldUnits: number; toppedUpUnits: number }

async function readUsage(
	db: Reader,
	locationId: string,
	businessDate: string,
): Promise<Map<string, Usage>> {
	const usage = new Map<string, Usage>()
	const entry = (key: string): Usage => {
		let value = usage.get(key)
		if (!value) {
			value = { soldUnits: 0, heldUnits: 0, toppedUpUnits: 0 }
			usage.set(key, value)
		}
		return value
	}
	const claims = await db
		.select({
			key: orderDishDailyClaims.catalogKey,
			state: orderDishDailyClaims.state,
			units: sql<number>`coalesce(sum(${orderDishDailyClaims.units}), 0)`,
		})
		.from(orderDishDailyClaims)
		.where(
			and(
				eq(orderDishDailyClaims.locationId, locationId),
				eq(orderDishDailyClaims.businessDate, businessDate),
				inArray(orderDishDailyClaims.state, ['held', 'sold']),
			),
		)
		.groupBy(orderDishDailyClaims.catalogKey, orderDishDailyClaims.state)
	for (const row of claims) {
		const value = entry(row.key)
		if (row.state === 'held') value.heldUnits += Number(row.units)
		else value.soldUnits += Number(row.units)
	}
	const topups = await db
		.select({
			key: orderDishDailyTopups.catalogKey,
			units: orderDishDailyTopups.toppedUpUnits,
		})
		.from(orderDishDailyTopups)
		.where(
			and(
				eq(orderDishDailyTopups.locationId, locationId),
				eq(orderDishDailyTopups.businessDate, businessDate),
			),
		)
	for (const row of topups) entry(row.key).toppedUpUnits = row.units
	return usage
}

function statusRow(
	entry: DailyDishLimitEntry,
	usage: Usage | undefined,
): DailyDishStatusRow {
	const used = usage ?? { soldUnits: 0, heldUnits: 0, toppedUpUnits: 0 }
	return {
		...entry,
		...used,
		remaining: dailyDishRemaining({
			limit: entry.limit,
			toppedUpUnits: used.toppedUpUnits,
			soldUnits: used.soldUnits,
			heldUnits: used.heldUnits,
		}),
	}
}

/** Today's figures for every capped dish and option at a location. */
export async function readDailyDishStatus(
	db: Reader,
	context: DailyContext,
	locationId: string,
	now: Date,
): Promise<DailyDishStatus> {
	const limits = collectDailyDishLimits(context.dailyDishLimits, locationId)
	const businessDate = await dailyDishBusinessDate(
		db,
		context,
		locationId,
		now.getTime(),
	)
	if (limits.size === 0) {
		return {
			enabled: context.dailyDishLimits?.enabled === true,
			businessDate,
			rows: [],
		}
	}
	const usage = await readUsage(db, locationId, businessDate)
	const rows = [...limits.values()]
		.map((entry) => statusRow(entry, usage.get(entry.key)))
		.sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key))
	return { enabled: true, businessDate, rows }
}

/**
 * What a guest page may know: sold out, and (only when the operator turned
 * "Only N left" on) a low number. A cap that is not shown never appears.
 */
export async function readDailyDishAvailability(
	db: Reader,
	context: DailyContext,
	locationId: string,
	now: Date,
): Promise<DailyDishAvailability> {
	const status = await readDailyDishStatus(db, context, locationId, now)
	const out: DailyDishAvailability = {}
	for (const row of status.rows) {
		if (row.remaining === 0) {
			out[row.key] = { remaining: 0, showRemaining: false }
		} else if (
			dailyDishShowsRemaining({
				showRemaining: row.showRemaining,
				remaining: row.remaining,
			})
		) {
			out[row.key] = { remaining: row.remaining, showRemaining: true }
		}
	}
	return out
}

/**
 * Refuses an order that would take more of a capped dish or option than is
 * left. Reads only, so the quote path and placement share it; placement
 * calls it inside its transaction, where nothing else can claim meanwhile.
 */
export async function assertDailyDishCapacity(input: {
	db: Reader
	context: DailyContext
	locationId: string
	lines: readonly DailyDishDemandLine[]
	now: Date
}): Promise<{ ok: true } | { ok: false; failure: DailyDishFailure }> {
	const limits = collectDailyDishLimits(
		input.context.dailyDishLimits,
		input.locationId,
	)
	if (limits.size === 0) return { ok: true }
	const demand = dailyDishDemand(input.lines)
	const capped = [...demand].filter(([key]) => limits.has(key))
	if (capped.length === 0) return { ok: true }

	const businessDate = await dailyDishBusinessDate(
		input.db,
		input.context,
		input.locationId,
		input.now.getTime(),
	)
	const usage = await readUsage(input.db, input.locationId, businessDate)
	const short: DailyDishFailure['details']['short'] = []
	let first: { entry: DailyDishLimitEntry; remaining: number } | null = null
	for (const [key, units] of capped) {
		const entry = limits.get(key)!
		const { remaining } = statusRow(entry, usage.get(key))
		if (units <= remaining) continue
		const parsed = parseDailyDishKey(key)
		if (!parsed) continue
		first ??= { entry, remaining }
		short.push({
			key,
			kind: parsed.kind,
			id: parsed.id,
			...(entry.showRemaining && remaining > 0 ? { remaining } : {}),
		})
	}
	if (!first) return { ok: true }
	const { entry, remaining } = first
	const message =
		remaining === 0
			? `${entry.name} is sold out for today.`
			: entry.showRemaining
				? `Only ${remaining} ${entry.name} left today. Please lower the quantity.`
				: `There isn't enough ${entry.name} left today. Please lower the quantity or choose something else.`
	return {
		ok: false,
		failure: {
			status: 422,
			code: DAILY_DISH_SOLD_OUT_CODE,
			message,
			details: { short },
		},
	}
}

/**
 * Records what a placed order claims. Runs in the placement transaction, right
 * after the order row exists; the trigger keeps the state in step afterwards.
 */
export async function recordDailyDishClaims(input: {
	tx: TenantTransaction
	context: DailyContext
	order: Pick<
		RestaurantOrder,
		'id' | 'locationId' | 'lines' | 'status' | 'paymentMethod' | 'paymentStatus'
	>
	now: Date
}): Promise<void> {
	const limits = collectDailyDishLimits(
		input.context.dailyDishLimits,
		input.order.locationId,
	)
	if (limits.size === 0) return
	const demand = dailyDishDemand(dailyDishLinesFromStored(input.order.lines))
	const claimed = [...demand].filter(([key]) => limits.has(key))
	if (claimed.length === 0) return
	const businessDate = await dailyDishBusinessDate(
		input.tx,
		input.context,
		input.order.locationId,
		input.now.getTime(),
	)
	const state = dailyDishClaimState(input.order)
	const at = input.now.getTime()
	await insertRowsInChunks(
		orderDishDailyClaims,
		claimed.map(([catalogKey, units]) => ({
			orderId: input.order.id,
			locationId: input.order.locationId,
			businessDate,
			catalogKey,
			units,
			state,
			createdAt: at,
			updatedAt: at,
		})),
		(chunk) => input.tx.insert(orderDishDailyClaims).values(chunk),
	)
}
