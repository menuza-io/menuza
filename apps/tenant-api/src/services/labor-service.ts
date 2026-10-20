import { and, eq, isNull } from 'drizzle-orm'
import {
	businessDateOf,
	computeLaborSummary,
	type LaborCardFact,
	type LaborScopeQuery,
	type LaborRangeQuery,
	type LaborSettingsUpdate,
	type LaborSettingsView,
	type LaborSummaryView,
	laborSummaryTable,
	type SalesBulk,
	type SalesBulkResult,
	type SalesEntriesView,
	type SalesEntryPut,
	type SalesEntryView,
	type SalesSource,
	salesSourceUsesOrders,
	timesheetTableToCsv,
	neutralizeCsvCell,
	type LaborExport,
	type LaborPositionView,
} from '@repo/staffing'
import {
	laborScopeSettings,
	salesManualEntries,
	staffPositions,
	type TenantDatabase,
} from '@repo/tenant-db'
import {
	businessRangeSeconds,
	loadLaborSettings,
	loadManualSales,
	loadOrderBuckets,
	manualSalesFacts,
	orderSalesFacts,
	toSalesEntryView,
} from './labor-data.ts'
import { FrameCache, requireFrame } from './schedule-shared.ts'
import { transact } from './schedule-shift-service.ts'
import { writeStaffAudit } from './staff-audit.ts'
import { loadRange } from './timesheet-view-service.ts'
import {
	fail,
	moneyAccess,
	ok,
	type TimesheetContext,
	type TimesheetResult,
} from './timesheet-shared.ts'
import { inJsonList } from '../lib/chunked-in.ts'

/**
 * The labor summary: hours, estimated wages and sales for one scope, one
 * row per business day, plus the settings and manual sales behind it.
 *
 * Everything is derived on read from time cards (priced by the same shared
 * math the timesheets use) and sales (counted online orders, or the sales the
 * team entered). A token without the labor grant never reaches this code, and
 * impersonated sessions are refused here too, so a support login never sees
 * wages. A scope outside the token's scope answers 404 (reads) or 403
 * (writes that name it in the body), the same as the schedule.
 */

export type LaborContext = TimesheetContext & { db: TenantDatabase }

/** The settings and sales tables are shared by every scope the token covers. */
async function scopeFrame(
	ctx: LaborContext,
	frames: FrameCache,
	scopeId: unknown,
	denied: 'not_found' | 'scope_out_of_scope',
) {
	return requireFrame(ctx, frames, scopeId, denied)
}

function laborAccess(ctx: LaborContext): TimesheetResult<null> {
	// The aggregate labor grant, or anyone who can see each wage. An
	// impersonated (support) session never sees wages.
	if (!moneyAccess(ctx.auth).labor) return fail(403, 'forbidden')
	return ok(null)
}

/** "Today" for a scope: its business date under the workday rule. */
function today(
	ctx: Pick<LaborContext, 'now'>,
	frame: { timeZone: string; rules: { workdayStartMinute: number } },
): string {
	return businessDateOf(ctx.now, frame.timeZone, frame.rules.workdayStartMinute)
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function getLaborSettings(
	ctx: LaborContext,
	query: LaborScopeQuery,
): Promise<TimesheetResult<LaborSettingsView>> {
	const denied = laborAccess(ctx)
	if (!denied.ok) return denied
	const frames = new FrameCache(ctx)
	const framed = await scopeFrame(ctx, frames, query.scopeId, 'not_found')
	if (!framed.ok) return framed
	return ok(await loadLaborSettings(ctx.db, query.scopeId))
}

export async function updateLaborSettings(
	ctx: LaborContext,
	input: LaborSettingsUpdate,
): Promise<TimesheetResult<LaborSettingsView>> {
	const denied = laborAccess(ctx)
	if (!denied.ok) return denied
	const frames = new FrameCache(ctx)
	const framed = await scopeFrame(
		ctx,
		frames,
		input.scopeId,
		'scope_out_of_scope',
	)
	if (!framed.ok) return framed

	if (input.ordersPerLaborHour) {
		const ids = Object.keys(input.ordersPerLaborHour)
		if (ids.length > 0) {
			const found = await ctx.db
				.select({ id: staffPositions.id })
				.from(staffPositions)
				.where(
					and(
						inJsonList(staffPositions.id, ids),
						isNull(staffPositions.archivedAt),
					),
				)
			const known = new Set(found.map((row) => row.id))
			const unknown = ids.filter((id) => !known.has(id))
			if (unknown.length > 0) {
				return fail(422, 'unknown_position', {
					positionIds: unknown.slice(0, 20),
				})
			}
		}
	}

	return transact(ctx.db, async (tx) => {
		const before = await loadLaborSettings(tx, input.scopeId)
		const next = {
			salesSource: input.salesSource ?? before.salesSource,
			ordersPerLaborHour: input.ordersPerLaborHour ?? before.ordersPerLaborHour,
		}
		await tx
			.insert(laborScopeSettings)
			.values({
				scopeId: input.scopeId,
				...next,
				updatedBy: ctx.auth.userId,
				updatedAt: ctx.now,
			})
			.onConflictDoUpdate({
				target: laborScopeSettings.scopeId,
				set: { ...next, updatedBy: ctx.auth.userId, updatedAt: ctx.now },
			})
		await writeStaffAudit(tx, ctx.auth, ctx.ipHash, {
			action: 'labor.settings.updated',
			entityType: 'labor_settings',
			entityId: input.scopeId,
			scopeId: input.scopeId,
			changes: {
				salesSource: { before: before.salesSource, after: next.salesSource },
				// Standards are numbers per position id: no names, no money.
				standards: {
					before: Object.keys(before.ordersPerLaborHour).length,
					after: Object.keys(next.ordersPerLaborHour).length,
				},
			},
		})
		return ok({
			scopeId: input.scopeId,
			...next,
			configured: true,
			updatedAt: ctx.now,
		})
	})
}

/**
 * The positions a standard or a tip percentage can be set for. Names only: the
 * labor token does not carry the roster grant of the staff scope, and no pay
 * rate rides along.
 */
export async function listLaborPositions(
	ctx: LaborContext,
): Promise<TimesheetResult<{ positions: LaborPositionView[] }>> {
	const denied = laborAccess(ctx)
	if (!denied.ok) return denied
	const rows = await ctx.db
		.select({
			id: staffPositions.id,
			name: staffPositions.name,
			nameAr: staffPositions.nameAr,
		})
		.from(staffPositions)
		.where(isNull(staffPositions.archivedAt))
		.orderBy(staffPositions.name)
		.limit(200)
	return ok({ positions: rows })
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

/** The facts behind a summary, loaded once for a view and for its export. */
export async function buildLaborSummary(
	ctx: LaborContext,
	query: LaborRangeQuery,
): Promise<TimesheetResult<LaborSummaryView>> {
	const frames = new FrameCache(ctx)
	const framed = await scopeFrame(ctx, frames, query.scopeId, 'not_found')
	if (!framed.ok) return framed
	const frame = framed.value
	const settings = await loadLaborSettings(ctx.db, query.scopeId)

	const { lives, truncated } = await loadRange(ctx, {
		scopeId: query.scopeId,
		fromDate: query.from,
		toDate: query.to,
	})
	const cards: LaborCardFact[] = lives.map((live) => ({
		staffId: live.entry.staffId,
		date: live.entry.localDate,
		paidMinutes: live.figures.paidMinutes,
		overtimeMinutes:
			live.figures.overtimeMinutes + live.figures.doubleTimeMinutes,
		costUnits: live.figures.costUnits,
		currency: live.figures.costCurrency,
		unpricedMinutes: live.figures.unpricedMinutes,
		open: live.entry.clockOutAt === null,
	}))

	let sales
	if (salesSourceUsesOrders(settings.salesSource)) {
		const { fromSeconds, toSeconds } = businessRangeSeconds(
			query.from,
			query.to,
			frame.timeZone,
			frame.rules.workdayStartMinute,
		)
		const buckets = await loadOrderBuckets(
			ctx.db,
			query.scopeId,
			fromSeconds,
			toSeconds,
			frame.rules.workdayStartMinute,
		)
		sales = orderSalesFacts(
			buckets,
			frame.timeZone,
			frame.rules.workdayStartMinute,
			{ from: query.from, to: query.to },
		)
	} else {
		sales = manualSalesFacts(
			await loadManualSales(ctx.db, query.scopeId, query.from, query.to),
		)
	}

	return ok(
		computeLaborSummary({
			scopeId: query.scopeId,
			timeZone: frame.timeZone,
			from: query.from,
			to: query.to,
			salesSource: settings.salesSource,
			targetBp: frame.policy.laborTargetBp,
			cards,
			sales,
			truncated,
		}),
	)
}

export async function loadLaborSummary(
	ctx: LaborContext,
	query: LaborRangeQuery,
): Promise<TimesheetResult<LaborSummaryView>> {
	const denied = laborAccess(ctx)
	if (!denied.ok) return denied
	return buildLaborSummary(ctx, query)
}

/** The plain-language name of a sales source, as it appears in an export. */
const SOURCE_LABEL: Record<SalesSource, string> = {
	online_orders: 'Online orders only (not all sales)',
	online_only: 'Online orders (all sales)',
	manual: 'Entered sales',
}

export async function exportLaborSummary(
	ctx: LaborContext,
	query: LaborRangeQuery,
): Promise<TimesheetResult<LaborExport>> {
	const denied = laborAccess(ctx)
	if (!denied.ok) return denied
	const built = await buildLaborSummary(ctx, query)
	if (!built.ok) return built
	if (built.value.truncated) return fail(422, 'range_too_large')
	const table = laborSummaryTable(built.value, {
		sourceLabel: SOURCE_LABEL[built.value.salesSource],
		includeMoney: true,
	})
	await writeStaffAudit(ctx.db, ctx.auth, ctx.ipHash, {
		action: 'labor.exported',
		entityType: 'labor_summary',
		scopeId: query.scopeId,
		changes: { from: query.from, to: query.to, rows: table.rows.length },
	})
	return ok({
		filename: `labor-summary_${query.from}_${query.to}.csv`,
		kind: 'labor_summary',
		rowCount: table.rows.length,
		headers: table.headers,
		rows: table.rows.map((row) =>
			row.map((cell) =>
				typeof cell === 'string' ? neutralizeCsvCell(cell) : cell,
			),
		),
		csv: timesheetTableToCsv(table),
	})
}

// ---------------------------------------------------------------------------
// Manual sales
// ---------------------------------------------------------------------------

export async function listSales(
	ctx: LaborContext,
	query: LaborRangeQuery,
): Promise<TimesheetResult<SalesEntriesView>> {
	const denied = laborAccess(ctx)
	if (!denied.ok) return denied
	const frames = new FrameCache(ctx)
	const framed = await scopeFrame(ctx, frames, query.scopeId, 'not_found')
	if (!framed.ok) return framed
	const rows = await loadManualSales(
		ctx.db,
		query.scopeId,
		query.from,
		query.to,
	)
	return ok({
		scopeId: query.scopeId,
		from: query.from,
		to: query.to,
		entries: rows.map(toSalesEntryView),
	})
}

/** Sales are never entered for a day that has not happened (by the business-day rule). */
async function futureDates(
	ctx: LaborContext,
	scopeId: string,
	dates: readonly string[],
): Promise<TimesheetResult<string[]>> {
	const frames = new FrameCache(ctx)
	const framed = await scopeFrame(ctx, frames, scopeId, 'scope_out_of_scope')
	if (!framed.ok) return framed
	const limit = today(ctx, framed.value)
	return ok(dates.filter((date) => date > limit).sort())
}

export async function putSale(
	ctx: LaborContext,
	input: SalesEntryPut,
): Promise<TimesheetResult<SalesEntryView>> {
	const denied = laborAccess(ctx)
	if (!denied.ok) return denied
	const future = await futureDates(ctx, input.scopeId, [input.date])
	if (!future.ok) return future
	if (future.value.length > 0) return fail(422, 'future_date')

	return transact(ctx.db, async (tx) => {
		const [existing] = await tx
			.select()
			.from(salesManualEntries)
			.where(
				and(
					eq(salesManualEntries.scopeId, input.scopeId),
					eq(salesManualEntries.businessDate, input.date),
				),
			)
			.limit(1)
		const note = input.note ?? null
		if (existing) {
			await tx
				.update(salesManualEntries)
				.set({
					netSalesMinor: input.netSalesMinor,
					currency: input.currency,
					source: 'manual',
					note,
					updatedBy: ctx.auth.userId,
					updatedAt: ctx.now,
				})
				.where(eq(salesManualEntries.id, existing.id))
		} else {
			await tx.insert(salesManualEntries).values({
				scopeId: input.scopeId,
				businessDate: input.date,
				netSalesMinor: input.netSalesMinor,
				currency: input.currency,
				source: 'manual',
				note,
				createdBy: ctx.auth.userId,
				updatedBy: ctx.auth.userId,
				createdAt: ctx.now,
				updatedAt: ctx.now,
			})
		}
		const [row] = await tx
			.select()
			.from(salesManualEntries)
			.where(
				and(
					eq(salesManualEntries.scopeId, input.scopeId),
					eq(salesManualEntries.businessDate, input.date),
				),
			)
			.limit(1)
		await writeStaffAudit(tx, ctx.auth, ctx.ipHash, {
			action: existing ? 'labor.sales.updated' : 'labor.sales.created',
			entityType: 'sales_entry',
			entityId: row!.id,
			scopeId: input.scopeId,
			changes: {
				date: input.date,
				before: existing ? existing.netSalesMinor : null,
				after: input.netSalesMinor,
			},
		})
		return ok(toSalesEntryView(row!))
	})
}

export async function deleteSale(
	ctx: LaborContext,
	query: { scopeId: string; date: string },
): Promise<TimesheetResult<{ deleted: true }>> {
	const denied = laborAccess(ctx)
	if (!denied.ok) return denied
	const frames = new FrameCache(ctx)
	const framed = await scopeFrame(
		ctx,
		frames,
		query.scopeId,
		'scope_out_of_scope',
	)
	if (!framed.ok) return framed
	return transact(ctx.db, async (tx) => {
		const [existing] = await tx
			.select()
			.from(salesManualEntries)
			.where(
				and(
					eq(salesManualEntries.scopeId, query.scopeId),
					eq(salesManualEntries.businessDate, query.date),
				),
			)
			.limit(1)
		if (!existing) return fail(404, 'not_found')
		await tx
			.delete(salesManualEntries)
			.where(eq(salesManualEntries.id, existing.id))
		await writeStaffAudit(tx, ctx.auth, ctx.ipHash, {
			action: 'labor.sales.deleted',
			entityType: 'sales_entry',
			entityId: existing.id,
			scopeId: query.scopeId,
			changes: { date: query.date, before: existing.netSalesMinor },
		})
		return ok({ deleted: true as const })
	})
}

export async function bulkSales(
	ctx: LaborContext,
	input: SalesBulk,
): Promise<TimesheetResult<SalesBulkResult>> {
	const denied = laborAccess(ctx)
	if (!denied.ok) return denied
	const future = await futureDates(
		ctx,
		input.scopeId,
		input.entries.map((entry) => entry.date),
	)
	if (!future.ok) return future
	if (future.value.length > 0) {
		return fail(422, 'future_date', { dates: future.value.slice(0, 20) })
	}

	return transact(ctx.db, async (tx) => {
		const dates = input.entries.map((entry) => entry.date).sort()
		const existing = await loadManualSales(
			tx,
			input.scopeId,
			dates[0]!,
			dates.at(-1)!,
		)
		const byDate = new Map(existing.map((row) => [row.businessDate, row]))
		const result: SalesBulkResult = { created: 0, updated: 0, unchanged: 0 }
		for (const entry of input.entries) {
			const note = entry.note ?? null
			const current = byDate.get(entry.date)
			if (!current) {
				await tx.insert(salesManualEntries).values({
					scopeId: input.scopeId,
					businessDate: entry.date,
					netSalesMinor: entry.netSalesMinor,
					currency: input.currency,
					source: 'csv',
					note,
					createdBy: ctx.auth.userId,
					updatedBy: ctx.auth.userId,
					createdAt: ctx.now,
					updatedAt: ctx.now,
				})
				result.created += 1
			} else if (
				current.netSalesMinor === entry.netSalesMinor &&
				current.currency === input.currency &&
				current.note === note
			) {
				result.unchanged += 1
			} else {
				await tx
					.update(salesManualEntries)
					.set({
						netSalesMinor: entry.netSalesMinor,
						currency: input.currency,
						source: 'csv',
						note,
						updatedBy: ctx.auth.userId,
						updatedAt: ctx.now,
					})
					.where(eq(salesManualEntries.id, current.id))
				result.updated += 1
			}
		}
		await writeStaffAudit(tx, ctx.auth, ctx.ipHash, {
			action: 'labor.sales.imported',
			entityType: 'sales_entry',
			scopeId: input.scopeId,
			changes: {
				from: dates[0],
				to: dates.at(-1),
				...result,
			},
		})
		return ok(result)
	})
}
