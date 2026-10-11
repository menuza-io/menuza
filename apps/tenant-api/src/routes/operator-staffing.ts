import { Hono } from 'hono'
import { z } from 'zod'
import {
	POSITION_COLOR_KEYS,
	positionInputSchema,
	ROSTER_IMPORT_MAX_ROWS,
	staffingSettingsSchema,
	staffMemberInputSchema,
	staffRatesInputSchema,
	staffTerminationSchema,
} from '@repo/staffing'

import {
	authenticateStaffing,
	databaseUnavailable,
	invalid,
	noStoreHeaders,
	readJson,
	respond,
} from '../lib/staffing-auth.ts'
import {
	createPosition,
	createStaff,
	getRosterContext,
	importStaff,
	listStaff,
	listStaffEvents,
	rehireStaff,
	saveStaffingSettings,
	setStaffRates,
	terminateStaff,
	updatePosition,
	updateStaff,
} from '../services/staffing-roster.ts'
import { operatorLaborRoutes } from './operator-labor.ts'
import { operatorScheduleRoutes } from './operator-schedule.ts'
import { operatorTimeclockRoutes } from './operator-timeclock.ts'

export const operatorStaffingRoutes = new Hono()

const idParam = z.string().trim().min(1).max(64)

operatorStaffingRoutes.get('/context', async (c) => {
	const auth = await authenticateStaffing(c, 'staff', 'read')
	if ('error' in auth) return auth.error
	try {
		const context = await getRosterContext(auth.auth.orgId)
		return c.json(
			{
				...context,
				access: {
					areas: auth.auth.claims.areas,
					canViewPay: auth.auth.claims.canViewPay === true,
					locationIds: auth.auth.claims.locationIds,
				},
			},
			200,
			noStoreHeaders,
		)
	} catch (error) {
		return databaseUnavailable(c, auth.auth.orgId, error)
	}
})

operatorStaffingRoutes.get('/staff', async (c) => {
	const auth = await authenticateStaffing(c, 'staff', 'read')
	if ('error' in auth) return auth.error
	const status = z
		.enum(['active', 'terminated'])
		.optional()
		.safeParse(c.req.query('status') || undefined)
	if (!status.success) return invalid(c, status.error)
	try {
		const staff = await listStaff(auth.auth.orgId, auth.auth.claims, {
			status: status.data,
		})
		return c.json({ staff }, 200, noStoreHeaders)
	} catch (error) {
		return databaseUnavailable(c, auth.auth.orgId, error)
	}
})

operatorStaffingRoutes.post('/staff', async (c) => {
	const auth = await authenticateStaffing(c, 'staff', 'write')
	if ('error' in auth) return auth.error
	const parsed = staffMemberInputSchema.safeParse(await readJson(c))
	if (!parsed.success) return invalid(c, parsed.error)
	try {
		return respond(
			c,
			await createStaff(auth.auth.orgId, auth.auth, parsed.data),
			'staff',
		)
	} catch (error) {
		return databaseUnavailable(c, auth.auth.orgId, error)
	}
})

operatorStaffingRoutes.post('/staff/import', async (c) => {
	const auth = await authenticateStaffing(c, 'staff', 'write')
	if ('error' in auth) return auth.error
	const parsed = z
		.object({
			text: z
				.string()
				.max(ROSTER_IMPORT_MAX_ROWS * 400)
				.min(1),
			locationId: idParam,
			createPositions: z.boolean().default(true),
		})
		.safeParse(await readJson(c))
	if (!parsed.success) return invalid(c, parsed.error)
	try {
		return respond(
			c,
			await importStaff(auth.auth.orgId, auth.auth, parsed.data),
			'result',
		)
	} catch (error) {
		return databaseUnavailable(c, auth.auth.orgId, error)
	}
})

operatorStaffingRoutes.patch('/staff/:id', async (c) => {
	const auth = await authenticateStaffing(c, 'staff', 'write')
	if ('error' in auth) return auth.error
	const id = idParam.safeParse(c.req.param('id'))
	const parsed = staffMemberInputSchema.safeParse(await readJson(c))
	if (!id.success) return invalid(c, id.error)
	if (!parsed.success) return invalid(c, parsed.error)
	try {
		return respond(
			c,
			await updateStaff(auth.auth.orgId, auth.auth, id.data, parsed.data),
			'staff',
		)
	} catch (error) {
		return databaseUnavailable(c, auth.auth.orgId, error)
	}
})

// Rates are pay: roster write alone is not enough.
operatorStaffingRoutes.put('/staff/:id/rates', async (c) => {
	const auth = await authenticateStaffing(c, 'staff', 'write')
	if ('error' in auth) return auth.error
	if (auth.auth.claims.canViewPay !== true) {
		return c.json({ error: 'pay_required' }, 403, noStoreHeaders)
	}
	const id = idParam.safeParse(c.req.param('id'))
	const parsed = staffRatesInputSchema.safeParse(await readJson(c))
	if (!id.success) return invalid(c, id.error)
	if (!parsed.success) return invalid(c, parsed.error)
	try {
		return respond(
			c,
			await setStaffRates(auth.auth.orgId, auth.auth, id.data, parsed.data),
			'staff',
		)
	} catch (error) {
		return databaseUnavailable(c, auth.auth.orgId, error)
	}
})

operatorStaffingRoutes.post('/staff/:id/terminate', async (c) => {
	const auth = await authenticateStaffing(c, 'staff', 'write')
	if ('error' in auth) return auth.error
	const id = idParam.safeParse(c.req.param('id'))
	const parsed = staffTerminationSchema.safeParse(await readJson(c))
	if (!id.success) return invalid(c, id.error)
	if (!parsed.success) return invalid(c, parsed.error)
	try {
		return respond(
			c,
			await terminateStaff(auth.auth.orgId, auth.auth, id.data, parsed.data),
			'staff',
		)
	} catch (error) {
		return databaseUnavailable(c, auth.auth.orgId, error)
	}
})

operatorStaffingRoutes.post('/staff/:id/rehire', async (c) => {
	const auth = await authenticateStaffing(c, 'staff', 'write')
	if ('error' in auth) return auth.error
	const id = idParam.safeParse(c.req.param('id'))
	if (!id.success) return invalid(c, id.error)
	try {
		return respond(
			c,
			await rehireStaff(auth.auth.orgId, auth.auth, id.data),
			'staff',
		)
	} catch (error) {
		return databaseUnavailable(c, auth.auth.orgId, error)
	}
})

operatorStaffingRoutes.get('/staff/:id/events', async (c) => {
	const auth = await authenticateStaffing(c, 'staff', 'read')
	if ('error' in auth) return auth.error
	const id = idParam.safeParse(c.req.param('id'))
	if (!id.success) return invalid(c, id.error)
	try {
		return respond(
			c,
			await listStaffEvents(auth.auth.orgId, auth.auth.claims, id.data),
			'events',
		)
	} catch (error) {
		return databaseUnavailable(c, auth.auth.orgId, error)
	}
})

operatorStaffingRoutes.post('/positions', async (c) => {
	const auth = await authenticateStaffing(c, 'staff', 'write')
	if ('error' in auth) return auth.error
	const parsed = positionInputSchema.safeParse(await readJson(c))
	if (!parsed.success) return invalid(c, parsed.error)
	try {
		return respond(
			c,
			await createPosition(auth.auth.orgId, auth.auth, parsed.data),
			'position',
		)
	} catch (error) {
		return databaseUnavailable(c, auth.auth.orgId, error)
	}
})

operatorStaffingRoutes.patch('/positions/:id', async (c) => {
	const auth = await authenticateStaffing(c, 'staff', 'write')
	if ('error' in auth) return auth.error
	const id = idParam.safeParse(c.req.param('id'))
	const parsed = z
		.object({
			name: positionInputSchema.shape.name.optional(),
			colorKey: z.enum(POSITION_COLOR_KEYS).optional(),
			archived: z.boolean().optional(),
		})
		.strict()
		.safeParse(await readJson(c))
	if (!id.success) return invalid(c, id.error)
	if (!parsed.success) return invalid(c, parsed.error)
	try {
		return respond(
			c,
			await updatePosition(auth.auth.orgId, auth.auth, id.data, parsed.data),
			'position',
		)
	} catch (error) {
		return databaseUnavailable(c, auth.auth.orgId, error)
	}
})

operatorStaffingRoutes.put('/settings', async (c) => {
	const auth = await authenticateStaffing(c, 'staff', 'write')
	if ('error' in auth) return auth.error
	const parsed = staffingSettingsSchema.safeParse(await readJson(c))
	if (!parsed.success) return invalid(c, parsed.error)
	try {
		const settings = await saveStaffingSettings(
			auth.auth.orgId,
			auth.auth,
			parsed.data,
		)
		return c.json({ settings }, 200, noStoreHeaders)
	} catch (error) {
		return databaseUnavailable(c, auth.auth.orgId, error)
	}
})

operatorStaffingRoutes.route('/', operatorScheduleRoutes)
operatorStaffingRoutes.route('/', operatorTimeclockRoutes)
operatorStaffingRoutes.route('/', operatorLaborRoutes)
