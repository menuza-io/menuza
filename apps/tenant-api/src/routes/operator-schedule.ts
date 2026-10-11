import { Hono } from 'hono'
import { z } from 'zod'
import {
	copyWeekSchema,
	publishScheduleSchema,
	scheduleWeekSchema,
	shiftCreateSchema,
	shiftInputSchema,
} from '@repo/staffing'

import {
	authenticateStaffing,
	databaseUnavailable,
	invalid,
	readJson,
	respond,
} from '../lib/staffing-auth.ts'
import { publishSchedule } from '../services/schedule-publish.ts'
import {
	copyWeek,
	createShifts,
	deleteShift,
	getSchedule,
	listPublications,
	restoreShift,
	updateShift,
} from '../services/staffing-schedule.ts'

export const operatorScheduleRoutes = new Hono()

const idParam = z.string().trim().min(1).max(64)

operatorScheduleRoutes.get('/schedule', async (c) => {
	const auth = await authenticateStaffing(c, 'schedule', 'read')
	if ('error' in auth) return auth.error
	const parsed = scheduleWeekSchema.safeParse({
		locationId: c.req.query('locationId'),
		weekStart: c.req.query('weekStart'),
	})
	if (!parsed.success) return invalid(c, parsed.error)
	try {
		return respond(
			c,
			await getSchedule(auth.auth.orgId, auth.auth.claims, parsed.data),
			'schedule',
		)
	} catch (error) {
		return databaseUnavailable(c, auth.auth.orgId, error)
	}
})

operatorScheduleRoutes.get('/schedule/publications', async (c) => {
	const auth = await authenticateStaffing(c, 'schedule', 'read')
	if ('error' in auth) return auth.error
	const parsed = scheduleWeekSchema.safeParse({
		locationId: c.req.query('locationId'),
		weekStart: c.req.query('weekStart'),
	})
	if (!parsed.success) return invalid(c, parsed.error)
	try {
		return respond(
			c,
			await listPublications(auth.auth.orgId, auth.auth.claims, parsed.data),
			'publications',
		)
	} catch (error) {
		return databaseUnavailable(c, auth.auth.orgId, error)
	}
})

operatorScheduleRoutes.post('/shifts', async (c) => {
	const auth = await authenticateStaffing(c, 'schedule', 'write')
	if ('error' in auth) return auth.error
	const parsed = shiftCreateSchema.safeParse(await readJson(c))
	if (!parsed.success) return invalid(c, parsed.error)
	try {
		return respond(
			c,
			await createShifts(auth.auth.orgId, auth.auth, parsed.data),
			'shifts',
		)
	} catch (error) {
		return databaseUnavailable(c, auth.auth.orgId, error)
	}
})

operatorScheduleRoutes.patch('/shifts/:id', async (c) => {
	const auth = await authenticateStaffing(c, 'schedule', 'write')
	if ('error' in auth) return auth.error
	const id = idParam.safeParse(c.req.param('id'))
	const parsed = shiftInputSchema.safeParse(await readJson(c))
	if (!id.success) return invalid(c, id.error)
	if (!parsed.success) return invalid(c, parsed.error)
	try {
		return respond(
			c,
			await updateShift(auth.auth.orgId, auth.auth, id.data, parsed.data),
			'shift',
		)
	} catch (error) {
		return databaseUnavailable(c, auth.auth.orgId, error)
	}
})

operatorScheduleRoutes.delete('/shifts/:id', async (c) => {
	const auth = await authenticateStaffing(c, 'schedule', 'write')
	if ('error' in auth) return auth.error
	const id = idParam.safeParse(c.req.param('id'))
	if (!id.success) return invalid(c, id.error)
	try {
		return respond(
			c,
			await deleteShift(auth.auth.orgId, auth.auth, id.data),
			'result',
		)
	} catch (error) {
		return databaseUnavailable(c, auth.auth.orgId, error)
	}
})

operatorScheduleRoutes.post('/shifts/:id/restore', async (c) => {
	const auth = await authenticateStaffing(c, 'schedule', 'write')
	if ('error' in auth) return auth.error
	const id = idParam.safeParse(c.req.param('id'))
	if (!id.success) return invalid(c, id.error)
	try {
		return respond(
			c,
			await restoreShift(auth.auth.orgId, auth.auth, id.data),
			'shift',
		)
	} catch (error) {
		return databaseUnavailable(c, auth.auth.orgId, error)
	}
})

operatorScheduleRoutes.post('/schedule/copy-week', async (c) => {
	const auth = await authenticateStaffing(c, 'schedule', 'write')
	if ('error' in auth) return auth.error
	const parsed = copyWeekSchema.safeParse(await readJson(c))
	if (!parsed.success) return invalid(c, parsed.error)
	try {
		return respond(
			c,
			await copyWeek(auth.auth.orgId, auth.auth, parsed.data),
			'result',
		)
	} catch (error) {
		return databaseUnavailable(c, auth.auth.orgId, error)
	}
})

operatorScheduleRoutes.post('/schedule/publish', async (c) => {
	const auth = await authenticateStaffing(c, 'schedule', 'write')
	if ('error' in auth) return auth.error
	const parsed = publishScheduleSchema.safeParse(await readJson(c))
	if (!parsed.success) return invalid(c, parsed.error)
	try {
		return respond(
			c,
			await publishSchedule(auth.auth.orgId, auth.auth, parsed.data),
			'result',
		)
	} catch (error) {
		return databaseUnavailable(c, auth.auth.orgId, error)
	}
})
