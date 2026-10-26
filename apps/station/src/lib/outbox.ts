import { t } from '@lingui/macro'
import { type PosFiscalChainHead } from '@repo/common/pos-fiscal'
import {
	POS_CONTRACT_VERSION,
	type PosDeviceApps,
} from '@repo/common/pos-orders'
import { noteServerDate } from './clock.ts'
import { type PosSettings } from './config.ts'
import { db, type PosOrder } from './db.ts'
import { isSendable } from './orders.ts'
import { toWireShift } from './shifts.ts'

/**
 * Upload queue. Orders already sit in IndexedDB (see `placeOrder`); this only
 * decides when to send them. It is safe to run from several places at once:
 * a row is claimed by flipping `pending` to `syncing` inside a transaction,
 * and the server de-duplicates on the order id (idempotency key).
 */

/** Server error codes that mean this order will never be accepted as sent. */
const PERMANENT_REFUSALS = new Set([
	'invalid_request',
	'wrong_location',
	'order_id_conflict',
	'number_conflict',
	'payments_changed',
	'paid_order_changed',
	'order_closed',
	'order_identity_changed',
	'payment_id_conflict',
	'refunds_changed',
	'line_voids_changed',
	'order_transferred',
	'payload_too_large',
])

/** The contract this till speaks (`POS_CONTRACT_VERSION` in @repo/common/pos-orders). */
export const CONTRACT_VERSION = POS_CONTRACT_VERSION

const staffOrNull = (who: { id: string; name: string } | null | undefined) =>
	who ? { id: who.id, name: who.name } : null

const BACKOFF_MS = [5_000, 15_000, 60_000, 5 * 60_000, 15 * 60_000]
/**
 * A row left `syncing` this long belongs to a tab that died mid-request. An
 * upload gives up after 15 s, so a live one can never be older than this.
 */
const STALE_SYNCING_MS = 20_000

export const backoffFor = (attempts: number): number =>
	BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length) - 1] ?? BACKOFF_MS[0]!

/**
 * Wire format (`posOrderRequestSchema` in `@repo/common/pos-orders`). The order
 * is a snapshot of what was rung up and collected, so a sale taken offline on a
 * menu that has since changed is still recorded as it happened; the server
 * checks the arithmetic and flags drift for review instead of refusing it.
 */
export function toWireOrder(order: PosOrder) {
	return {
		id: order.id,
		/** The server keeps the highest revision it has seen, so replays are harmless. */
		revision: order.revision,
		status: order.status,
		number: order.number,
		businessDate: order.businessDate,
		createdAt: new Date(order.createdAt).toISOString(),
		locationId: order.locationId,
		currency: order.currency,
		taxRatePercent: order.taxRatePercent,
		taxInclusive: order.taxInclusive ?? false,
		catalogFetchedAt: order.catalogFetchedAt
			? new Date(order.catalogFetchedAt).toISOString()
			: null,
		shiftId: order.shiftId ?? null,
		orderType: order.orderType,
		orderSource: order.orderSource ?? 'counter',
		customerPhone: order.customerPhone || null,
		pickupAt:
			order.pickupAt != null ? new Date(order.pickupAt).toISOString() : null,
		pickupTimeZone: order.pickupTimeZone ?? null,
		customerName: order.customerName || null,
		tableLabel: order.tableLabel || null,
		staff: order.staff ?? null,
		signIn: order.signIn ?? null,
		voidedBy: staffOrNull(order.voidedBy),
		voidedAt: order.voidedAt ? new Date(order.voidedAt).toISOString() : null,
		voidReason: order.voidReason ?? null,
		voidApprovedBy: staffOrNull(order.voidApprovedBy),
		lines: order.lines.map((l) => ({
			// The kitchen's key for the dish and its round; local marks (served) stay here.
			id: l.id,
			...(l.sentAt ? { sentAt: new Date(l.sentAt).toISOString() } : {}),
			itemId: l.itemId,
			name: l.name,
			variantId: l.variantId,
			variantLabel: l.variantLabel,
			quantity: l.quantity,
			baseCents: l.baseCents,
			instructions: l.instructions,
			options: l.options.map((o) => ({
				groupId: o.groupId,
				groupName: o.groupName,
				optionId: o.optionId,
				optionName: o.optionName,
				quantity: o.quantity,
				unitCents: o.unitCents,
				taxable: o.taxable,
			})),
		})),
		lineVoids: (order.lineVoids ?? []).map((v) => ({
			id: v.id,
			itemId: v.itemId,
			name: v.name,
			variantLabel: v.variantLabel,
			quantity: v.quantity,
			unitCents: v.unitCents,
			at: new Date(v.at).toISOString(),
			by: staffOrNull(v.by),
			approvedBy: staffOrNull(v.approvedBy),
			reason: v.reason,
		})),
		adjustments: order.adjustments.map((a) => ({
			id: a.id,
			kind: a.kind,
			label: a.label,
			amountCents: a.amountCents,
		})),
		totals: {
			subtotalCents: order.totals.subtotalCents,
			adjustmentCents: order.totals.adjustmentCents,
			taxCents: order.totals.taxCents,
			tipCents: order.totals.tipCents,
			totalCents: order.totals.totalCents,
		},
		payments: order.payments.map((p) => ({
			id: p.id,
			method: p.method,
			amountCents: p.amountCents,
			tenderedCents: p.tenderedCents,
			at: new Date(p.at).toISOString(),
			staff: staffOrNull(p.staff),
			reference: p.reference ?? null,
			shiftId: p.shiftId ?? null,
		})),
		refunds: (order.refunds ?? []).map((r) => ({
			id: r.id,
			paymentId: r.paymentId,
			method: r.method,
			amountCents: r.amountCents,
			at: new Date(r.at).toISOString(),
			by: staffOrNull(r.by),
			approvedBy: staffOrNull(r.approvedBy),
			reason: r.reason,
			reference: r.reference,
			shiftId: r.shiftId ?? null,
		})),
		fiscal: order.fiscal ?? [],
	}
}

type UploadResult =
	| { kind: 'ok'; serverNumber?: string }
	/** The server could not apply it and kept it for a manager: stop sending it. */
	| { kind: 'held'; error: string; toTerminal: string | null }
	| { kind: 'retry'; error: string }
	| { kind: 'rejected'; error: string }
	/** This terminal's counter was reset and the number is taken: the server offers the next free one. */
	| { kind: 'renumber'; nextNumber: string; error: string }
	/** Nothing is wrong with the order: this terminal just is not paired yet. */
	| { kind: 'waiting'; error: string }
	/** The server says this terminal was removed: stop and ask to pair again. */
	| { kind: 'unpaired'; error: string }
	/**
	 * The server does not recognise the secret. That can mean a wrong secret, but
	 * it is also what a node answers while it cannot reach the control plane, so
	 * it is never treated as a removal on its own.
	 */
	| { kind: 'unrecognised'; error: string }

type RefusalBody = { message?: string; error?: string; nextNumber?: string }

/**
 * What a refusal means, for orders and shifts alike. Only the answers that say
 * "this upload itself is the problem" are final. Anything else (a 404 during a
 * deploy, a wrong URL, a proxy page, a 5xx, a 429) may clear, so it is retried
 * rather than parking a paid order or a counted drawer as refused.
 */
export function classifyRefusal(
	status: number,
	parsed: RefusalBody,
): Extract<
	UploadResult,
	{ kind: 'unpaired' | 'unrecognised' | 'rejected' | 'retry' }
> {
	if (status === 401 && parsed.error === 'device_revoked') {
		return {
			kind: 'unpaired',
			error: t`This terminal was removed. Pair it again to keep sending orders.`,
		}
	}
	if (status === 401 && parsed.error === 'invalid_device') {
		return {
			kind: 'unrecognised',
			error: t`The server did not recognise this terminal. It will try again.`,
		}
	}
	const error = parsed.message ?? parsed.error ?? `Server answered ${status}`
	if (typeof parsed.error === 'string' && PERMANENT_REFUSALS.has(parsed.error))
		return { kind: 'rejected', error }
	return { kind: 'retry', error }
}

async function upload(
	order: PosOrder,
	settings: PosSettings,
): Promise<UploadResult> {
	if (!settings.tenantApiUrl || !settings.deviceToken) {
		return { kind: 'waiting', error: t`Terminal is not paired yet` }
	}
	try {
		const sentAt = Date.now()
		const response = await fetch(
			`${settings.tenantApiUrl.replace(/\/+$/, '')}/pos/orders`,
			{
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${settings.deviceToken}`,
					'Idempotency-Key': order.id,
					'Pos-Contract': String(CONTRACT_VERSION),
				},
				body: JSON.stringify(toWireOrder(order)),
				signal: AbortSignal.timeout(15_000),
			},
		)
		noteServerDate(response, sentAt)
		if (response.status === 202) {
			const body = (await response.json().catch(() => ({}))) as {
				error?: string
				toTerminal?: string | null
			}
			return {
				kind: 'held',
				error: body.error ?? 'held',
				toTerminal: body.toTerminal ?? null,
			}
		}
		if (response.ok) {
			const body = (await response.json().catch(() => ({}))) as {
				order?: { number?: string }
			}
			return { kind: 'ok', serverNumber: body.order?.number }
		}
		const parsed = await response
			.json()
			.then((b: RefusalBody) => b ?? {})
			.catch(() => ({}) as RefusalBody)
		const error =
			parsed.message ?? parsed.error ?? `Server answered ${response.status}`
		if (
			response.status === 409 &&
			parsed.error === 'number_conflict' &&
			typeof parsed.nextNumber === 'string'
		) {
			return { kind: 'renumber', nextNumber: parsed.nextNumber, error }
		}
		return classifyRefusal(response.status, parsed)
	} catch (error) {
		return {
			kind: 'retry',
			error: error instanceof Error ? error.message : 'Network error',
		}
	}
}

async function claimNext(
	now: number,
	force: boolean,
	sendable: (order: PosOrder) => boolean,
): Promise<PosOrder | undefined> {
	return db.transaction('rw', db.orders, async () => {
		await db.orders
			.where('sync')
			.equals('syncing')
			.filter((o) => now - o.nextAttemptAt > STALE_SYNCING_MS)
			.modify({ sync: 'pending' })
		const next = await db.orders
			.where('sync')
			.equals('pending')
			// `force` (a person tapping "Upload now") skips the retry backoff.
			.filter((o) => (force || o.nextAttemptAt <= now) && sendable(o))
			.sortBy('createdAt')
			.then((rows) => rows[0])
		if (!next) return undefined
		await db.orders.update(next.id, { sync: 'syncing', nextAttemptAt: now })
		return { ...next, sync: 'syncing' as const }
	})
}

let running = false

export type FlushOptions = {
	/** Try everything now, ignoring retry backoff. */
	force?: boolean
	/** Called once when the server says this terminal is no longer paired. */
	onUnpaired?: () => void
	/** Called when the server does not recognise the terminal (not necessarily a removal). */
	onUnrecognised?: () => void
}

/** Sends everything that is due, oldest first. Returns how many were sent. */
export async function flushOutbox(
	settings: PosSettings,
	options: FlushOptions = {},
): Promise<number> {
	if (
		running ||
		(typeof navigator !== 'undefined' && navigator.onLine === false)
	)
		return 0
	running = true
	let sent = 0
	/** The server removed or did not recognise this terminal: shifts wait too. */
	let pairingProblem = false
	const renumbered = new Map<string, number>()
	try {
		for (;;) {
			const order = await claimNext(Date.now(), options.force ?? false, (o) =>
				isSendable(o, settings),
			)
			if (!order) break
			let result: UploadResult
			try {
				result = await upload(order, settings)
			} catch (error) {
				result = {
					kind: 'retry',
					error: error instanceof Error ? error.message : 'Unexpected error',
				}
			}
			// The order may have changed while it was in flight (an item added to a
			// tab, a payment taken). Settle the row only if it is still the revision
			// we sent; otherwise the newer revision is already queued.
			const settle = (patch: Partial<PosOrder>) =>
				db.transaction('rw', db.orders, async () => {
					const current = await db.orders.get(order.id)
					if (current && current.revision === order.revision)
						await db.orders.update(order.id, patch)
				})
			if (result.kind === 'ok') {
				await settle({
					sync: 'synced',
					syncedAt: Date.now(),
					lastError: null,
					serverNumber:
						result.serverNumber && result.serverNumber !== order.number
							? result.serverNumber
							: null,
				})
				sent++
			} else if (result.kind === 'held') {
				// Safe on the server, waiting for a manager. A tab another terminal took
				// over stops being one here.
				await settle({
					sync: 'synced',
					syncedAt: Date.now(),
					lastError: null,
					heldReason: result.error,
					...(result.error === 'order_transferred' && order.status === 'open'
						? { transferredTo: result.toTerminal ?? 'another terminal' }
						: {}),
				})
				sent++
			} else if (result.kind === 'renumber') {
				// The server has never stored this order, so it may take a free number.
				// Bounded per flush so a misbehaving server cannot loop us.
				const tries = (renumbered.get(order.id) ?? 0) + 1
				renumbered.set(order.id, tries)
				if (tries > 3) {
					await settle({
						sync: 'rejected',
						lastError: result.error,
						attempts: order.attempts + 1,
					})
				} else {
					await renumberOrder(order, result.nextNumber)
				}
			} else if (result.kind === 'waiting') {
				// Not a failure, so no attempt is counted and no backoff applies: the
				// order goes out the moment the terminal is paired.
				await settle({
					sync: 'pending',
					lastError: result.error,
					nextAttemptAt: 0,
				})
				break
			} else if (result.kind === 'unrecognised') {
				await settle({
					sync: 'pending',
					lastError: result.error,
					nextAttemptAt: 0,
				})
				options.onUnrecognised?.()
				pairingProblem = true
				break
			} else if (result.kind === 'unpaired') {
				// Release the claim without counting an attempt: nothing is wrong with the order.
				await settle({
					sync: 'pending',
					lastError: result.error,
					nextAttemptAt: 0,
				})
				options.onUnpaired?.()
				pairingProblem = true
				break
			} else if (result.kind === 'rejected') {
				await settle({
					sync: 'rejected',
					lastError: result.error,
					attempts: order.attempts + 1,
				})
			} else {
				const attempts = order.attempts + 1
				await settle({
					sync: 'pending',
					attempts,
					lastError: result.error,
					nextAttemptAt: Date.now() + backoffFor(attempts),
				})
				// The network or server is unhappy: stop, do not hammer through the queue.
				break
			}
		}
		if (!pairingProblem) await flushShifts(settings, options)
	} finally {
		running = false
	}
	return sent
}

/**
 * Sends cash drawer shifts that changed, oldest first. Same rules as orders:
 * a shift the server kept for review counts as delivered; one it refuses for
 * good is marked `rejected` (shown for attention, and the next shift still
 * goes); anything that may clear is retried later with backoff.
 */
async function flushShifts(
	settings: PosSettings,
	options: FlushOptions,
): Promise<void> {
	if (!settings.tenantApiUrl || !settings.deviceToken) return
	const due = (
		await db.shifts
			.where('sync')
			.equals('pending')
			.filter(
				(s) =>
					(options.force || s.nextAttemptAt <= Date.now()) &&
					isSendable(s, settings),
			)
			.sortBy('openedAt')
	).slice(0, 20)
	for (const shift of due) {
		let outcome:
			{ kind: 'ok'; held: string | null } | ReturnType<typeof classifyRefusal>
		try {
			const sentAt = Date.now()
			const response = await fetch(
				`${settings.tenantApiUrl.replace(/\/+$/, '')}/pos/shifts`,
				{
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						Authorization: `Bearer ${settings.deviceToken}`,
						'Pos-Contract': String(CONTRACT_VERSION),
					},
					body: JSON.stringify(toWireShift(shift)),
					signal: AbortSignal.timeout(15_000),
				},
			)
			noteServerDate(response, sentAt)
			const body = (await response
				.json()
				.then((b: RefusalBody) => b ?? {})
				.catch(() => ({}))) as RefusalBody
			outcome = response.ok
				? {
						kind: 'ok',
						held: response.status === 202 ? (body.error ?? 'held') : null,
					}
				: classifyRefusal(response.status, body)
		} catch (e) {
			outcome = {
				kind: 'retry',
				error: e instanceof Error ? e.message : 'Network error',
			}
		}
		await db.transaction('rw', db.shifts, async () => {
			const current = await db.shifts.get(shift.id)
			if (!current || current.revision !== shift.revision) return
			if (outcome.kind === 'ok')
				await db.shifts.update(shift.id, {
					sync: 'synced',
					lastError: null,
					heldReason: outcome.held,
				})
			else if (outcome.kind === 'rejected')
				await db.shifts.update(shift.id, {
					sync: 'rejected',
					attempts: current.attempts + 1,
					lastError: outcome.error,
				})
			else if (outcome.kind === 'retry') {
				const attempts = current.attempts + 1
				await db.shifts.update(shift.id, {
					attempts,
					lastError: outcome.error,
					nextAttemptAt: Date.now() + backoffFor(attempts),
				})
			} else {
				// Removed or not recognised: nothing is wrong with the shift itself.
				await db.shifts.update(shift.id, {
					lastError: outcome.error,
					nextAttemptAt: 0,
				})
			}
		})
		if (outcome.kind === 'ok' || outcome.kind === 'rejected') continue
		if (outcome.kind === 'unpaired') options.onUnpaired?.()
		else if (outcome.kind === 'unrecognised') options.onUnrecognised?.()
		// The network, the server or the pairing is unhappy: stop for now.
		return
	}
}

/**
 * Gives an order a free number after a collision (the terminal's counter was
 * lost, e.g. site data cleared). Keeps the old number so staff can reconcile a
 * receipt that was already printed, and moves the day's counter past the new one
 * so later orders do not collide again.
 */
async function renumberOrder(
	order: PosOrder,
	nextNumber: string,
): Promise<void> {
	await db.transaction('rw', db.orders, db.meta, async () => {
		const current = await db.orders.get(order.id)
		if (!current || current.revision !== order.revision) return
		await db.orders.update(order.id, {
			number: nextNumber,
			renumberedFrom: current.renumberedFrom ?? current.number,
			sync: 'pending',
			nextAttemptAt: 0,
			lastError: null,
		})
		const seq = Number(/(\d+)$/.exec(nextNumber)?.[1] ?? 0)
		const key = `seq:${order.businessDate}`
		const row = await db.meta.get(key)
		if (seq > ((row?.value as number | undefined) ?? 0))
			await db.meta.put({ key, value: seq })
	})
}

export const pendingCount = (): Promise<number> =>
	db.orders.where('sync').anyOf('pending', 'syncing').count()

export type DeviceCheck = {
	verdict: 'ok' | 'removed' | 'unrecognised' | 'unknown'
	/** What the server says about this terminal, when it answered. */
	device?: {
		signInRequired: boolean
		scopeId: string
		label: string
		terminalCode: string
		dayStartMinutes: number | null
		shiftsRequired: boolean
	}
	/**
	 * Station apps the terminal offers (its setting and the organization's flag).
	 * An app the server could not decide (the Menuza app unreachable) is left out:
	 * the till keeps what it last knew.
	 */
	apps?: Partial<PosDeviceApps>
	/** Tabs another terminal took over from this one. */
	transfers?: Array<{ orderId: string; terminalCode: string }>
	/** This terminal's fiscal chains as the server has them. */
	fiscalChains?: PosFiscalChainHead[]
	/** This terminal as a ZATCA EGS unit, when onboarded. */
	zatca?: {
		status: string
		environment: string
		lastInvoiceHash?: string | null
	} | null
}

/**
 * Asks the server whether this terminal is still paired, and how it should behave
 * (sign-in on or off), so a removed terminal says so before its first sale and a
 * manager's change reaches the till. Anything inconclusive (offline, server down,
 * proxy) answers `unknown`: never lock out a till on a guess.
 */
export async function checkDeviceDetailed(
	settings: PosSettings,
): Promise<DeviceCheck> {
	if (!settings.tenantApiUrl || !settings.deviceToken)
		return { verdict: 'unknown' }
	if (typeof navigator !== 'undefined' && navigator.onLine === false)
		return { verdict: 'unknown' }
	try {
		const sentAt = Date.now()
		const response = await fetch(
			`${settings.tenantApiUrl.replace(/\/+$/, '')}/pos/me`,
			{
				headers: { Authorization: `Bearer ${settings.deviceToken}` },
				signal: AbortSignal.timeout(8_000),
			},
		)
		noteServerDate(response, sentAt)
		if (response.ok) {
			const body = (await response.json().catch(() => ({}))) as {
				device?: {
					signInRequired?: boolean
					scopeId?: string
					label?: string
					terminalCode?: string
					dayStartMinutes?: number
					shiftsRequired?: boolean
				}
				apps?: { timeclock?: boolean; reservations?: boolean }
				transfers?: Array<{ orderId: string; terminalCode: string }>
				fiscalChains?: PosFiscalChainHead[]
				zatca?: {
					status: string
					environment: string
					lastInvoiceHash?: string | null
				} | null
			}
			const d = body.device
			return {
				verdict: 'ok',
				device: d
					? {
							signInRequired: d.signInRequired === true,
							scopeId: d.scopeId ?? 'main',
							label: d.label ?? '',
							terminalCode: d.terminalCode ?? '',
							dayStartMinutes:
								typeof d.dayStartMinutes === 'number'
									? d.dayStartMinutes
									: null,
							shiftsRequired: d.shiftsRequired === true,
						}
					: undefined,
				apps: readApps(body.apps),
				transfers: Array.isArray(body.transfers) ? body.transfers : [],
				fiscalChains: Array.isArray(body.fiscalChains) ? body.fiscalChains : [],
				zatca: body.zatca ?? null,
			}
		}
		if (response.status === 401) {
			const body = (await response.json().catch(() => ({}))) as {
				error?: string
			}
			if (body.error === 'device_revoked') return { verdict: 'removed' }
			if (body.error === 'invalid_device') return { verdict: 'unrecognised' }
		}
		return { verdict: 'unknown' }
	} catch {
		return { verdict: 'unknown' }
	}
}

function readApps(raw: unknown): Partial<PosDeviceApps> {
	// An older node reports no apps: it offers none.
	if (!raw || typeof raw !== 'object')
		return { timeclock: false, reservations: false }
	const apps: Partial<PosDeviceApps> = {}
	const body = raw as Record<string, unknown>
	if (typeof body.timeclock === 'boolean') apps.timeclock = body.timeclock
	if (typeof body.reservations === 'boolean')
		apps.reservations = body.reservations
	return apps
}

export async function checkDevice(
	settings: PosSettings,
): Promise<'ok' | 'removed' | 'unrecognised' | 'unknown'> {
	return (await checkDeviceDetailed(settings)).verdict
}
