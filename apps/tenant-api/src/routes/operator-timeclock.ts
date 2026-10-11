import { Hono } from 'hono'
import { z } from 'zod'
import {
	pairingCodeCreateSchema,
	pinSetSchema,
	timeEntryApproveSchema,
	timeEntryCreateSchema,
	timeEntryDeleteSchema,
	timeEntryReopenSchema,
	timeEntryUpdateSchema,
	timesheetQuerySchema,
} from '@repo/staffing'

import {
	authenticateStaffing,
	databaseUnavailable,
	invalid,
	noStoreHeaders,
	readJson,
	respond,
	staffingSwitchEnabled,
} from '../lib/staffing-auth.ts'
import {
	clearStaffPin,
	createPairingCode,
	listKiosks,
	revokeKiosk,
	setStaffPin,
} from '../services/staffing-kiosk.ts'
import {
	approveTimeEntries,
	createTimeEntry,
	deleteTimeEntry,
	getTimesheet,
	reopenTimeEntry,
	timeEntryHistory,
	updateTimeEntry,
} from '../services/staffing-timesheets.ts'

export const operatorTimeclockRoutes = new Hono()

const idParam = z.string().trim().min(1).max(64)

// PINs belong to the roster, so they need staff write rather than timeclock.
operatorTimeclockRoutes.post('/staff/:id/pin', async (c) => {
	const auth = await authenticateStaffing(c, 'staff', 'write')
	if ('error' in auth) return auth.error
	const id = idParam.safeParse(c.req.param('id'))
	const parsed = pinSetSchema.safeParse((await readJson(c)) ?? {})
	if (!id.success) return invalid(c, id.error)
	if (!parsed.success) return invalid(c, parsed.error)
	try {
		return respond(
			c,
			await setStaffPin(auth.auth.orgId, auth.auth, id.data, parsed.data.pin),
			'result',
		)
	} catch (error) {
		return databaseUnavailable(c, auth.auth.orgId, error)
	}
})

operatorTimeclockRoutes.delete('/staff/:id/pin', async (c) => {
	const auth = await authenticateStaffing(c, 'staff', 'write')
	if ('error' in auth) return auth.error
	const id = idParam.safeParse(c.req.param('id'))
	if (!id.success) return invalid(c, id.error)
	try {
		return respond(
			c,
			await clearStaffPin(auth.auth.orgId, auth.auth, id.data),
			'result',
		)
	} catch (error) {
		return databaseUnavailable(c, auth.auth.orgId, error)
	}
})

operatorTimeclockRoutes.get('/kiosks', async (c) => {
	const auth = await authenticateStaffing(c, 'timeclock', 'read')
	if ('error' in auth) return auth.error
	try {
		const kiosks = await listKiosks(auth.auth.orgId, auth.auth.claims)
		return c.json(
			{ kiosks, kioskEnabled: staffingSwitchEnabled('STAFFING_KIOSK_ENABLED') },
			200,
			noStoreHeaders,
		)
	} catch (error) {
		return databaseUnavailable(c, auth.auth.orgId, error)
	}
})

operatorTimeclockRoutes.post('/kiosks/pairing-codes', async (c) => {
	const auth = await authenticateStaffing(c, 'timeclock', 'write')
	if ('error' in auth) return auth.error
	if (!staffingSwitchEnabled('STAFFING_KIOSK_ENABLED')) {
		return c.json({ error: 'kiosk_disabled' }, 503, noStoreHeaders)
	}
	const parsed = pairingCodeCreateSchema.safeParse(await readJson(c))
	if (!parsed.success) return invalid(c, parsed.error)
	try {
		return respond(
			c,
			await createPairingCode(auth.auth.orgId, auth.auth, parsed.data),
			'pairing',
		)
	} catch (error) {
		return databaseUnavailable(c, auth.auth.orgId, error)
	}
})

operatorTimeclockRoutes.post('/kiosks/:id/revoke', async (c) => {
	const auth = await authenticateStaffing(c, 'timeclock', 'write')
	if ('error' in auth) return auth.error
	const id = idParam.safeParse(c.req.param('id'))
	if (!id.success) return invalid(c, id.error)
	try {
		return respond(
			c,
			await revokeKiosk(auth.auth.orgId, auth.auth, id.data),
			'kiosk',
		)
	} catch (error) {
		return databaseUnavailable(c, auth.auth.orgId, error)
	}
})

// ---------------------------------------------------------------------------
// Timesheets. Approval locks a card; it needs timeclock write.
// ---------------------------------------------------------------------------

operatorTimeclockRoutes.get('/timesheets', async (c) => {
	const auth = await authenticateStaffing(c, 'timeclock', 'read')
	if ('error' in auth) return auth.error
	const parsed = timesheetQuerySchema.safeParse(c.req.query())
	if (!parsed.success) return invalid(c, parsed.error)
	try {
		return respond(
			c,
			await getTimesheet(auth.auth.orgId, auth.auth.claims, parsed.data),
			'timesheet',
		)
	} catch (error) {
		return databaseUnavailable(c, auth.auth.orgId, error)
	}
})

operatorTimeclockRoutes.post('/time-entries', async (c) => {
	const auth = await authenticateStaffing(c, 'timeclock', 'write')
	if ('error' in auth) return auth.error
	const parsed = timeEntryCreateSchema.safeParse(await readJson(c))
	if (!parsed.success) return invalid(c, parsed.error)
	try {
		return respond(
			c,
			await createTimeEntry(auth.auth.orgId, auth.auth, parsed.data),
			'entry',
		)
	} catch (error) {
		return databaseUnavailable(c, auth.auth.orgId, error)
	}
})

operatorTimeclockRoutes.post('/time-entries/approve', async (c) => {
	const auth = await authenticateStaffing(c, 'timeclock', 'write')
	if ('error' in auth) return auth.error
	const parsed = timeEntryApproveSchema.safeParse(await readJson(c))
	if (!parsed.success) return invalid(c, parsed.error)
	try {
		return respond(
			c,
			await approveTimeEntries(auth.auth.orgId, auth.auth, parsed.data),
			'result',
		)
	} catch (error) {
		return databaseUnavailable(c, auth.auth.orgId, error)
	}
})

operatorTimeclockRoutes.patch('/time-entries/:id', async (c) => {
	const auth = await authenticateStaffing(c, 'timeclock', 'write')
	if ('error' in auth) return auth.error
	const id = idParam.safeParse(c.req.param('id'))
	const parsed = timeEntryUpdateSchema.safeParse(await readJson(c))
	if (!id.success) return invalid(c, id.error)
	if (!parsed.success) return invalid(c, parsed.error)
	try {
		return respond(
			c,
			await updateTimeEntry(auth.auth.orgId, auth.auth, id.data, parsed.data),
			'entry',
		)
	} catch (error) {
		return databaseUnavailable(c, auth.auth.orgId, error)
	}
})

operatorTimeclockRoutes.delete('/time-entries/:id', async (c) => {
	const auth = await authenticateStaffing(c, 'timeclock', 'write')
	if ('error' in auth) return auth.error
	const id = idParam.safeParse(c.req.param('id'))
	const parsed = timeEntryDeleteSchema.safeParse(await readJson(c))
	if (!id.success) return invalid(c, id.error)
	if (!parsed.success) return invalid(c, parsed.error)
	try {
		return respond(
			c,
			await deleteTimeEntry(
				auth.auth.orgId,
				auth.auth,
				id.data,
				parsed.data.reason,
			),
			'entry',
		)
	} catch (error) {
		return databaseUnavailable(c, auth.auth.orgId, error)
	}
})

operatorTimeclockRoutes.post('/time-entries/:id/reopen', async (c) => {
	const auth = await authenticateStaffing(c, 'timeclock', 'write')
	if ('error' in auth) return auth.error
	const id = idParam.safeParse(c.req.param('id'))
	const parsed = timeEntryReopenSchema.safeParse(await readJson(c))
	if (!id.success) return invalid(c, id.error)
	if (!parsed.success) return invalid(c, parsed.error)
	try {
		return respond(
			c,
			await reopenTimeEntry(
				auth.auth.orgId,
				auth.auth,
				id.data,
				parsed.data.reason,
			),
			'entry',
		)
	} catch (error) {
		return databaseUnavailable(c, auth.auth.orgId, error)
	}
})

operatorTimeclockRoutes.get('/time-entries/:id/history', async (c) => {
	const auth = await authenticateStaffing(c, 'timeclock', 'read')
	if ('error' in auth) return auth.error
	const id = idParam.safeParse(c.req.param('id'))
	if (!id.success) return invalid(c, id.error)
	try {
		return respond(
			c,
			await timeEntryHistory(auth.auth.orgId, auth.auth.claims, id.data),
			'history',
		)
	} catch (error) {
		return databaseUnavailable(c, auth.auth.orgId, error)
	}
})
