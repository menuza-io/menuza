import { type Context, Hono } from 'hono'
import {
	parsePosPairingCode,
	POS_CONTRACT_HEADER,
	posOrderRequestSchema,
	posPairRequestSchema,
	posShiftRequestSchema,
	posSignInRequestSchema,
} from '@repo/common/pos-orders'
import { type RestaurantOrderContext } from '@repo/common/restaurant-orders'
import { getTenantDb, type TenantDatabase } from '@repo/tenant-db'
import { z } from 'zod'
import {
	authenticatePosDevice,
	isPosEnabled,
	isPosHashUnavailable,
	posDisabledResponse,
	posError,
	posUnavailableResponse,
} from '../lib/pos-auth.ts'
import { mintPosStaffSession } from '../lib/pos-staff-session.ts'
import { fetchOrderContext } from '../services/order-service.ts'
import { deviceApps } from '../services/pos-apps-service.ts'
import {
	billUnchanged,
	claimTab,
	fiscalChainHeads,
	holdUpload,
	listTransferableTabs,
	peekOrder,
	recentTransfersAway,
	redeemPairingCode,
	reviewAgainstMenu,
	serializePosOrder,
	touchDevice,
	unverifiedReview,
	upsertPosOrder,
	verifyPosPin,
	withClockCheck,
	withDiscountCheck,
	withStaffCheck,
	type PosReview,
} from '../services/pos-service.ts'
import { serializeShift, upsertShift } from '../services/pos-shift-service.ts'
import {
	queueZatcaDocuments,
	reportDueZatca,
	unitCredentials,
	unitStatus,
} from '../services/zatca-service.ts'

/**
 * Terminal surface: pairing (the one-time code is the credential) and order
 * upload (the paired device secret is the credential). Browser-direct, like
 * every other regional route, so order contents never transit the US control
 * plane. Operator management of terminals lives in `operator-pos.ts`.
 */
export const posRoutes = new Hono()

const MAX_BODY_BYTES = 200_000

async function readText(c: {
	req: {
		text: () => Promise<string>
		header: (n: string) => string | undefined
	}
}): Promise<{ error: Response } | { text: string }> {
	if (Number(c.req.header('content-length') ?? 0) > MAX_BODY_BYTES) {
		return { error: posError(413, 'payload_too_large') }
	}
	const text = await c.req.text().catch(() => '')
	if (text.length > MAX_BODY_BYTES)
		return { error: posError(413, 'payload_too_large') }
	return { text }
}

async function readBody(
	c: Parameters<typeof readText>[0],
): Promise<{ error: Response } | { raw: unknown }> {
	const body = await readText(c)
	if ('error' in body) return body
	try {
		return { raw: JSON.parse(body.text) as unknown }
	} catch {
		return { raw: null }
	}
}

/**
 * The menu for a location, kept for a minute per organization node. A till
 * draining a backlog uploads many orders in a row; each needs the same menu,
 * and asking App for it every time makes the drain slow and App-dependent.
 */
const MENU_CACHE_MS = 60_000
const menuCache = new Map<
	string,
	{ at: number; context: RestaurantOrderContext }
>()
/** Tests start from a cold cache. */
export const clearPosMenuCache = () => menuCache.clear()
async function orderContextFor(orgId: string, locationId: string) {
	const key = `${orgId}:${locationId}`
	const hit = menuCache.get(key)
	if (hit && Date.now() - hit.at < MENU_CACHE_MS) return hit.context
	const result = await fetchOrderContext(orgId, locationId, null)
	if (!result.ok) return null
	if (menuCache.size > 200) menuCache.clear()
	menuCache.set(key, { at: Date.now(), context: result.data })
	return result.data
}

/**
 * Runs after the response where the platform allows it (Workers), and simply
 * keeps going in a long-lived Node process.
 */
function inBackground(c: Context, task: Promise<unknown>) {
	const safe = task.catch((error) =>
		console.error(
			'POS background task failed',
			error instanceof Error ? error.message : error,
		),
	)
	try {
		c.executionCtx.waitUntil(safe)
	} catch {
		/* no execution context on Node */
	}
}

posRoutes.post('/pair', async (c) => {
	if (!isPosEnabled()) return posDisabledResponse()
	const body = await readBody(c)
	if ('error' in body) return body.error
	const parsedBody = posPairRequestSchema.safeParse(body.raw)
	// Every failure answers the same, so a code cannot be probed.
	const invalid = () => posError(401, 'invalid_pairing_code')
	if (!parsedBody.success) return invalid()
	const parsed = parsePosPairingCode(parsedBody.data.code)
	if (!parsed) return invalid()

	let db: TenantDatabase
	try {
		db = await getTenantDb(parsed.orgId)
	} catch {
		return invalid()
	}
	try {
		const paired = await redeemPairingCode(
			db,
			parsed.orgId,
			parsedBody.data.code,
		)
		if (!paired) return invalid()
		return c.json({ deviceSecret: paired.secret, device: paired.device }, 201)
	} catch (error) {
		if (isPosHashUnavailable(error)) return posUnavailableResponse()
		console.error(
			'POS pairing failed',
			error instanceof Error ? error.message : error,
		)
		return posError(500, 'internal_error')
	}
})

/**
 * Cheap authenticated probe: lets a terminal learn it was revoked before it
 * sells, pick up a manager's changes, drop tabs another terminal took over, and
 * continue its fiscal chain if its local storage was lost.
 */
posRoutes.get('/me', async (c) => {
	const auth = await authenticatePosDevice(c)
	if ('error' in auth) return auth.error
	const { db, device } = auth.pos
	await touchDevice(db, device)
	const [transfers, fiscalChains, zatca, apps] = await Promise.all([
		recentTransfersAway(db, device.id),
		fiscalChainHeads(db, device.id),
		unitStatus(db, device.id),
		deviceApps(auth.pos.orgId, device),
	])
	return c.json({
		device: {
			id: device.id,
			label: device.label,
			terminalCode: device.terminalCode,
			locationId: device.locationId,
			scopeId: device.scopeId,
			signInRequired: device.signInRequired,
			dayStartMinutes: device.dayStartMinutes,
			shiftsRequired: device.shiftsRequired,
		},
		// Station apps beside the till (time clock, host stand).
		apps,
		transfers,
		fiscalChains,
		// When active, the till fetches its signing key and certificate from /pos/zatca.
		zatca,
	})
})

/**
 * The EGS unit's signing key and production certificate, and the seller as
 * ZATCA knows them, for an onboarded terminal. The till signs simplified
 * invoices and credit notes with these, offline if need be; the CSID secret
 * stays on the server, which reports what the till signed.
 */
posRoutes.get('/zatca', async (c) => {
	const auth = await authenticatePosDevice(c)
	if ('error' in auth) return auth.error
	const credentials = await unitCredentials(auth.pos.db, auth.pos.device.id)
	if (!credentials) return posError(404, 'not_onboarded')
	return c.json(credentials, 200, { 'Cache-Control': 'private, no-store' })
})

/**
 * Staff sign-in. The PIN alone names the person, within this terminal's
 * workplace; wrong guesses slow the terminal down (persisted, escalating),
 * exactly as at a kiosk. The PIN is never stored or logged here. A till also
 * uses this to check a manager's approval (it only looks at the role).
 */
posRoutes.post('/sign-in', async (c) => {
	const auth = await authenticatePosDevice(c)
	if ('error' in auth) return auth.error
	const { pos } = auth
	if (!pos.device.signInRequired) return posError(409, 'sign_in_not_required')
	const body = await readBody(c)
	if ('error' in body) return body.error
	const parsed = posSignInRequestSchema.safeParse(body.raw)
	// A malformed PIN can never match, so it is answered like a wrong one.
	if (!parsed.success)
		return posError(401, 'invalid_pin', { retryAfterSeconds: 0 })
	try {
		const result = await verifyPosPin(pos.db, {
			orgId: pos.orgId,
			device: pos.device,
			pin: parsed.data.pin,
		})
		await touchDevice(pos.db, pos.device)
		if (!result.ok) {
			return Response.json(
				{ error: result.code, retryAfterSeconds: result.retryAfterSeconds },
				{
					status: result.code === 'backoff' ? 429 : 401,
					headers: {
						'Cache-Control': 'private, no-store',
						'Retry-After': String(result.retryAfterSeconds),
					},
				},
			)
		}
		// Proof of this sign-in for the Station apps that act as the person.
		const session = await mintPosStaffSession({
			orgId: pos.orgId,
			deviceId: pos.device.id,
			staffId: result.staff.id,
			role: result.role,
		})
		return c.json(
			{
				staff: result.staff,
				role: result.role,
				sessionToken: session.token,
				sessionExpiresAt: session.expiresAt,
			},
			200,
			{ 'Cache-Control': 'private, no-store' },
		)
	} catch (error) {
		if (isPosHashUnavailable(error)) return posUnavailableResponse()
		console.error(
			'POS sign-in failed',
			error instanceof Error ? error.message : error,
		)
		return posError(500, 'internal_error')
	}
})

/** Best-effort id and revision of an upload the server could not read, for the held copy. */
function looseIdentity(raw: unknown) {
	const shape = z
		.object({
			id: z.string().uuid().optional(),
			revision: z.number().int().optional(),
		})
		.loose()
		.safeParse(raw)
	return {
		orderId: shape.success ? (shape.data.id ?? null) : null,
		revision: shape.success ? (shape.data.revision ?? null) : null,
	}
}

posRoutes.post('/orders', async (c) => {
	const auth = await authenticatePosDevice(c)
	if ('error' in auth) return auth.error
	const { pos } = auth

	const body = await readText(c)
	if ('error' in body) return body.error
	const contractVersion =
		Number.parseInt(c.req.header(POS_CONTRACT_HEADER) ?? '1', 10) || null
	let raw: unknown = null
	try {
		raw = JSON.parse(body.text)
	} catch {
		/* kept verbatim below */
	}

	/**
	 * The server could not apply this upload. It is never thrown away: it is kept
	 * for a person to settle, and the till is told so it stops sending it. Only
	 * when this terminal already has too many waiting is it asked to retry later.
	 */
	const hold = async (
		error: string,
		message: string | null,
		extra: Record<string, unknown> = {},
	) => {
		const kept = await holdUpload(pos.db, pos.device, {
			...looseIdentity(raw),
			error,
			message,
			contractVersion,
			payload: body.text,
		})
		if (!kept)
			return posError(429, 'held_limit', {
				message: 'Too many uploads are waiting for review.',
			})
		return c.json(
			{ result: 'held', error, ...(message ? { message } : {}), ...extra },
			202,
			{
				'Cache-Control': 'private, no-store',
			},
		)
	}

	const parsed = posOrderRequestSchema.safeParse(raw)
	if (!parsed.success) {
		const issue = parsed.error.issues[0]
		return hold(
			'invalid_request',
			issue ? `${issue.path.join('.')}: ${issue.message}` : 'Invalid order',
		)
	}
	const order = parsed.data

	// The live menu is only consulted to FLAG drift; the sale is kept either way.
	// A replay, or a change that leaves the bill exactly as it was checked (a
	// payment, a cancellation, a refund), needs no menu check. If the menu cannot
	// be reached the sale is stored for review ("unverified") instead of being
	// held back on the tablet, where a wipe would lose it.
	const prior = await peekOrder(pos.db, order.id)
	let review: PosReview
	if (
		prior &&
		(prior.revision >= order.revision ||
			order.status === 'void' ||
			billUnchanged(prior, order))
	) {
		review = {
			reviewReason: prior.reviewReason,
			serverTotalCents: prior.serverTotalCents,
			locationName: prior.locationName,
		}
	} else {
		const context = await orderContextFor(pos.orgId, order.locationId)
		review = context
			? reviewAgainstMenu(context, order, new Date())
			: unverifiedReview()
	}
	review = await withStaffCheck(
		pos.db,
		pos.device,
		order,
		withDiscountCheck(withClockCheck(review, order), order),
	)

	try {
		const result = await upsertPosOrder(pos.db, pos.device, order, review)
		if (!result.ok) {
			// The till renumbers and resends; nothing has been stored yet.
			if (result.error === 'number_conflict') {
				return posError(409, result.error, {
					...(result.message ? { message: result.message } : {}),
					...result.extra,
				})
			}
			return hold(result.error, result.message ?? null, result.extra)
		}
		await touchDevice(pos.db, pos.device)
		// Signed ZATCA documents are reported in the background; the hourly tick catches up.
		if ((await queueZatcaDocuments(pos.db, pos.device, order)) > 0)
			inBackground(c, reportDueZatca(pos.db))
		const { kind, order: row, payments } = result.value
		return c.json(
			{ order: serializePosOrder(row, payments), result: kind },
			kind === 'created' ? 201 : 200,
		)
	} catch (error) {
		console.error(
			'POS order upload failed',
			error instanceof Error ? error.message : error,
		)
		return posError(500, 'internal_error')
	}
})

/** Open tabs on this location's other terminals, so one can be taken over here. */
posRoutes.get('/tabs', async (c) => {
	const auth = await authenticatePosDevice(c)
	if ('error' in auth) return auth.error
	return c.json(
		{ tabs: await listTransferableTabs(auth.pos.db, auth.pos.device) },
		200,
		{
			'Cache-Control': 'private, no-store',
		},
	)
})

const claimSchema = z.strictObject({
	revision: z.number().int().min(1),
	staffId: z.string().min(1).max(100).nullable().default(null),
})

posRoutes.post('/tabs/:id/claim', async (c) => {
	const auth = await authenticatePosDevice(c)
	if ('error' in auth) return auth.error
	const orderId = z.string().uuid().safeParse(c.req.param('id'))
	const body = await readBody(c)
	if ('error' in body) return body.error
	const parsed = claimSchema.safeParse(body.raw)
	if (!orderId.success || !parsed.success)
		return posError(400, 'invalid_request')
	const result = await claimTab(auth.pos.db, auth.pos.device, {
		orderId: orderId.data,
		revision: parsed.data.revision,
		staffId: parsed.data.staffId,
	})
	if (!result.ok) {
		return posError(result.status, result.error, {
			...(result.message ? { message: result.message } : {}),
			...result.extra,
		})
	}
	return c.json({ order: result.value }, 200, {
		'Cache-Control': 'private, no-store',
	})
})

/**
 * One revision of a cash drawer shift. Like an order: idempotent, movements
 * append-only, and anything the server cannot apply is held for review.
 */
posRoutes.post('/shifts', async (c) => {
	const auth = await authenticatePosDevice(c)
	if ('error' in auth) return auth.error
	const { pos } = auth
	const body = await readText(c)
	if ('error' in body) return body.error
	let raw: unknown = null
	try {
		raw = JSON.parse(body.text)
	} catch {
		/* kept verbatim below */
	}
	const hold = async (error: string, message: string | null) => {
		const kept = await holdUpload(pos.db, pos.device, {
			...looseIdentity(raw),
			error,
			message,
			contractVersion:
				Number.parseInt(c.req.header(POS_CONTRACT_HEADER) ?? '1', 10) || null,
			payload: body.text,
		})
		if (!kept)
			return posError(429, 'held_limit', {
				message: 'Too many uploads are waiting for review.',
			})
		return c.json(
			{ result: 'held', error, ...(message ? { message } : {}) },
			202,
			{ 'Cache-Control': 'private, no-store' },
		)
	}
	const parsed = posShiftRequestSchema.safeParse(raw)
	if (!parsed.success) {
		const issue = parsed.error.issues[0]
		return hold(
			'invalid_request',
			issue ? `${issue.path.join('.')}: ${issue.message}` : 'Invalid shift',
		)
	}
	try {
		const result = await upsertShift(pos.db, pos.device, parsed.data)
		if (!result.ok) return hold(result.error, result.message ?? null)
		await touchDevice(pos.db, pos.device)
		const { kind, shift, movements } = result.value
		return c.json(
			{ shift: serializeShift(shift, movements), result: kind },
			kind === 'created' ? 201 : 200,
		)
	} catch (error) {
		console.error(
			'POS shift upload failed',
			error instanceof Error ? error.message : error,
		)
		return posError(500, 'internal_error')
	}
})
