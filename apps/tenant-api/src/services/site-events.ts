import { and, asc, eq, gte, lte, sql } from 'drizzle-orm'
import {
	siteEventsDaily,
	getTenantDb,
	type TenantDatabase,
} from '@repo/tenant-db'
import {
	buildFunnel,
	changeInPoints,
	previousPeriod,
	SITE_DEVICES,
	SITE_ENTRIES,
	type FunnelStep,
	type SiteEventBody,
	type SiteEventName,
} from '@repo/common/site-funnel'
import { z } from 'zod'

/**
 * Funnel counts of the public site (#179, #338). The table holds counts per
 * day, location, event, device class, entry and test arm: no visitor id, no
 * address, no user agent. A visit is de-duplicated by the browser, so the
 * server only adds one.
 */

const DISABLED_VALUES = new Set(['false', '0', 'off', 'no', 'disabled'])

/**
 * Kill switch for this node (`SITE_EVENTS_ENABLED`; unset or `true` is on):
 * the endpoint answers 204 and counts nothing, so Sites never errors.
 */
export function siteEventsDisabled(): boolean {
	const raw = process.env.SITE_EVENTS_ENABLED
	if (!raw) return false
	return DISABLED_VALUES.has(raw.trim().toLowerCase())
}

/** The day in UTC: counts are per calendar day and never finer. */
export function eventDay(now: number): string {
	return new Date(now).toISOString().slice(0, 10)
}

export async function countSiteEvent(
	orgId: string,
	body: Pick<
		SiteEventBody,
		'event' | 'device' | 'entry' | 'locationId' | 'variant'
	>,
	options: { now?: number; db?: TenantDatabase } = {},
): Promise<void> {
	const db = options.db ?? (await getTenantDb(orgId))
	await db
		.insert(siteEventsDaily)
		.values({
			date: eventDay(options.now ?? Date.now()),
			locationId: body.locationId ?? '',
			event: body.event,
			device: body.device,
			entry: body.entry,
			variant: body.variant ?? '',
			count: 1,
		})
		.onConflictDoUpdate({
			target: [
				siteEventsDaily.date,
				siteEventsDaily.locationId,
				siteEventsDaily.event,
				siteEventsDaily.device,
				siteEventsDaily.entry,
				siteEventsDaily.variant,
			],
			set: { count: sql`${siteEventsDaily.count} + 1` },
		})
}

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

export const funnelQuerySchema = z
	.object({
		from: dateSchema,
		to: dateSchema,
		locationId: z
			.string()
			.max(64)
			.regex(/^[A-Za-z0-9_-]*$/)
			.optional(),
		device: z.enum(SITE_DEVICES).optional(),
		entry: z.enum(SITE_ENTRIES).optional(),
	})
	.refine((value) => value.from <= value.to, { message: 'range' })
	.refine(
		(value) =>
			Date.parse(`${value.to}T00:00:00Z`) -
				Date.parse(`${value.from}T00:00:00Z`) <=
			366 * 86_400_000,
		{ message: 'range_too_long' },
	)

export type FunnelQuery = z.infer<typeof funnelQuerySchema>

async function readSteps(db: TenantDatabase, query: FunnelQuery) {
	const rows = await db
		.select({
			event: siteEventsDaily.event,
			count: sql<number>`sum(${siteEventsDaily.count})`,
		})
		.from(siteEventsDaily)
		.where(
			and(
				gte(siteEventsDaily.date, query.from),
				lte(siteEventsDaily.date, query.to),
				// Test arms are read by the experiments route, not mixed in here:
				// the funnel counts each visit once, whichever arm it saw.
				query.locationId !== undefined
					? eq(siteEventsDaily.locationId, query.locationId)
					: undefined,
				query.device ? eq(siteEventsDaily.device, query.device) : undefined,
				query.entry ? eq(siteEventsDaily.entry, query.entry) : undefined,
			),
		)
		.groupBy(siteEventsDaily.event)
		.orderBy(asc(siteEventsDaily.event))
	return buildFunnel(
		rows.map((row) => ({
			event: row.event as SiteEventName,
			count: Number(row.count) || 0,
		})),
	)
}

export type FunnelResponse = {
	steps: Array<
		FunnelStep & {
			previousCount: number
			/** Change of the step's share of visits against the previous period, in points. */
			changePoints: number | null
		}
	>
	period: { from: string; to: string }
	previous: { from: string; to: string }
}

export async function readFunnel(
	db: TenantDatabase,
	query: FunnelQuery,
): Promise<FunnelResponse> {
	const previous = previousPeriod(query)
	const [current, before] = await Promise.all([
		readSteps(db, query),
		readSteps(db, { ...query, ...previous }),
	])
	return {
		steps: current.map((step, index) => ({
			...step,
			previousCount: before[index]!.count,
			changePoints: changeInPoints(
				step.rateFromStart,
				before[index]!.rateFromStart,
			),
		})),
		period: { from: query.from, to: query.to },
		previous,
	}
}

/** Visits and orders per test arm, from the beginning of the test. */
export async function readExperimentCounts(
	db: TenantDatabase,
	experimentId: string,
	from: string,
): Promise<{
	a: { visits: number; orders: number }
	b: { visits: number; orders: number }
}> {
	const result = {
		a: { visits: 0, orders: 0 },
		b: { visits: 0, orders: 0 },
	}
	for (const arm of ['a', 'b'] as const) {
		const rows = await db
			.select({
				event: siteEventsDaily.event,
				count: sql<number>`sum(${siteEventsDaily.count})`,
			})
			.from(siteEventsDaily)
			.where(
				and(
					eq(siteEventsDaily.variant, `${experimentId}:${arm}`),
					gte(siteEventsDaily.date, from),
				),
			)
			.groupBy(siteEventsDaily.event)
		for (const row of rows) {
			if (row.event === 'visit') result[arm].visits = Number(row.count) || 0
			if (row.event === 'order') result[arm].orders = Number(row.count) || 0
		}
	}
	return result
}
