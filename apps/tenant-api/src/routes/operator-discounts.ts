import {
	DISCOUNT_USAGE_MAX_IDS,
	discountUsageIdSchema,
	discountUsageResponseSchema,
} from '@repo/discounts'
import { getTenantDb } from '@repo/tenant-db'
import { Hono } from 'hono'
import { verifyDiscountOperatorToken } from '../lib/discount-auth.ts'
import { readDiscountUsage } from '../services/discount-apply.ts'

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
	const usage = await readDiscountUsage(
		await getTenantDb(verified.context.orgId),
		ids,
		{ from: from || undefined, to: to || undefined },
		verified.context.locationIds,
	)
	return c.json(discountUsageResponseSchema.parse({ usage }), 200, {
		'Cache-Control': 'no-store',
	})
})
