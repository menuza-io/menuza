/**
 * Google listing performance (#136, flag `gbp.insights`). Daily totals per
 * location (views, calls, directions, clicks, conversations) and the top
 * monthly search phrases, stored in the control plane as aggregate business
 * data. Nothing here is about an individual person.
 *
 *  - First run for a location backfills up to 18 months (Google's limit) in
 *    windows of about three months.
 *  - Every day after, the last 7 days are fetched again (Google's data lags and
 *    is corrected), and each (location, day, metric) is an upsert, so a day is
 *    never duplicated.
 *  - Locations that are not verified are skipped ("No data until your profile
 *    is verified"). Disconnecting keeps the stored figures.
 */
import {
	GBP_REFETCH_DAYS,
	backfillStart,
	lastSearchMonth,
	comparePeriods,
	type PerformanceComparison,
} from '@repo/common/gbp-metrics'
import {
	and,
	db,
	desc,
	eq,
	gte,
	GbpDailyMetric,
	GbpSearchKeyword,
	GbpLocationSync,
	inArray,
	sql,
} from '@repo/database'
import { type GbpClient, gbpClientFor } from '@repo/integrations'
import {
	type GbpContext,
	gbpFlags,
	recordGbpError,
	recordGbpEvent,
	saveSync,
} from './context.server.ts'

/** Rows per `INSERT`: the control plane allows 100 bound parameters. */
const ROWS_PER_INSERT = 12
/** Insert statements per `db.batch`. */
const STATEMENTS_PER_BATCH = 40
const BACKFILL_WINDOW_DAYS = 90
const TOP_KEYWORDS = 20

function isoDay(date: Date) {
	return date.toISOString().slice(0, 10)
}

function addDays(iso: string, days: number) {
	const date = new Date(`${iso}T00:00:00Z`)
	date.setUTCDate(date.getUTCDate() + days)
	return isoDay(date)
}

/** Upserts the rows; a re-fetched day replaces its value. */
export async function upsertDailyMetrics(
	organizationId: string,
	locationId: string,
	rows: ReadonlyArray<{ date: string; metric: string; value: number }>,
) {
	if (rows.length === 0) return
	const statements = []
	for (let index = 0; index < rows.length; index += ROWS_PER_INSERT) {
		const chunk = rows.slice(index, index + ROWS_PER_INSERT)
		statements.push(
			db
				.insert(GbpDailyMetric)
				.values(
					chunk.map((row) => ({
						organizationId,
						organizationLocationId: locationId,
						date: row.date,
						metric: row.metric,
						value: row.value,
					})),
				)
				.onConflictDoUpdate({
					target: [
						GbpDailyMetric.organizationLocationId,
						GbpDailyMetric.date,
						GbpDailyMetric.metric,
					],
					set: { value: sql`excluded.value`, updatedAt: new Date() },
				}),
		)
	}
	for (
		let index = 0;
		index < statements.length;
		index += STATEMENTS_PER_BATCH
	) {
		const batch = statements.slice(index, index + STATEMENTS_PER_BATCH)
		await db.batch(
			batch as [(typeof batch)[number], ...(typeof batch)[number][]],
		)
	}
}

export type MetricsRunResult = {
	status: 'fetched' | 'backfilled' | 'skipped' | 'failed'
	reason?: string
	days?: number
}

/**
 * Fetches a location's metrics: the full backfill the first time, the last
 * seven days afterwards (or `backfill: true` to redo it).
 */
export async function fetchLocationMetrics(input: {
	ctx: GbpContext
	now?: Date
	backfill?: boolean
	client?: GbpClient
}): Promise<MetricsRunResult> {
	const { ctx } = input
	const now = input.now ?? new Date()
	const flags = await gbpFlags(ctx.organization.id)
	if (!flags.insights) return { status: 'skipped', reason: 'flag_off' }
	if (
		!ctx.integration?.isActive ||
		ctx.sync.verificationState !== 'verified' ||
		ctx.sync.state === 'suspended' ||
		ctx.sync.state === 'access_lost' ||
		ctx.sync.state === 'token_expired'
	) {
		return { status: 'skipped', reason: 'not_verified' }
	}
	const backfill = input.backfill || !ctx.sync.metricsBackfilledAt
	const today = isoDay(now)
	// Google's newest day is a few days old; asking up to yesterday is fine.
	const end = addDays(today, -1)
	const start = backfill
		? backfillStart(now)
		: addDays(end, -(GBP_REFETCH_DAYS - 1))
	try {
		const client = input.client ?? (await gbpClientFor(ctx.integration))
		const name = ctx.sync.googleLocationName
		let fetched = 0
		let newest = ctx.sync.metricsDataUntil ?? ''
		for (
			let from = start;
			from <= end;
			from = addDays(from, BACKFILL_WINDOW_DAYS)
		) {
			const to =
				addDays(from, BACKFILL_WINDOW_DAYS - 1) < end
					? addDays(from, BACKFILL_WINDOW_DAYS - 1)
					: end
			const series = await client.fetchDailyMetrics(name, from, to)
			await upsertDailyMetrics(ctx.organization.id, ctx.location.id, series)
			fetched += series.length
			for (const point of series) if (point.date > newest) newest = point.date
		}
		await refreshSearchKeywords(ctx, client, now)
		await saveSync(ctx.sync.id, {
			metricsBackfilledAt: ctx.sync.metricsBackfilledAt ?? now,
			metricsDataUntil: newest || null,
		})
		await recordGbpEvent({
			sync: ctx.sync,
			kind: 'pull',
			field: 'metrics',
			summary: backfill
				? 'Google performance history loaded'
				: 'Google performance updated',
			request: { start, end },
			result: 'accepted',
		})
		return { status: backfill ? 'backfilled' : 'fetched', days: fetched }
	} catch (error) {
		const known = await recordGbpError(ctx, error)
		if (!known) throw error
		return { status: 'failed', reason: known.code }
	}
}

/** The previous month's top search phrases (and the one before, once). */
async function refreshSearchKeywords(
	ctx: GbpContext,
	client: GbpClient,
	now: Date,
) {
	const months = [lastSearchMonth(now)]
	const previous = new Date(
		Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1),
	)
	months.push(previous.toISOString().slice(0, 7))
	for (const month of months) {
		const found = await client.listSearchKeywords(
			ctx.sync.googleLocationName,
			month,
		)
		const top = [...found]
			.sort(
				(a, b) => (b.value ?? b.threshold ?? 0) - (a.value ?? a.threshold ?? 0),
			)
			.slice(0, TOP_KEYWORDS)
		for (let index = 0; index < top.length; index += 8) {
			const chunk = top.slice(index, index + 8)
			await db
				.insert(GbpSearchKeyword)
				.values(
					chunk.map((entry) => ({
						organizationId: ctx.organization.id,
						organizationLocationId: ctx.location.id,
						month,
						keyword: entry.keyword.slice(0, 200),
						value: entry.value,
						threshold: entry.threshold,
					})),
				)
				.onConflictDoUpdate({
					target: [
						GbpSearchKeyword.organizationLocationId,
						GbpSearchKeyword.month,
						GbpSearchKeyword.keyword,
					],
					set: {
						value: sql`excluded.value`,
						threshold: sql`excluded.threshold`,
						updatedAt: new Date(),
					},
				})
		}
	}
}

// ---------------------------------------------------------------------------
// Reading (reports and the dashboard)
// ---------------------------------------------------------------------------

export type LocationScope = readonly string[] | null

/** Daily rows for the organization's locations the viewer may see. */
export async function loadDailyMetricRows(
	organizationId: string,
	scope: LocationScope,
	options: { since?: string } = {},
) {
	if (scope !== null && scope.length === 0) return []
	const conditions = [eq(GbpDailyMetric.organizationId, organizationId)]
	if (scope !== null) {
		conditions.push(
			inArray(GbpDailyMetric.organizationLocationId, [...scope].slice(0, 90)),
		)
	}
	if (options.since) conditions.push(gte(GbpDailyMetric.date, options.since))
	return db
		.select({
			locationId: GbpDailyMetric.organizationLocationId,
			date: GbpDailyMetric.date,
			metric: GbpDailyMetric.metric,
			value: GbpDailyMetric.value,
		})
		.from(GbpDailyMetric)
		.where(and(...conditions))
		.orderBy(desc(GbpDailyMetric.date))
}

export async function loadKeywordRows(
	organizationId: string,
	scope: LocationScope,
) {
	if (scope !== null && scope.length === 0) return []
	const conditions = [eq(GbpSearchKeyword.organizationId, organizationId)]
	if (scope !== null) {
		conditions.push(
			inArray(GbpSearchKeyword.organizationLocationId, [...scope].slice(0, 90)),
		)
	}
	return db
		.select({
			locationId: GbpSearchKeyword.organizationLocationId,
			month: GbpSearchKeyword.month,
			keyword: GbpSearchKeyword.keyword,
			value: GbpSearchKeyword.value,
			threshold: GbpSearchKeyword.threshold,
		})
		.from(GbpSearchKeyword)
		.where(and(...conditions))
}

export type LocationPerformance = {
	locationId: string
	locationName: string
	/** Why there is no data, if so. */
	state: 'ok' | 'not_verified' | 'not_connected' | 'no_data'
	comparison: PerformanceComparison | null
}

/** The dashboard block: 28 days against the 28 before, per location. */
export async function loadPerformanceByLocation(
	organizationId: string,
	scope: LocationScope,
	locations: ReadonlyArray<{ id: string; name: string }>,
): Promise<LocationPerformance[]> {
	const visible = locations.filter(
		(location) => scope === null || scope.includes(location.id),
	)
	if (visible.length === 0) return []
	const [rows, syncs] = await Promise.all([
		loadDailyMetricRows(organizationId, scope, {
			since: addDays(isoDay(new Date()), -200),
		}),
		db
			.select({
				locationId: GbpLocationSync.organizationLocationId,
				verificationState: GbpLocationSync.verificationState,
			})
			.from(GbpLocationSync)
			.where(eq(GbpLocationSync.organizationId, organizationId)),
	])
	const syncByLocation = new Map(
		syncs.map((entry) => [entry.locationId, entry]),
	)
	return visible.map((location) => {
		const sync = syncByLocation.get(location.id)
		const own = rows.filter((row) => row.locationId === location.id)
		const comparison = comparePeriods(own)
		const state: LocationPerformance['state'] =
			own.length > 0
				? 'ok'
				: !sync
					? 'not_connected'
					: sync.verificationState !== 'verified'
						? 'not_verified'
						: 'no_data'
		return {
			locationId: location.id,
			locationName: location.name,
			state,
			comparison: own.length > 0 ? comparison : null,
		}
	})
}
