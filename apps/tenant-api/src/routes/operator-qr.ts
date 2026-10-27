import { Hono, type Context } from 'hono'
import { jwtVerify } from 'jose'
import { z } from 'zod'

import {
	QR_TAB_STATUS_VALUES,
	qrFloorPlanImportSchema,
	qrSettingsPatchSchema,
	qrTabCloseSchema,
	qrTableBulkCreateSchema,
	qrTableCreateSchema,
	qrTablePatchSchema,
	qrTabVoidSchema,
} from '@repo/common/qr-ordering'
import { brand } from '@repo/config/brand'
import { TENANT_ORG_ID_PATTERN } from '@repo/tenant-db'

import { getBearerToken, getOperatorToken } from '../lib/secrets.ts'
import {
	closeTabAtCounter,
	createQrTables,
	getOperatorTab,
	getQrSettings,
	importFloorPlan,
	listOperatorTabs,
	listQrTables,
	lockTab,
	patchQrSettings,
	patchQrTable,
	releaseTabPayment,
	voidTab,
	type QrResult,
	type ReleasedTabPayment,
} from '../services/qr-tab-service.ts'
import { assertOperatorOrg } from './operator-orders.ts'

/**
 * Operator surface for QR ordering: the table registry, the org's QR settings
 * and the tab lifecycle. App mints `qr:read` / `qr:write` after menu-read /
 * menu-write and the QR flags; `canImportFloorPlan` is a separate signed claim
 * App sets only when reservations are on for the org.
 */
export const operatorQrRoutes = new Hono()

export type QrOperatorAuth = {
	orgId: string
	userId: string
	scope: 'qr:read' | 'qr:write'
	canImportFloorPlan: boolean
}

export async function authenticateQrOperator(
	c: Context,
	required: 'qr:read' | 'qr:write',
): Promise<{ auth: QrOperatorAuth } | { error: Response }> {
	const unauthorized = () => ({
		error: Response.json({ error: 'Unauthorized' }, { status: 401 }),
	})
	const token = getBearerToken(c.req.header('Authorization'))
	if (!token) return unauthorized()
	const operatorToken = getOperatorToken()
	if (operatorToken.length < 16) {
		return {
			error: Response.json({ error: 'Not configured' }, { status: 503 }),
		}
	}
	let decoded: Record<string, unknown>
	try {
		const { payload } = await jwtVerify(
			token,
			new TextEncoder().encode(operatorToken),
			{ audience: 'tenant-api-operator', issuer: brand.shortName },
		)
		decoded = payload as Record<string, unknown>
	} catch {
		return unauthorized()
	}
	const orgId = decoded.orgId
	if (typeof orgId !== 'string' || !TENANT_ORG_ID_PATTERN.test(orgId)) {
		return unauthorized()
	}
	if (decoded.role !== 'operator') {
		return { error: Response.json({ error: 'Invalid role' }, { status: 403 }) }
	}
	if (decoded.scope !== 'qr:read' && decoded.scope !== 'qr:write') {
		return {
			error: Response.json({ error: 'Missing QR scope' }, { status: 403 }),
		}
	}
	if (required === 'qr:write' && decoded.scope !== 'qr:write') {
		return {
			error: Response.json(
				{ error: 'Write scope required for this action' },
				{ status: 403 },
			),
		}
	}
	return {
		auth: {
			orgId,
			userId: typeof decoded.sub === 'string' ? decoded.sub : 'unknown',
			scope: decoded.scope,
			// Fail closed: only a literal `true` grants the import.
			canImportFloorPlan: decoded.canImportFloorPlan === true,
		},
	}
}

function noStoreHeaders() {
	return { 'Cache-Control': 'private, no-store' }
}

async function guard(c: Context, required: 'qr:read' | 'qr:write') {
	const auth = await authenticateQrOperator(c, required)
	if ('error' in auth) return auth
	const denied = await assertOperatorOrg(auth.auth.orgId)
	if (denied) return denied
	return auth
}

function respond<T>(c: Context, result: QrResult<T>, key: string) {
	if (!result.ok) {
		return c.json(
			{ error: result.failure.code, message: result.failure.message },
			result.failure.status as 400,
			noStoreHeaders(),
		)
	}
	return c.json({ [key]: result.data }, 200, noStoreHeaders())
}

/** Close, void and release: the tab plus the payment page they unbound. */
function respondReleased(c: Context, result: QrResult<ReleasedTabPayment>) {
	if (!result.ok) return respond(c, result, 'tab')
	return c.json(
		{ tab: result.data.tab, releasedSession: result.data.releasedSession },
		200,
		noStoreHeaders(),
	)
}

async function readBody(c: Context) {
	return c.req.json().catch(() => null)
}

function invalid(c: Context, error: z.ZodError) {
	return c.json(
		{
			error: 'invalid_request',
			message: error.issues[0]?.message ?? 'Invalid request',
		},
		400,
		noStoreHeaders(),
	)
}

async function safely(c: Context, orgId: string, run: () => Promise<Response>) {
	try {
		return await run()
	} catch (error) {
		console.error(
			`QR operator request failed for org ${orgId}:`,
			error instanceof Error ? error.message : error,
		)
		return c.json(
			{ error: 'Tenant Database unavailable' },
			500,
			noStoreHeaders(),
		)
	}
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

const tableListQuery = z.object({
	locationId: z.string().trim().min(1).max(100).optional(),
	archived: z.enum(['0', '1']).optional(),
})

operatorQrRoutes.get('/tables', async (c) => {
	const auth = await guard(c, 'qr:read')
	if ('error' in auth) return auth.error
	const parsed = tableListQuery.safeParse(c.req.query())
	if (!parsed.success) return invalid(c, parsed.error)
	return safely(c, auth.auth.orgId, async () => {
		const tables = await listQrTables(auth.auth.orgId, {
			locationId: parsed.data.locationId,
			includeArchived: parsed.data.archived === '1',
			// Tokens print QR codes: writers only.
			withTokens: auth.auth.scope === 'qr:write',
		})
		return c.json({ tables }, 200, noStoreHeaders())
	})
})

operatorQrRoutes.post('/tables', async (c) => {
	const auth = await guard(c, 'qr:write')
	if ('error' in auth) return auth.error
	const parsed = qrTableCreateSchema.safeParse(await readBody(c))
	if (!parsed.success) return invalid(c, parsed.error)
	return safely(c, auth.auth.orgId, async () => {
		const result = await createQrTables(auth.auth.orgId, {
			locationId: parsed.data.locationId,
			labels: [parsed.data.label],
		})
		if (!result.ok) return respond(c, result, 'table')
		return c.json({ table: result.data[0] }, 201, noStoreHeaders())
	})
})

operatorQrRoutes.post('/tables/bulk', async (c) => {
	const auth = await guard(c, 'qr:write')
	if ('error' in auth) return auth.error
	const parsed = qrTableBulkCreateSchema.safeParse(await readBody(c))
	if (!parsed.success) return invalid(c, parsed.error)
	return safely(c, auth.auth.orgId, async () =>
		respond(c, await createQrTables(auth.auth.orgId, parsed.data), 'tables'),
	)
})

operatorQrRoutes.post('/tables/import-floor-plan', async (c) => {
	const auth = await guard(c, 'qr:write')
	if ('error' in auth) return auth.error
	if (!auth.auth.canImportFloorPlan) {
		return c.json(
			{ error: 'Floor plan import is not available' },
			403,
			noStoreHeaders(),
		)
	}
	const parsed = qrFloorPlanImportSchema.safeParse(await readBody(c))
	if (!parsed.success) return invalid(c, parsed.error)
	return safely(c, auth.auth.orgId, async () =>
		respond(
			c,
			await importFloorPlan(auth.auth.orgId, parsed.data.locationId),
			'import',
		),
	)
})

operatorQrRoutes.patch('/tables/:id', async (c) => {
	const auth = await guard(c, 'qr:write')
	if ('error' in auth) return auth.error
	const parsed = qrTablePatchSchema.safeParse(await readBody(c))
	if (!parsed.success) return invalid(c, parsed.error)
	return safely(c, auth.auth.orgId, async () =>
		respond(
			c,
			await patchQrTable(auth.auth.orgId, c.req.param('id'), parsed.data),
			'table',
		),
	)
})

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

operatorQrRoutes.get('/settings', async (c) => {
	const auth = await guard(c, 'qr:read')
	if ('error' in auth) return auth.error
	return safely(c, auth.auth.orgId, async () =>
		c.json(
			{ settings: await getQrSettings(auth.auth.orgId) },
			200,
			noStoreHeaders(),
		),
	)
})

operatorQrRoutes.patch('/settings', async (c) => {
	const auth = await guard(c, 'qr:write')
	if ('error' in auth) return auth.error
	const parsed = qrSettingsPatchSchema.safeParse(await readBody(c))
	if (!parsed.success) return invalid(c, parsed.error)
	return safely(c, auth.auth.orgId, async () =>
		c.json(
			{ settings: await patchQrSettings(auth.auth.orgId, parsed.data) },
			200,
			noStoreHeaders(),
		),
	)
})

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

const tabListQuery = z.object({
	status: z.enum([...QR_TAB_STATUS_VALUES, 'recent', 'review']).optional(),
	limit: z.coerce.number().int().min(1).max(200).optional(),
})

operatorQrRoutes.get('/tabs', async (c) => {
	const auth = await guard(c, 'qr:read')
	if ('error' in auth) return auth.error
	const parsed = tabListQuery.safeParse(c.req.query())
	if (!parsed.success) return invalid(c, parsed.error)
	return safely(c, auth.auth.orgId, async () =>
		c.json(
			{
				tabs: await listOperatorTabs(auth.auth.orgId, {
					status: parsed.data.status ?? 'open',
					limit: parsed.data.limit ?? 100,
				}),
			},
			200,
			noStoreHeaders(),
		),
	)
})

operatorQrRoutes.get('/tabs/:id', async (c) => {
	const auth = await guard(c, 'qr:read')
	if ('error' in auth) return auth.error
	return safely(c, auth.auth.orgId, async () =>
		respond(c, await getOperatorTab(auth.auth.orgId, c.req.param('id')), 'tab'),
	)
})

operatorQrRoutes.post('/tabs/:id/close', async (c) => {
	const auth = await guard(c, 'qr:write')
	if ('error' in auth) return auth.error
	const parsed = qrTabCloseSchema.safeParse(await readBody(c))
	if (!parsed.success) return invalid(c, parsed.error)
	return safely(c, auth.auth.orgId, async () =>
		respondReleased(
			c,
			await closeTabAtCounter(auth.auth.orgId, c.req.param('id'), {
				tipCents: parsed.data.tipCents,
				closedBy: auth.auth.userId,
				acknowledgeReview: parsed.data.acknowledgeReview,
				expectedTotalCents: parsed.data.expectedTotalCents,
			}),
		),
	)
})

operatorQrRoutes.post('/tabs/:id/void', async (c) => {
	const auth = await guard(c, 'qr:write')
	if ('error' in auth) return auth.error
	const parsed = qrTabVoidSchema.safeParse(await readBody(c))
	if (!parsed.success) return invalid(c, parsed.error)
	return safely(c, auth.auth.orgId, async () =>
		respondReleased(
			c,
			await voidTab(auth.auth.orgId, c.req.param('id'), {
				reason: parsed.data.reason,
				closedBy: auth.auth.userId,
				acknowledgeReview: parsed.data.acknowledgeReview,
				expectedTotalCents: parsed.data.expectedTotalCents,
			}),
		),
	)
})

operatorQrRoutes.post('/tabs/:id/release-payment', async (c) => {
	const auth = await guard(c, 'qr:write')
	if ('error' in auth) return auth.error
	return safely(c, auth.auth.orgId, async () =>
		respondReleased(
			c,
			await releaseTabPayment(auth.auth.orgId, c.req.param('id')),
		),
	)
})

operatorQrRoutes.post('/tabs/:id/lock', async (c) => {
	const auth = await guard(c, 'qr:write')
	if ('error' in auth) return auth.error
	return safely(c, auth.auth.orgId, async () =>
		respond(c, await lockTab(auth.auth.orgId, c.req.param('id')), 'tab'),
	)
})
