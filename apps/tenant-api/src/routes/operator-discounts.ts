import {
	DISCOUNT_PERFORMANCE_MAX_DAYS,
	DISCOUNT_USAGE_MAX_IDS,
	discountPerformanceQuerySchema,
	discountPerformanceResponseSchema,
	discountUsageIdSchema,
	discountUsageResponseSchema,
	discountWeekKeySchema,
	discountUsedInQuerySchema,
	discountUsedInResponseSchema,
} from '@repo/discounts'
import { addDays, daysBetween, startOfLocalDay } from '@repo/zoned-time'
import { getTenantDb } from '@repo/tenant-db'
import { Hono } from 'hono'
import { verifyDiscountOperatorToken } from '../lib/discount-auth.ts'
import { readDiscountUsage } from '../services/discount-apply.ts'
import { readDiscountPerformance } from '../services/discount-performance.ts'
import { findDiscountUsedIn } from '../services/discount-used-in.ts'

/**
 * Operator discount routes (`/operator/discounts/*`). The App's browser calls
 * them with a short-lived `dsc+jwt`. Usage is counts only: no customer, no code.
 */
export const operatorDiscountRoutes = new Hono()

operatorDiscountRoutes.get('/usage', async (c) => {
	const verified = await verifyDiscountOperatorToken(
		c.req.header('authorization'),
	)
	if (!verified.ok) {
		return c.json({ error: verified.error }, verified.status, {
			'Cache-Control': 'no-store',
		})
	}
	const raw = c.req.query('ids') ?? ''
	const ids = raw
		.split(',')
		.map((id) => id.trim())
		.filter(Boolean)
		.slice(0, DISCOUNT_USAGE_MAX_IDS)
	if (ids.some((id) => !discountUsageIdSchema.safeParse(id).success)) {
		return c.json({ error: 'invalid_request' }, 400, {
			'Cache-Control': 'no-store',
		})
	}
	const from = c.req.query('from') ?? ''
	const to = c.req.query('to') ?? ''
	if (
		(from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) ||
		(to && !/^\d{4}-\d{2}-\d{2}$/.test(to))
	) {
		return c.json({ error: 'invalid_request' }, 400, {
			'Cache-Control': 'no-store',
		})
	}
	const week = c.req.query('week') ?? ''
	if (week && !discountWeekKeySchema.safeParse(week).success) {
		return c.json({ error: 'invalid_request' }, 400, {
			'Cache-Control': 'no-store',
		})
	}
	const usage = await readDiscountUsage(
		await getTenantDb(verified.context.orgId),
		ids,
		{ from: from || undefined, to: to || undefined, week: week || undefined },
		verified.context.locationIds,
	)
	return c.json(discountUsageResponseSchema.parse({ usage }), 200, {
		'Cache-Control': 'no-store',
	})
})

/**
 * Where a discount is promised (#236): the broadcasts waiting to go out or
 * sending, and the automations running, that offer it. Ids, operator-written
 * names and one count: no recipient, no address, no code.
 */
operatorDiscountRoutes.get('/used-in', async (c) => {
	const verified = await verifyDiscountOperatorToken(
		c.req.header('authorization'),
	)
	if (!verified.ok) {
		return c.json({ error: verified.error }, verified.status, {
			'Cache-Control': 'no-store',
		})
	}
	const query = discountUsedInQuerySchema.safeParse({
		discountId: c.req.query('discountId') ?? '',
	})
	if (!query.success) {
		return c.json({ error: 'invalid_request' }, 400, {
			'Cache-Control': 'no-store',
		})
	}
	const usedIn = await findDiscountUsedIn(
		await getTenantDb(verified.context.orgId),
		query.data.discountId,
	)
	return c.json(discountUsedInResponseSchema.parse(usedIn), 200, {
		'Cache-Control': 'no-store',
	})
})

/**
 * How each discount performed over a period (#390): orders, sales and what it
 * gave, by the reports' gross or net rule, plus how many of all sales used a
 * discount. Ids and amounts only (names come from the App). The token's
 * location scope limits every figure.
 */
operatorDiscountRoutes.get('/performance', async (c) => {
	const verified = await verifyDiscountOperatorToken(
		c.req.header('authorization'),
	)
	if (!verified.ok) {
		return c.json({ error: verified.error }, verified.status, {
			'Cache-Control': 'no-store',
		})
	}
	const bad = () =>
		c.json({ error: 'invalid_request' }, 400, { 'Cache-Control': 'no-store' })
	const query = discountPerformanceQuerySchema.safeParse({
		ids: (c.req.query('ids') ?? '')
			.split(',')
			.map((id) => id.trim())
			.filter(Boolean),
		from: c.req.query('from') ?? '',
		to: c.req.query('to') ?? '',
		tz: c.req.query('tz') || undefined,
		basis: c.req.query('basis') || undefined,
	})
	if (!query.success) return bad()
	const { from, to, basis } = query.data
	const tz = query.data.tz ?? 'UTC'
	let fromMs: number
	let toMs: number
	try {
		// A zone the runtime does not know throws a RangeError: a bad request.
		new Intl.DateTimeFormat('en-US', { timeZone: tz })
		fromMs = startOfLocalDay(from, tz)
		// The last day is included: the window ends where the next day starts.
		toMs = startOfLocalDay(addDays(to, 1), tz)
	} catch {
		return bad()
	}
	const days = daysBetween(from, to) + 1
	if (
		!Number.isFinite(fromMs) ||
		!Number.isFinite(toMs) ||
		days < 1 ||
		days > DISCOUNT_PERFORMANCE_MAX_DAYS
	) {
		return bad()
	}
	const performance = await readDiscountPerformance(
		await getTenantDb(verified.context.orgId),
		{
			ids: query.data.ids,
			fromMs,
			toMs,
			basis,
			locationIds: verified.context.locationIds,
		},
	)
	return c.json(discountPerformanceResponseSchema.parse(performance), 200, {
		'Cache-Control': 'no-store',
	})
})
