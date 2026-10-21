import { and, inArray, isNull } from 'drizzle-orm'
import {
	computeTipPool,
	type LaborExport,
	type LaborScopeQuery,
	type LaborRangeQuery,
	neutralizeCsvCell,
	type TipAmount,
	type TipFulfillment,
	type TipPoolPerson,
	type TipPoolReport,
	type TipPoolSettingsUpdate,
	type TipPoolSettingsView,
	tipPoolTable,
	type TipWorkFact,
	timesheetTableToCsv,
} from '@repo/staffing'
import { staffJobs, staffPositions, tipPoolSettings } from '@repo/tenant-db'
import {
	bucketBusinessDate,
	businessRangeSeconds,
	loadOrderBuckets,
	loadTipPoolSettings,
} from './labor-data.ts'
import { type LaborContext } from './labor-service.ts'
import { FrameCache, requireFrame } from './schedule-shared.ts'
import { transact } from './schedule-shift-service.ts'
import { writeStaffAudit } from './staff-audit.ts'
import { loadRange } from './timesheet-view-service.ts'
import {
	fail,
	moneyAccess,
	ok,
	type TimesheetResult,
	UNKNOWN_CURRENCY,
} from './timesheet-shared.ts'
import { inJsonList, queryInChunks } from '../lib/chunked-in.ts'

/**
 * The tip-pool report: online-order tips and declared cash tips of one
 * scope pooled and split by hours (or by position percentage), with a card
 * fee withheld from online tips. A report to help a manager decide, never a
 * payout; whether online tips may be pooled at all differs by market, so which
 * fulfillment types count is a setting and delivery stays out by default.
 *
 * Shares name people and amounts, so the report needs the pay grant (and names
 * need the roster grant); it writes a pay-read audit row like the timesheets.
 */

function payAccess(ctx: LaborContext): TimesheetResult<null> {
	if (!moneyAccess(ctx.auth).person) return fail(403, 'forbidden')
	return ok(null)
}

export async function getTipPoolSettings(
	ctx: LaborContext,
	query: LaborScopeQuery,
): Promise<TimesheetResult<TipPoolSettingsView>> {
	const denied = payAccess(ctx)
	if (!denied.ok) return denied
	const frames = new FrameCache(ctx)
	const framed = await requireFrame(ctx, frames, query.scopeId, 'not_found')
	if (!framed.ok) return framed
	return ok(await loadTipPoolSettings(ctx.db, query.scopeId))
}

export async function updateTipPoolSettings(
	ctx: LaborContext,
	input: TipPoolSettingsUpdate,
): Promise<TimesheetResult<TipPoolSettingsView>> {
	const denied = payAccess(ctx)
	if (!denied.ok) return denied
	const frames = new FrameCache(ctx)
	const framed = await requireFrame(
		ctx,
		frames,
		input.scopeId,
		'scope_out_of_scope',
	)
	if (!framed.ok) return framed

	const ids = Object.keys(input.positionPercentBp)
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

	return transact(ctx.db, async (tx) => {
		const before = await loadTipPoolSettings(tx, input.scopeId)
		const next = {
			splitBasis: input.splitBasis,
			cadence: input.cadence,
			cardFeeBp: input.cardFeeBp,
			fulfillment: [...input.fulfillment].sort(),
			positionPercentBp: input.positionPercentBp,
		}
		await tx
			.insert(tipPoolSettings)
			.values({
				scopeId: input.scopeId,
				...next,
				updatedBy: ctx.auth.userId,
				updatedAt: ctx.now,
			})
			.onConflictDoUpdate({
				target: tipPoolSettings.scopeId,
				set: { ...next, updatedBy: ctx.auth.userId, updatedAt: ctx.now },
			})
		await writeStaffAudit(tx, ctx.auth, ctx.ipHash, {
			action: 'labor.tip_pool.settings.updated',
			entityType: 'tip_pool_settings',
			entityId: input.scopeId,
			scopeId: input.scopeId,
			changes: {
				splitBasis: { before: before.splitBasis, after: next.splitBasis },
				cadence: { before: before.cadence, after: next.cadence },
				cardFeeBp: { before: before.cardFeeBp, after: next.cardFeeBp },
				fulfillment: { before: before.fulfillment, after: next.fulfillment },
			},
		})
		return ok({
			scopeId: input.scopeId,
			...next,
			fulfillment: next.fulfillment as TipFulfillment[],
			configured: true,
			updatedAt: ctx.now,
		})
	})
}

function addAmount(
	map: Map<string, TipAmount[]>,
	currency: string,
	date: string,
	minor: number,
) {
	if (minor === 0) return
	const list = map.get(currency) ?? []
	list.push({ date, minor })
	map.set(currency, list)
}

export async function buildTipPool(
	ctx: LaborContext,
	query: LaborRangeQuery,
): Promise<TimesheetResult<TipPoolReport>> {
	const denied = payAccess(ctx)
	if (!denied.ok) return denied
	const frames = new FrameCache(ctx)
	const framed = await requireFrame(ctx, frames, query.scopeId, 'not_found')
	if (!framed.ok) return framed
	const frame = framed.value
	const settings = await loadTipPoolSettings(ctx.db, query.scopeId)

	const { lives, truncated } = await loadRange(ctx, {
		scopeId: query.scopeId,
		fromDate: query.from,
		toDate: query.to,
	})

	// Tip eligibility is a property of the pay row a card was worked under.
	const jobIds = [
		...new Set(
			lives.flatMap((live) => (live.entry.jobId ? [live.entry.jobId] : [])),
		),
	]
	const eligibleJobs = new Set<string>()
	{
		const rows = await queryInChunks(jobIds, (chunk) =>
			ctx.db
				.select({ id: staffJobs.id, tipEligible: staffJobs.tipEligible })
				.from(staffJobs)
				.where(inArray(staffJobs.id, chunk)),
		)
		for (const row of rows) if (row.tipEligible) eligibleJobs.add(row.id)
	}

	const work: TipWorkFact[] = []
	const cashByCurrency = new Map<string, TipAmount[]>()
	const names = new Map<string, Omit<TipPoolPerson, 'minutes' | 'shareMinor'>>()
	let openCards = 0
	let unapprovedCards = 0
	let ineligibleMinutes = 0
	let undeclaredCurrencyCashTips = 0
	for (const live of lives) {
		const { entry } = live
		if (entry.clockOutAt === null) {
			openCards += 1
			continue
		}
		const eligible = entry.jobId !== null && eligibleJobs.has(entry.jobId)
		if (!eligible) {
			ineligibleMinutes += live.figures.paidMinutes
			continue
		}
		if (live.status !== 'approved' && live.status !== 'locked') {
			unapprovedCards += 1
		}
		work.push({
			date: entry.localDate,
			staffId: entry.staffId,
			positionId: entry.positionId,
			minutes: live.figures.paidMinutes,
		})
		names.set(entry.staffId, {
			staffId: entry.staffId,
			firstName: live.staff.firstName,
			lastName: live.staff.lastName,
			firstNameAr: live.staff.firstNameAr,
			lastNameAr: live.staff.lastNameAr,
			employeeNumber: live.staff.employeeNumber,
		})
		if (entry.cashTipsMinor > 0) {
			const currency = entry.currency?.toUpperCase() ?? UNKNOWN_CURRENCY
			if (currency === UNKNOWN_CURRENCY) undeclaredCurrencyCashTips += 1
			else
				addAmount(
					cashByCurrency,
					currency,
					entry.localDate,
					entry.cashTipsMinor,
				)
		}
	}

	// Online-order tips of the included fulfillment types, by business date.
	const included = new Set<string>(settings.fulfillment)
	const onlineByCurrency = new Map<string, TipAmount[]>()
	if (included.size > 0) {
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
		for (const row of buckets) {
			if (!included.has(row.fulfillment)) continue
			const date = bucketBusinessDate(
				row.bucket,
				frame.timeZone,
				frame.rules.workdayStartMinute,
			)
			if (date < query.from || date > query.to) continue
			addAmount(onlineByCurrency, row.currency, date, row.tipMinor)
		}
	}

	const currencies = [
		...new Set([...onlineByCurrency.keys(), ...cashByCurrency.keys()]),
	].sort()
	const pools = currencies.map((currency) => {
		const outcome = computeTipPool({
			currency,
			settings,
			onlineTips: onlineByCurrency.get(currency) ?? [],
			cashTips: cashByCurrency.get(currency) ?? [],
			work,
		})
		const people: TipPoolPerson[] = outcome.people
			.map((person) => ({ ...names.get(person.staffId)!, ...person }))
			.sort(
				(a, b) =>
					a.lastName.localeCompare(b.lastName) ||
					a.firstName.localeCompare(b.firstName) ||
					a.staffId.localeCompare(b.staffId),
			)
		return { ...outcome, people }
	})

	await writeStaffAudit(ctx.db, ctx.auth, ctx.ipHash, {
		action: 'labor.tips.read',
		entityType: 'tip_pool',
		scopeId: query.scopeId,
		sensitivity: 'pay',
		changes: {
			from: query.from,
			to: query.to,
			people: new Set(work.map((w) => w.staffId)).size,
		},
	})

	return ok({
		estimate: true,
		payout: false,
		scopeId: query.scopeId,
		timeZone: frame.timeZone,
		from: query.from,
		to: query.to,
		settings,
		pools,
		undeclaredCurrencyCashTips,
		openCards,
		unapprovedCards,
		ineligibleMinutes,
		truncated,
	})
}

export async function exportTipPool(
	ctx: LaborContext,
	query: LaborRangeQuery,
): Promise<TimesheetResult<LaborExport>> {
	const built = await buildTipPool(ctx, query)
	if (!built.ok) return built
	if (built.value.truncated) return fail(422, 'range_too_large')
	const table = tipPoolTable(built.value.pools)
	await writeStaffAudit(ctx.db, ctx.auth, ctx.ipHash, {
		action: 'labor.exported',
		entityType: 'tip_pool',
		scopeId: query.scopeId,
		sensitivity: 'pay',
		changes: { from: query.from, to: query.to, rows: table.rows.length },
	})
	return ok({
		filename: `tip-pool_${query.from}_${query.to}.csv`,
		kind: 'tip_pool',
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
