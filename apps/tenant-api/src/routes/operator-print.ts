import { Hono, type Context } from 'hono'
import { z } from 'zod'
import {
	printerRoutesSchema,
	printerSetupSchema,
	printerUpdateSchema,
} from '@repo/common/print-devices'
import { getTenantDb } from '@repo/tenant-db'
import { isPosEnabled, posDisabledResponse, posError } from '../lib/pos-auth.ts'
import { isPrintingKillSwitchOn, printingEnabled } from '../lib/print-switches.ts'
import { writeOperatorAudit } from '../services/staff-audit.ts'
import {
	createPrinter,
	getPrinter,
	jobStatus,
	listJobs,
	listPrinters,
	queueOrderPrint,
	requestTest,
	resetPrinterPassword,
	revokePrinter,
	updatePrinter,
} from '../services/print-service.ts'
import { loadPrintContext } from '../services/print-source.ts'
import { assertOperatorOrg, authenticateOrdersOperator } from './operator-orders.ts'

/**
 * Operator management of cloud printers (#117, #426): Settings, Terminals,
 * Printers. The same operator JWT as the terminals routes (`orders:read` to
 * look, `orders:write` to change), minted by the App after its own Terminals
 * authorization. Responses are `private, no-store`. Removing a printer always
 * works, even with the kill switch on; adding one needs the organization flag.
 */
export const operatorPrintRoutes = new Hono()

const noStore = { 'Cache-Control': 'private, no-store' }

async function guard(
	c: Context,
	scope: 'orders:read' | 'orders:write',
	options: { keepWorkingWhenDisabled?: boolean } = {},
) {
	if (!isPosEnabled() && !options.keepWorkingWhenDisabled)
		return { error: posDisabledResponse() }
	const auth = await authenticateOrdersOperator(c, scope)
	if ('error' in auth) return { error: auth.error }
	const denied = await assertOperatorOrg(auth.auth.orgId)
	if (denied) return { error: denied.error }
	return { auth: auth.auth, db: await getTenantDb(auth.auth.orgId) }
}

const allowedLocation = (
	locationIds: string[] | null,
	locationId: string | null | undefined,
) => locationIds === null || (!!locationId && locationIds.includes(locationId))

operatorPrintRoutes.get('/', async (c) => {
	const g = await guard(c, 'orders:read', { keepWorkingWhenDisabled: true })
	if ('error' in g) return g.error
	const [printers, enabled] = await Promise.all([
		listPrinters(g.db, g.auth.orgId, g.auth.locationIds),
		printingEnabled(g.auth.orgId),
	])
	return c.json(
		{ printers, enabled, killSwitch: isPrintingKillSwitchOn() },
		200,
		noStore,
	)
})

operatorPrintRoutes.post('/', async (c) => {
	const g = await guard(c, 'orders:write')
	if ('error' in g) return g.error
	if (!(await printingEnabled(g.auth.orgId))) return posError(403, 'printing_off')
	const parsed = printerSetupSchema.safeParse(await c.req.json().catch(() => null))
	if (!parsed.success) return posError(400, 'invalid_request')
	if (!allowedLocation(g.auth.locationIds, parsed.data.locationId)) {
		return posError(403, 'location_not_allowed')
	}
	const result = await createPrinter(
		g.db,
		g.auth.orgId,
		parsed.data,
		g.auth.userId,
	)
	await writeOperatorAudit(g.db, g.auth.userId, null, {
		action: 'printer.created',
		entityType: 'print_device',
		entityId: result.printer.id,
		changes: { locationId: parsed.data.locationId, protocol: parsed.data.protocol },
	})
	// The password is shown now and never again.
	return c.json(result, 201, noStore)
})

async function ownPrinter(
	c: Context,
	g: { auth: { locationIds: string[] | null }; db: Awaited<ReturnType<typeof getTenantDb>> },
) {
	const id = z.string().min(8).max(64).safeParse(c.req.param('id'))
	if (!id.success) return { error: posError(400, 'invalid_request') }
	const device = await getPrinter(g.db, id.data)
	// Another location's printer, or none: the same answer.
	if (!device || !allowedLocation(g.auth.locationIds, device.locationId)) {
		return { error: posError(404, 'printer_not_found') }
	}
	return { device }
}

operatorPrintRoutes.patch('/:id', async (c) => {
	const g = await guard(c, 'orders:write')
	if ('error' in g) return g.error
	const own = await ownPrinter(c, g)
	if ('error' in own) return own.error
	const parsed = printerUpdateSchema.safeParse(await c.req.json().catch(() => null))
	if (!parsed.success) return posError(400, 'invalid_request')
	const printer = await updatePrinter(g.db, g.auth.orgId, own.device.id, {
		...parsed.data,
		...(parsed.data.routes
			? { routes: printerRoutesSchema.parse(parsed.data.routes) }
			: {}),
	})
	if (!printer) return posError(404, 'printer_not_found')
	return c.json({ printer }, 200, noStore)
})

operatorPrintRoutes.post('/:id/revoke', async (c) => {
	const g = await guard(c, 'orders:write', { keepWorkingWhenDisabled: true })
	if ('error' in g) return g.error
	const own = await ownPrinter(c, g)
	if ('error' in own) return own.error
	await revokePrinter(g.db, own.device.id, g.auth.userId)
	await writeOperatorAudit(g.db, g.auth.userId, null, {
		action: 'printer.revoked',
		entityType: 'print_device',
		entityId: own.device.id,
	})
	return c.json({ ok: true }, 200, noStore)
})

operatorPrintRoutes.post('/:id/password', async (c) => {
	const g = await guard(c, 'orders:write')
	if ('error' in g) return g.error
	const own = await ownPrinter(c, g)
	if ('error' in own) return own.error
	const result = await resetPrinterPassword(g.db, g.auth.orgId, own.device.id)
	if (!result) return posError(404, 'printer_not_found')
	await writeOperatorAudit(g.db, g.auth.userId, null, {
		action: 'printer.password_reset',
		entityType: 'print_device',
		entityId: own.device.id,
	})
	return c.json(result, 200, noStore)
})

const testSchema = z.strictObject({
	kind: z.enum(['test', 'drawer']),
	locationName: z.string().trim().max(100).optional(),
})

/** A test ticket or an open-drawer pulse, through the same queue as real tickets (#426). */
operatorPrintRoutes.post('/:id/test', async (c) => {
	const g = await guard(c, 'orders:write')
	if ('error' in g) return g.error
	const own = await ownPrinter(c, g)
	if ('error' in own) return own.error
	if (!(await printingEnabled(g.auth.orgId))) return posError(403, 'printing_off')
	const parsed = testSchema.safeParse(await c.req.json().catch(() => null))
	if (!parsed.success) return posError(400, 'invalid_request')
	const context = await loadPrintContext(g.auth.orgId, own.device.locationId)
	const outcome = await requestTest(
		g.db,
		own.device,
		parsed.data.kind,
		context?.locationName ?? parsed.data.locationName ?? '',
	)
	if (!outcome.ok) {
		return c.json(
			{ error: 'printer_not_ready', reason: outcome.reason, message: outcome.message },
			409,
			noStore,
		)
	}
	return c.json({ jobId: outcome.jobId }, 202, noStore)
})

operatorPrintRoutes.get('/:id/jobs/:jobId', async (c) => {
	const g = await guard(c, 'orders:read', { keepWorkingWhenDisabled: true })
	if ('error' in g) return g.error
	const own = await ownPrinter(c, g)
	if ('error' in own) return own.error
	const status = await jobStatus(g.db, own.device.id, c.req.param('jobId') ?? '')
	if (!status) return posError(404, 'job_not_found')
	return c.json({ job: status }, 200, noStore)
})

operatorPrintRoutes.get('/jobs', async (c) => {
	const g = await guard(c, 'orders:read', { keepWorkingWhenDisabled: true })
	if ('error' in g) return g.error
	const jobs = await listJobs(g.db, g.auth.locationIds, {
		sourceId: c.req.query('orderId') || undefined,
		flagged: c.req.query('flagged') === '1',
	})
	return c.json({ jobs }, 200, noStore)
})

const reprintSchema = z.strictObject({
	source: z.enum(['online', 'pos']),
	orderId: z.string().min(1).max(100),
	locationId: z.string().min(1).max(100),
	kind: z.enum(['kitchen', 'receipt']),
	/** One per press, so a retry of the same press never prints twice. */
	requestId: z.string().min(8).max(64),
})

/** "Reprint" on the order (#117): prints again; what already printed is not repeated by the same press. */
operatorPrintRoutes.post('/reprint', async (c) => {
	const g = await guard(c, 'orders:write')
	if ('error' in g) return g.error
	const parsed = reprintSchema.safeParse(await c.req.json().catch(() => null))
	if (!parsed.success) return posError(400, 'invalid_request')
	if (!allowedLocation(g.auth.locationIds, parsed.data.locationId)) {
		return posError(403, 'location_not_allowed')
	}
	const result = await queueOrderPrint(g.db, {
		orgId: g.auth.orgId,
		locationId: parsed.data.locationId,
		source: parsed.data.source,
		orderId: parsed.data.orderId,
		trigger: {
			kind: parsed.data.kind,
			dedupeKey: `reprint:${parsed.data.requestId}`,
			reprint: true,
		},
	})
	return c.json(result, result.queued > 0 ? 202 : 200, noStore)
})
