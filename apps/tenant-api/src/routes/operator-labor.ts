import { Hono } from 'hono'
import { timesheetQuerySchema } from '@repo/staffing'

import {
	authenticateStaffing,
	databaseUnavailable,
	invalid,
	noStoreHeaders,
	respond,
} from '../lib/staffing-auth.ts'
import { laborSummary } from '../services/staffing-pay.ts'

export const operatorLaborRoutes = new Hono()

// App mints `canViewPay` only with the pay permission, roster read, and the
// `staffing.pay` flag, so the claim is the gate here.
operatorLaborRoutes.get('/labor-summary', async (c) => {
	const auth = await authenticateStaffing(c, 'staff', 'read')
	if ('error' in auth) return auth.error
	if (auth.auth.claims.canViewPay !== true) {
		return c.json({ error: 'pay_required' }, 403, noStoreHeaders)
	}
	const parsed = timesheetQuerySchema.safeParse(c.req.query())
	if (!parsed.success) return invalid(c, parsed.error)
	try {
		return respond(
			c,
			await laborSummary(auth.auth.orgId, auth.auth.claims, parsed.data),
			'summary',
		)
	} catch (error) {
		return databaseUnavailable(c, auth.auth.orgId, error)
	}
})
