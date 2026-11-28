import { randomUUID } from 'node:crypto'

import { readGuestOrderingFeatures } from '@repo/common/guest-ordering'
import {
	affectedItemsCents,
	ORDER_PROBLEM_CREDIT_DEFAULT_DAYS,
	ORDER_PROBLEM_CREDIT_DISCOUNT_ID,
	ORDER_PROBLEM_MAX_PER_ORDER,
	ORDER_PROBLEM_PHOTO_MAX_BYTES,
	ORDER_PROBLEM_WINDOW_MS,
	orderReportable,
	problemUnanswered,
	problemWindowOpen,
	type AnswerOrderProblemRequest,
	type GuestOrderProblem,
	type GuestOrderProblemsResponse,
	type OperatorOrderProblem,
	type OperatorOrderProblemList,
	type OrderProblemEntryKind,
	type OrderProblemRefusal,
	type SubmitOrderProblemRequest,
	type SubmitOrderProblemResponse,
	ORDER_PROBLEM_UNANSWERED_MS,
} from '@repo/common/order-problems'
import { type PricedOrderLine } from '@repo/common/restaurant-orders'
import { generateMarketingCode } from '@repo/discounts'
import {
	discountIssuedCodes,
	getTenantDb,
	orderProblemReplies,
	orderProblems,
	restaurantOrders,
	runTenantTransaction,
	type OrderProblem,
	type OrderProblemItemSnapshot,
	type OrderProblemReply,
	type RestaurantOrder,
	type TenantDatabase,
} from '@repo/tenant-db'
import { and, asc, desc, eq, inArray, isNull, lte, sql } from 'drizzle-orm'

import { runInBackground } from '../lib/background.ts'
import { errorLogFields } from '../lib/error-log.ts'
import {
	GuestPhotoImageError,
	stripAndReencodeGuestPhoto,
	type HeicConverterAdapter,
} from '../lib/image-reencode.ts'
import { notifyGuestOfProblemAnswer } from '../lib/order-problem-notify.ts'
import {
	isOrdersAlertsEnabled,
	postOrdersNotify,
} from '../lib/orders-alerts.ts'
import {
	deleteRecordingObject,
	headStorageObject,
	organizationOrderProblemPrefix,
	presignObjectRead,
	putStorageObject,
} from '../lib/recording-storage.ts'
import { inJsonList, queryInChunks } from '../lib/chunked-in.ts'
import { retryOnSqliteBusy } from '../lib/sqlite-retry.ts'
import { createProviderRefundIntent } from './order-provider-refund-service.ts'
import {
	orderRefundableCents,
	pendingOrderRefundCentsInTx,
} from './order-refund-book.ts'
import { recordOrderRefund } from './order-refund-service.ts'
import {
	fetchOrderContext,
	orderFailure,
	runExclusive,
	type OrderServiceResult,
	type OrderTx,
} from './order-service.ts'

/**
 * Guest order problem reports and how they are settled (#191). The guest
 * reports from the order page with the capability they already hold (receipt
 * or order link); the restaurant answers from the Orders page with one tap:
 * refund the affected items, give a credit, reply only, or close.
 *
 * Everything a guest writes (the note, the photo, the words of the thread) is
 * guest data and stays in this region. The App receives only a generic "new
 * report" event with an order number and a fixed kind word.
 *
 * Money goes through what already exists: a refund is a provider refund
 * intent (online orders, the normal refund rules and limits, #80) or a
 * recorded refund (paid at handoff); a credit is a single-use code of
 * `discount_issued_codes` that checkout resolves like any issued code.
 */

export type ProblemStorageAdapter = {
	putObject: typeof putStorageObject
	headObject: typeof headStorageObject
	deleteObject: typeof deleteRecordingObject
	presignRead: typeof presignObjectRead
}

const defaultStorage: ProblemStorageAdapter = {
	putObject: putStorageObject,
	headObject: headStorageObject,
	deleteObject: deleteRecordingObject,
	presignRead: presignObjectRead,
}

const PHOTO_URL_TTL_SECONDS = 300
const CREDIT_CODE_ATTEMPTS = 5

function isUniqueViolation(error: unknown): boolean {
	return /UNIQUE constraint failed/i.test(
		String((error as { message?: unknown } | null)?.message ?? error ?? ''),
	)
}

function orderLines(order: Pick<RestaurantOrder, 'lines'>): PricedOrderLine[] {
	return Array.isArray(order.lines) ? (order.lines as PricedOrderLine[]) : []
}

/** What the guest may tick: the lines of the order, by position and name. */
function lineViews(order: RestaurantOrder) {
	return orderLines(order).map((line, lineIndex) => ({
		lineIndex,
		name: line.itemName,
		quantity: line.quantity,
	}))
}

function windowAnchor(order: RestaurantOrder): number | null {
	return order.completedAt ? order.completedAt.getTime() : null
}

// ---------------------------------------------------------------------------
// The flag, as the order context says it right now
// ---------------------------------------------------------------------------

const FLAG_CACHE_TTL_MS = 30_000
const FLAG_CACHE_MAX = 500
const flagCache = new Map<string, { enabled: boolean; expiresAt: number }>()

/** Tests: forget what the order context said about the flag. */
export function clearProblemFlagCacheForTest(): void {
	flagCache.clear()
}

/**
 * Whether `ordering.problem_reports` is on, read from the order context of the
 * order's location. Fails closed: anything unreadable is off. `fresh` skips
 * the 30-second cache (a write always asks again).
 */
async function problemReportsEnabled(
	orgId: string,
	order: RestaurantOrder,
	options: { fresh?: boolean; now?: number } = {},
): Promise<boolean> {
	const now = options.now ?? Date.now()
	const key = `${orgId}\u0000${order.locationId}`
	if (!options.fresh) {
		const hit = flagCache.get(key)
		if (hit && hit.expiresAt > now) return hit.enabled
	}
	const context = await fetchOrderContext(
		orgId,
		order.locationId,
		order.dropSlug ?? null,
	)
	const enabled = context.ok
		? readGuestOrderingFeatures(
				(context.data as { guestOrdering?: unknown }).guestOrdering,
			).problemReports
		: false
	if (flagCache.size >= FLAG_CACHE_MAX) flagCache.clear()
	flagCache.set(key, { enabled, expiresAt: now + FLAG_CACHE_TTL_MS })
	return enabled
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

type EntryRow = OrderProblemReply

function entryViews(rows: readonly EntryRow[]) {
	return rows.map((row) => ({
		id: row.id,
		kind: row.kind,
		author: row.authorKind,
		body: row.body,
		at: row.createdAt,
	}))
}

async function loadEntries(
	db: TenantDatabase | OrderTx,
	problemIds: readonly string[],
): Promise<Map<string, EntryRow[]>> {
	const byProblem = new Map<string, EntryRow[]>()
	if (problemIds.length === 0) return byProblem
	const rows = (
		await queryInChunks([...problemIds], (chunk) =>
			db
				.select()
				.from(orderProblemReplies)
				.where(inArray(orderProblemReplies.problemId, chunk)),
		)
	).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
	for (const row of rows) {
		const list = byProblem.get(row.problemId) ?? []
		list.push(row)
		byProblem.set(row.problemId, list)
	}
	return byProblem
}

async function creditCodesOf(
	db: TenantDatabase,
	problems: readonly OrderProblem[],
): Promise<Map<string, string>> {
	const ids = problems
		.map((problem) => problem.creditCodeId)
		.filter((id): id is string => Boolean(id))
	const codes = new Map<string, string>()
	if (ids.length === 0) return codes
	const rows = await queryInChunks(ids, (chunk) =>
		db
			.select({ id: discountIssuedCodes.id, code: discountIssuedCodes.code })
			.from(discountIssuedCodes)
			.where(inArray(discountIssuedCodes.id, chunk)),
	)
	for (const row of rows) codes.set(row.id, row.code)
	return codes
}

function guestProblemView(
	problem: OrderProblem,
	entries: readonly EntryRow[],
	codes: Map<string, string>,
): GuestOrderProblem {
	const code = problem.creditCodeId ? codes.get(problem.creditCodeId) : null
	return {
		id: problem.id,
		kind: problem.kind,
		status: problem.status,
		resolution: problem.resolution,
		createdAt: problem.createdAt,
		items: problem.itemRefs.map((item) => ({
			name: item.name,
			quantity: item.quantity,
		})),
		note: problem.note,
		hasPhoto: Boolean(problem.photoKey),
		refund:
			problem.refundCents != null ? { amountCents: problem.refundCents } : null,
		credit:
			code && problem.creditCents != null && problem.creditExpiresAt != null
				? {
						code,
						amountCents: problem.creditCents,
						expiresAt: problem.creditExpiresAt,
					}
				: null,
		entries: entryViews(entries),
	}
}

async function problemsOfOrder(db: TenantDatabase, orderId: string) {
	return db
		.select()
		.from(orderProblems)
		.where(eq(orderProblems.orderId, orderId))
		.orderBy(desc(orderProblems.createdAt), desc(orderProblems.id))
}

type Reportability = {
	allowed: boolean
	reason: OrderProblemRefusal | null
	until: number | null
}

function reportability(
	order: RestaurantOrder,
	existingCount: number,
	enabled: boolean,
	now: number,
): Reportability {
	const anchor = windowAnchor(order)
	const until = anchor == null ? null : anchor + ORDER_PROBLEM_WINDOW_MS
	if (!enabled) return { allowed: false, reason: 'disabled', until }
	if (!orderReportable(order)) {
		return { allowed: false, reason: 'not_reportable', until }
	}
	if (!problemWindowOpen(anchor, now)) {
		return { allowed: false, reason: 'window_closed', until }
	}
	if (existingCount >= ORDER_PROBLEM_MAX_PER_ORDER) {
		return { allowed: false, reason: 'limit_reached', until }
	}
	return { allowed: true, reason: null, until }
}

/** `GET /orders/:id/problems`: may the guest report, which lines, what exists. */
export async function readGuestProblems(
	orgId: string,
	order: RestaurantOrder,
	now: number = Date.now(),
): Promise<GuestOrderProblemsResponse> {
	const db = await getTenantDb(orgId)
	const enabled = await problemReportsEnabled(orgId, order, { now })
	const problems = enabled ? await problemsOfOrder(db, order.id) : []
	const entries = await loadEntries(
		db,
		problems.map((problem) => problem.id),
	)
	const codes = await creditCodesOf(db, problems)
	return {
		enabled,
		reportable: reportability(order, problems.length, enabled, now),
		lines: enabled ? lineViews(order) : [],
		problems: problems.map((problem) =>
			guestProblemView(problem, entries.get(problem.id) ?? [], codes),
		),
	}
}

// ---------------------------------------------------------------------------
// The guest's report
// ---------------------------------------------------------------------------

function snapshotItems(
	order: RestaurantOrder,
	items: SubmitOrderProblemRequest['items'],
): OrderProblemItemSnapshot[] | null {
	const lines = orderLines(order)
	const seen = new Set<number>()
	const out: OrderProblemItemSnapshot[] = []
	for (const item of items) {
		const line = lines[item.lineIndex]
		if (!line || seen.has(item.lineIndex)) return null
		if (item.quantity !== undefined && item.quantity > line.quantity) {
			return null
		}
		seen.add(item.lineIndex)
		const quantity = item.quantity ?? line.quantity
		out.push({
			lineIndex: item.lineIndex,
			itemId: line.itemId,
			name: line.itemName,
			quantity,
			amountCents: affectedItemsCents(
				lines.map((l) => ({ totalCents: l.totalCents, quantity: l.quantity })),
				[{ lineIndex: item.lineIndex, quantity }],
			),
		})
	}
	return out
}

export type SubmitProblemResult = OrderServiceResult<
	SubmitOrderProblemResponse & { replayed: boolean }
>

/**
 * `POST /orders/:id/problems`. One transaction under the order lock: a
 * repeated `Idempotency-Key` returns the entry it made; otherwise a second
 * report on an order whose report is still open is added to it (`addition`),
 * and a first one opens a new report. Refusals commit nothing.
 */
export async function submitGuestProblem(
	orgId: string,
	order: RestaurantOrder,
	input: {
		request: SubmitOrderProblemRequest
		idempotencyKey: string
		now?: number
	},
): Promise<SubmitProblemResult> {
	const now = input.now ?? Date.now()
	if (!(await problemReportsEnabled(orgId, order, { fresh: true, now }))) {
		return orderFailure(
			403,
			'problem_reports_disabled',
			'This restaurant does not take problem reports online.',
		)
	}
	const db = await getTenantDb(orgId)
	let created: { problemId: string; kind: OrderProblem['kind'] } | null = null
	const result: SubmitProblemResult = await runExclusive(orgId, () =>
		retryOnSqliteBusy(() =>
			runTenantTransaction(db, async (tx): Promise<SubmitProblemResult> => {
				created = null
				const [current] = await tx
					.select()
					.from(restaurantOrders)
					.where(
						and(
							eq(restaurantOrders.id, order.id),
							eq(restaurantOrders.orgId, orgId),
						),
					)
					.limit(1)
				if (!current) {
					return orderFailure(404, 'order_not_found', 'Order not found.')
				}

				const [replay] = await tx
					.select({
						problemId: orderProblemReplies.problemId,
						orderId: orderProblems.orderId,
						kind: orderProblemReplies.kind,
						photoKey: orderProblems.photoKey,
						status: orderProblems.status,
					})
					.from(orderProblemReplies)
					.innerJoin(
						orderProblems,
						eq(orderProblems.id, orderProblemReplies.problemId),
					)
					.where(eq(orderProblemReplies.idempotencyKey, input.idempotencyKey))
					.limit(1)
				if (replay) {
					if (replay.orderId !== current.id) {
						return orderFailure(
							409,
							'idempotency_conflict',
							'This report was already sent with different details.',
						)
					}
					return {
						ok: true,
						data: {
							problemId: replay.problemId,
							added: replay.kind === 'addition',
							canAttachPhoto: replay.status === 'open' && !replay.photoKey,
							replayed: true,
						},
					}
				}

				const existing = await tx
					.select()
					.from(orderProblems)
					.where(eq(orderProblems.orderId, current.id))
				const open = existing.find((problem) => problem.status === 'open')
				const verdict = reportability(current, existing.length, true, now)
				if (!verdict.allowed && !(open && verdict.reason === 'limit_reached')) {
					const refusal = verdict.reason
					return refusal === 'window_closed'
						? orderFailure(
								409,
								'problem_window_closed',
								'The time to report a problem with this order has passed.',
							)
						: refusal === 'limit_reached'
							? orderFailure(
									429,
									'problem_limit_reached',
									'This order already has the most reports allowed.',
								)
							: orderFailure(
									409,
									'order_not_reportable',
									'A problem cannot be reported on this order.',
								)
				}
				const items = snapshotItems(current, input.request.items)
				if (!items) {
					return orderFailure(
						422,
						'invalid_item_ref',
						'One of the items is not part of this order.',
					)
				}
				const note = input.request.note?.trim() || null

				if (open) {
					// A second report adds to the first: new items join it, the
					// words become an entry of the thread.
					const known = new Map(
						open.itemRefs.map((item) => [item.lineIndex, item]),
					)
					for (const item of items) {
						const was = known.get(item.lineIndex)
						if (!was || item.quantity > was.quantity) {
							known.set(item.lineIndex, item)
						}
					}
					const merged = [...known.values()].sort(
						(a, b) => a.lineIndex - b.lineIndex,
					)
					await tx
						.update(orderProblems)
						.set({ itemRefs: merged, updatedAt: now })
						.where(eq(orderProblems.id, open.id))
					await tx.insert(orderProblemReplies).values({
						problemId: open.id,
						kind: 'addition',
						authorKind: 'guest',
						body: note,
						idempotencyKey: input.idempotencyKey,
						createdAt: now,
					})
					return {
						ok: true,
						data: {
							problemId: open.id,
							added: true,
							canAttachPhoto: !open.photoKey,
							replayed: false,
						},
					}
				}

				const problemId = randomUUID()
				await tx.insert(orderProblems).values({
					id: problemId,
					orderId: current.id,
					locationId: current.locationId,
					kind: input.request.kind,
					itemRefs: items,
					note,
					status: 'open',
					createdAt: now,
					updatedAt: now,
				})
				await tx.insert(orderProblemReplies).values({
					problemId,
					kind: 'report',
					authorKind: 'guest',
					body: note,
					idempotencyKey: input.idempotencyKey,
					createdAt: now,
				})
				created = { problemId, kind: input.request.kind }
				return {
					ok: true,
					data: {
						problemId,
						added: false,
						canAttachPhoto: true,
						replayed: false,
					},
				}
			}),
		),
	)
	const made = created as {
		problemId: string
		kind: OrderProblem['kind']
	} | null
	if (result.ok && made) {
		runInBackground(
			notifyManagersOfProblem(orgId, db, {
				problemId: made.problemId,
				orderNumber: order.number,
				locationId: order.locationId,
				kind: made.kind,
				unanswered: false,
			}),
		)
	}
	return result
}

/**
 * `POST /orders/:id/problems/:problemId/photo`: attaches one photo to the
 * guest's open report. The bytes are checked by their own signature (never the
 * announced type), re-encoded (which drops EXIF and GPS), capped at 5 MB, and
 * stored in the region's bucket under `order-problems/<orgId>/`.
 */
export async function attachProblemPhoto(
	orgId: string,
	order: RestaurantOrder,
	problemId: string,
	rawBytes: Uint8Array,
	options: {
		storage?: ProblemStorageAdapter
		heicConverter?: HeicConverterAdapter
		now?: number
	} = {},
): Promise<OrderServiceResult<{ hasPhoto: true }>> {
	const storage = options.storage ?? defaultStorage
	const db = await getTenantDb(orgId)
	const [problem] = await db
		.select()
		.from(orderProblems)
		.where(
			and(eq(orderProblems.id, problemId), eq(orderProblems.orderId, order.id)),
		)
		.limit(1)
	// Another order's report reads exactly like a missing one.
	if (!problem) {
		return orderFailure(404, 'problem_not_found', 'Report not found.')
	}
	if (problem.status !== 'open') {
		return orderFailure(
			409,
			'problem_closed',
			'This report has already been answered.',
		)
	}
	if (problem.photoKey) {
		return orderFailure(
			409,
			'photo_unavailable',
			'This report already has a photo.',
		)
	}
	let cleaned
	try {
		cleaned = await stripAndReencodeGuestPhoto(rawBytes, {
			maxBytes: ORDER_PROBLEM_PHOTO_MAX_BYTES,
			heicConverter: options.heicConverter,
		})
	} catch (error) {
		if (error instanceof GuestPhotoImageError) {
			return orderFailure(
				error.status,
				error.code === 'file_too_large' ? 'photo_too_large' : 'photo_invalid',
				error.message,
			)
		}
		throw error
	}
	const key = `${organizationOrderProblemPrefix(orgId)}${randomUUID()}.${cleaned.extension}`
	const put = await storage.putObject(key, cleaned.bytes, cleaned.contentType)
	if (put !== 'uploaded') {
		return orderFailure(
			put === 'not_configured' ? 503 : 502,
			'photo_unavailable',
			'The photo could not be stored. Send the report without it.',
		)
	}
	const attached = await runExclusive(orgId, () =>
		retryOnSqliteBusy(async () => {
			const [row] = await db
				.update(orderProblems)
				.set({
					photoKey: key,
					photoContentType: cleaned.contentType,
					updatedAt: options.now ?? Date.now(),
				})
				.where(
					and(
						eq(orderProblems.id, problem.id),
						eq(orderProblems.status, 'open'),
						isNull(orderProblems.photoKey),
					),
				)
				.returning({ id: orderProblems.id })
			return Boolean(row)
		}),
	)
	if (!attached) {
		await storage.deleteObject(key).catch(() => {})
		return orderFailure(
			409,
			'photo_unavailable',
			'This report can no longer take a photo.',
		)
	}
	return { ok: true, data: { hasPhoto: true } }
}

// ---------------------------------------------------------------------------
// Managers are told (ids and a fixed word only)
// ---------------------------------------------------------------------------

async function notifyManagersOfProblem(
	orgId: string,
	db: TenantDatabase,
	input: {
		problemId: string
		orderNumber: string
		locationId: string
		kind: OrderProblem['kind']
		unanswered: boolean
	},
): Promise<void> {
	const column = input.unanswered
		? orderProblems.unansweredNotifiedAt
		: orderProblems.notifiedAt
	const mark = () =>
		db
			.update(orderProblems)
			.set(
				input.unanswered
					? { unansweredNotifiedAt: Date.now() }
					: { notifiedAt: Date.now() },
			)
			.where(and(eq(orderProblems.id, input.problemId), isNull(column)))
	try {
		// The node's kill switch drops the alert and queues nothing: marking it
		// told means switching back on sends no backlog.
		if (!isOrdersAlertsEnabled()) {
			await mark()
			return
		}
		const outcome = await postOrdersNotify({
			kind: 'order_problem',
			orgId,
			eventId: `problem:${input.problemId}${input.unanswered ? ':late' : ''}`,
			locationId: input.locationId,
			orderNumber: input.orderNumber,
			problemKind: input.kind,
			unanswered: input.unanswered,
		})
		// `retry` leaves the row unmarked: the orders tick sends it again.
		if (outcome.status !== 'retry') await mark()
	} catch (error) {
		console.warn(
			'Order problem alert not sent',
			orgId,
			input.problemId,
			errorLogFields(error),
		)
	}
}

/**
 * The regional tick's share (#191): reports whose new-report alert has not been
 * confirmed yet, and open reports that waited 24 hours (once each). Returns how
 * many alerts it sent and when the next one falls due, so the alarm can sleep.
 */
export async function runOrderProblemsTickForOrg(
	orgId: string,
	db: TenantDatabase,
	now: number = Date.now(),
): Promise<{ alerted: number; nextDueAt: number | null }> {
	const recent = await db
		.select({
			id: orderProblems.id,
			orderId: orderProblems.orderId,
			locationId: orderProblems.locationId,
			kind: orderProblems.kind,
			status: orderProblems.status,
			createdAt: orderProblems.createdAt,
			notifiedAt: orderProblems.notifiedAt,
			unansweredNotifiedAt: orderProblems.unansweredNotifiedAt,
		})
		.from(orderProblems)
		.where(
			and(
				eq(orderProblems.status, 'open'),
				// Bounded: only open reports, and no report waits longer than a
				// few days before somebody answers or it is closed.
				sql`(${orderProblems.notifiedAt} is null or ${orderProblems.unansweredNotifiedAt} is null)`,
			),
		)
		.orderBy(asc(orderProblems.createdAt))
		.limit(100)
	let alerted = 0
	let nextDueAt: number | null = null
	for (const row of recent) {
		const [order] = await db
			.select({ number: restaurantOrders.number })
			.from(restaurantOrders)
			.where(eq(restaurantOrders.id, row.orderId))
			.limit(1)
		if (!order) continue
		if (row.notifiedAt === null) {
			await notifyManagersOfProblem(orgId, db, {
				problemId: row.id,
				orderNumber: order.number,
				locationId: row.locationId,
				kind: row.kind,
				unanswered: false,
			})
			alerted += 1
		}
		if (row.unansweredNotifiedAt === null) {
			if (
				problemUnanswered({ status: row.status, createdAt: row.createdAt }, now)
			) {
				await notifyManagersOfProblem(orgId, db, {
					problemId: row.id,
					orderNumber: order.number,
					locationId: row.locationId,
					kind: row.kind,
					unanswered: true,
				})
				alerted += 1
			} else {
				const due = row.createdAt + ORDER_PROBLEM_UNANSWERED_MS
				nextDueAt = nextDueAt === null ? due : Math.min(nextDueAt, due)
			}
		}
	}
	return { alerted, nextDueAt }
}

// ---------------------------------------------------------------------------
// The operator's inbox
// ---------------------------------------------------------------------------

export type ProblemOperator = {
	userId: string
	/** Locations this token reaches; null is every location. */
	locationIds: string[] | null
	refundProvider: boolean
	refundLoyalty: boolean
	impersonated: boolean
}

function inScope(
	locationIds: readonly string[] | null,
	locationId: string,
): boolean {
	return locationIds === null || locationIds.includes(locationId)
}

async function operatorView(
	db: TenantDatabase,
	problem: OrderProblem,
	order: RestaurantOrder,
	entries: readonly EntryRow[],
	options: { storage: ProblemStorageAdapter; now: number; photo: boolean },
): Promise<OperatorOrderProblem> {
	const lines = orderLines(order)
	const pending = await pendingOrderRefundCentsInTx(
		db as unknown as OrderTx,
		order.id,
	)
	let photoUrl: string | null = null
	if (options.photo && problem.photoKey && problem.photoContentType) {
		photoUrl =
			options.storage.presignRead(problem.photoKey, {
				contentType: problem.photoContentType,
				expiresInSeconds: PHOTO_URL_TTL_SECONDS,
			})?.url ?? null
	}
	return {
		id: problem.id,
		orderId: order.id,
		orderNumber: order.number,
		locationId: problem.locationId,
		locationName: order.locationName,
		contactName: order.contactName || null,
		kind: problem.kind,
		status: problem.status,
		resolution: problem.resolution,
		items: problem.itemRefs,
		note: problem.note,
		photoUrl,
		hasPhoto: Boolean(problem.photoKey),
		createdAt: problem.createdAt,
		updatedAt: problem.updatedAt,
		resolvedAt: problem.resolvedAt,
		unanswered:
			problem.status === 'open' &&
			options.now - problem.createdAt >= ORDER_PROBLEM_UNANSWERED_MS,
		currency: order.currency,
		orderTotalCents: order.totalCents,
		paymentMethod: order.paymentMethod,
		paymentStatus: order.paymentStatus,
		affectedCents: affectedItemsCents(
			lines.map((line) => ({
				totalCents: line.totalCents,
				quantity: line.quantity,
			})),
			problem.itemRefs.map((item) => ({
				lineIndex: item.lineIndex,
				quantity: item.quantity,
			})),
		),
		refundableCents: orderRefundableCents(order, pending),
		refundCents: problem.refundCents,
		creditCents: problem.creditCents,
		creditExpiresAt: problem.creditExpiresAt,
		entries: entryViews(entries),
	}
}

export async function listOperatorProblems(
	orgId: string,
	operator: Pick<ProblemOperator, 'locationIds'>,
	query: {
		status?: 'open' | 'answered' | 'closed' | 'all'
		orderId?: string
		limit?: number
	},
	options: { storage?: ProblemStorageAdapter; now?: number } = {},
): Promise<OperatorOrderProblemList> {
	const db = await getTenantDb(orgId)
	const now = options.now ?? Date.now()
	const storage = options.storage ?? defaultStorage
	const limit = Math.min(Math.max(query.limit ?? 50, 1), 100)
	const conditions = [
		query.status && query.status !== 'all'
			? eq(orderProblems.status, query.status)
			: undefined,
		query.orderId ? eq(orderProblems.orderId, query.orderId) : undefined,
		operator.locationIds
			? inJsonList(orderProblems.locationId, operator.locationIds)
			: undefined,
	].filter((condition) => condition !== undefined)
	if (operator.locationIds && operator.locationIds.length === 0) {
		return { problems: [], counts: { open: 0, unanswered: 0 } }
	}
	const rows = await db
		.select()
		.from(orderProblems)
		.where(conditions.length > 0 ? and(...conditions) : undefined)
		// Open reports first, oldest first (they wait longest); answered ones newest first.
		.orderBy(
			sql`case ${orderProblems.status} when 'open' then 0 else 1 end`,
			sql`case ${orderProblems.status} when 'open' then ${orderProblems.createdAt} else -${orderProblems.createdAt} end`,
		)
		.limit(limit)
	const orderIds = [...new Set(rows.map((row) => row.orderId))]
	const orders = await queryInChunks(orderIds, (chunk) =>
		db
			.select()
			.from(restaurantOrders)
			.where(inArray(restaurantOrders.id, chunk)),
	)
	const orderById = new Map(orders.map((order) => [order.id, order]))
	const entries = await loadEntries(
		db,
		rows.map((row) => row.id),
	)
	const problems: OperatorOrderProblem[] = []
	for (const row of rows) {
		const order = orderById.get(row.orderId)
		if (!order) continue
		problems.push(
			await operatorView(db, row, order, entries.get(row.id) ?? [], {
				storage,
				now,
				photo: Boolean(query.orderId),
			}),
		)
	}
	const counts = await problemCounts(db, operator.locationIds, now)
	return { problems, counts }
}

/** Counts of open and unanswered reports, for the inbox badge and Needs attention. */
export async function problemCounts(
	db: TenantDatabase,
	locationIds: readonly string[] | null,
	now: number = Date.now(),
): Promise<{ open: number; unanswered: number }> {
	if (locationIds && locationIds.length === 0) return { open: 0, unanswered: 0 }
	const [row] = await db
		.select({
			open: sql<number>`count(*)`,
			unanswered: sql<number>`coalesce(sum(case when ${orderProblems.createdAt} <= ${now - ORDER_PROBLEM_UNANSWERED_MS} then 1 else 0 end), 0)`,
		})
		.from(orderProblems)
		.where(
			and(
				eq(orderProblems.status, 'open'),
				locationIds
					? inJsonList(orderProblems.locationId, locationIds)
					: undefined,
			),
		)
	return {
		open: Number(row?.open ?? 0),
		unanswered: Number(row?.unanswered ?? 0),
	}
}

/** Open and unanswered reports per location (ids and numbers only). */
export async function problemAttentionByLocation(
	db: TenantDatabase,
	locationIds: readonly string[] | null,
	now: number = Date.now(),
): Promise<Array<{ locationId: string; open: number; unanswered: number }>> {
	if (locationIds && locationIds.length === 0) return []
	const rows = await db
		.select({
			locationId: orderProblems.locationId,
			open: sql<number>`count(*)`,
			unanswered: sql<number>`coalesce(sum(case when ${orderProblems.createdAt} <= ${now - ORDER_PROBLEM_UNANSWERED_MS} then 1 else 0 end), 0)`,
		})
		.from(orderProblems)
		.where(
			and(
				eq(orderProblems.status, 'open'),
				locationIds
					? inJsonList(orderProblems.locationId, locationIds)
					: undefined,
			),
		)
		.groupBy(orderProblems.locationId)
	return rows.map((row) => ({
		locationId: row.locationId,
		open: Number(row.open),
		unanswered: Number(row.unanswered),
	}))
}

export async function getOperatorProblem(
	orgId: string,
	operator: Pick<ProblemOperator, 'locationIds'>,
	problemId: string,
	options: { storage?: ProblemStorageAdapter; now?: number } = {},
): Promise<OrderServiceResult<OperatorOrderProblem>> {
	const db = await getTenantDb(orgId)
	const [problem] = await db
		.select()
		.from(orderProblems)
		.where(eq(orderProblems.id, problemId))
		.limit(1)
	if (!problem || !inScope(operator.locationIds, problem.locationId)) {
		return orderFailure(404, 'problem_not_found', 'Report not found.')
	}
	const [order] = await db
		.select()
		.from(restaurantOrders)
		.where(eq(restaurantOrders.id, problem.orderId))
		.limit(1)
	if (!order) return orderFailure(404, 'problem_not_found', 'Report not found.')
	const entries = await loadEntries(db, [problem.id])
	return {
		ok: true,
		data: await operatorView(
			db,
			problem,
			order,
			entries.get(problem.id) ?? [],
			{
				storage: options.storage ?? defaultStorage,
				now: options.now ?? Date.now(),
				photo: true,
			},
		),
	}
}

// ---------------------------------------------------------------------------
// The answer
// ---------------------------------------------------------------------------

const REFUND_NOTE = 'Order problem'

type Finish = {
	entryKind: OrderProblemEntryKind
	resolution: 'refund' | 'credit' | 'reply' | 'closed'
	status: 'answered' | 'closed'
	message: string | null
	set?: Partial<typeof orderProblems.$inferInsert>
}

export type AnswerProblemResult = OrderServiceResult<{
	problem: OperatorOrderProblem
	refundIntent?: { refundId: string; status: string; replayed: boolean }
}>

/**
 * The operator's one-tap answer. A refund goes first and is idempotent by a key
 * made from the report, so a retry after a failed write completes the answer
 * without refunding twice; the report is then marked answered with a
 * compare-and-set on `open`, so two people answering at once settle it once.
 */
export async function answerOrderProblem(
	orgId: string,
	operator: ProblemOperator,
	problemId: string,
	request: AnswerOrderProblemRequest,
	options: { storage?: ProblemStorageAdapter; now?: number } = {},
): Promise<AnswerProblemResult> {
	const now = options.now ?? Date.now()
	const db = await getTenantDb(orgId)
	const [problem] = await db
		.select()
		.from(orderProblems)
		.where(eq(orderProblems.id, problemId))
		.limit(1)
	if (!problem || !inScope(operator.locationIds, problem.locationId)) {
		return orderFailure(404, 'problem_not_found', 'Report not found.')
	}
	const [order] = await db
		.select()
		.from(restaurantOrders)
		.where(eq(restaurantOrders.id, problem.orderId))
		.limit(1)
	if (!order) return orderFailure(404, 'problem_not_found', 'Report not found.')
	if (problem.status !== 'open') {
		return orderFailure(
			409,
			'problem_already_answered',
			'This report has already been answered.',
		)
	}

	const lines = orderLines(order).map((line) => ({
		totalCents: line.totalCents,
		quantity: line.quantity,
	}))
	const affected = affectedItemsCents(
		lines,
		problem.itemRefs.map((item) => ({
			lineIndex: item.lineIndex,
			quantity: item.quantity,
		})),
	)

	let finish: Finish
	let refundIntent:
		{ refundId: string; status: string; replayed: boolean } | undefined
	let creditMessage: {
		amountCents: number
		expiresAt: number
		code: string
	} | null = null

	if (request.action === 'refund') {
		const amountCents = request.amountCents ?? affected
		if (amountCents < 1) {
			return orderFailure(
				422,
				'refund_not_allowed',
				'Choose an amount: no items were marked on this report.',
			)
		}
		if (order.isTest || order.paymentStatus !== 'paid') {
			return orderFailure(
				409,
				'refund_not_allowed',
				'Nothing was paid for this order, so there is nothing to refund. Give a credit instead.',
			)
		}
		const key = `order-problem:${problem.id}:refund`
		let refundId: string
		let refundedCents = amountCents
		if (order.paymentMethod === 'online') {
			if (!operator.refundProvider) {
				return orderFailure(
					403,
					'refund_forbidden',
					'Refunding an online payment needs the right to refund orders.',
				)
			}
			const booked = await createProviderRefundIntent({
				orgId,
				orderRef: order.id,
				amount: { amountCents },
				note: REFUND_NOTE,
				idempotencyKey: key,
				origin: 'operator',
				actorId: operator.userId,
				now,
				kick: true,
				loyaltyAccess: {
					refundLoyalty: operator.refundLoyalty,
					impersonated: operator.impersonated,
				},
				locationIds: operator.locationIds,
			})
			if (!booked.ok) return booked
			refundId = booked.data.refund.refundId
			refundedCents = booked.data.refund.amountCents
			refundIntent = {
				refundId,
				status: booked.data.refund.status,
				replayed: booked.data.replayed,
			}
		} else {
			const recorded = await recordOrderRefund(orgId, order.id, {
				request: { amountCents, note: REFUND_NOTE },
				actorId: operator.userId,
				idempotencyKey: key,
				loyaltyAccess: {
					refundLoyalty: operator.refundLoyalty,
					impersonated: operator.impersonated,
				},
				now,
			})
			if (!recorded.ok) return recorded
			refundId = recorded.data.refund.id
			refundedCents = recorded.data.refund.amountCents
		}
		finish = {
			entryKind: 'refund',
			resolution: 'refund',
			status: 'answered',
			message: request.message ?? null,
			set: { refundId, refundCents: refundedCents },
		}
	} else if (request.action === 'credit') {
		const amountCents = request.amountCents ?? affected
		if (amountCents < 1) {
			return orderFailure(
				422,
				'credit_not_allowed',
				'Choose an amount: no items were marked on this report.',
			)
		}
		if (order.isTest) {
			return orderFailure(
				409,
				'credit_not_allowed',
				'A test order cannot be given a credit.',
			)
		}
		const expiresAt =
			now +
			(request.validDays ?? ORDER_PROBLEM_CREDIT_DEFAULT_DAYS) * 86_400_000
		finish = {
			entryKind: 'credit',
			resolution: 'credit',
			status: 'answered',
			message: request.message ?? null,
			set: { creditCents: amountCents, creditExpiresAt: expiresAt },
		}
		creditMessage = { amountCents, expiresAt, code: '' }
	} else if (request.action === 'reply') {
		finish = {
			entryKind: 'reply',
			resolution: 'reply',
			status: 'answered',
			message: request.message,
		}
	} else {
		finish = {
			entryKind: 'close',
			resolution: 'closed',
			status: 'closed',
			message: request.message ?? null,
		}
	}

	const settled: OrderServiceResult<true> = await runExclusive(orgId, () =>
		retryOnSqliteBusy(() =>
			runTenantTransaction(
				db,
				async (tx): Promise<OrderServiceResult<true>> => {
					const [claimed] = await tx
						.update(orderProblems)
						.set({
							status: finish.status,
							resolution: finish.resolution,
							resolvedBy: operator.userId,
							resolvedAt: now,
							updatedAt: now,
							...finish.set,
						})
						.where(
							and(
								eq(orderProblems.id, problem.id),
								eq(orderProblems.status, 'open'),
							),
						)
						.returning({ id: orderProblems.id })
					if (!claimed) {
						return orderFailure(
							409,
							'problem_already_answered',
							'This report has already been answered.',
						)
					}
					if (creditMessage) {
						// The code is minted in the same write that records it, so a
						// credit is never promised without a code behind it.
						let minted: { id: string; code: string } | null = null
						for (
							let attempt = 0;
							attempt < CREDIT_CODE_ATTEMPTS && !minted;
							attempt++
						) {
							const { code, normalizedCode } = generateMarketingCode(
								'CR',
								(length) => crypto.getRandomValues(new Uint8Array(length)),
							)
							try {
								const [row] = await tx
									.insert(discountIssuedCodes)
									.values({
										discountId: ORDER_PROBLEM_CREDIT_DISCOUNT_ID,
										code,
										normalizedCode,
										sourceType: 'order_problem',
										sourceId: problem.id,
										customerId: order.customerId,
										expiresAt: creditMessage.expiresAt,
										createdAt: now,
									})
									.returning({
										id: discountIssuedCodes.id,
										code: discountIssuedCodes.code,
									})
								minted = row ?? null
							} catch (error) {
								if (!isUniqueViolation(error)) throw error
							}
						}
						if (!minted) throw new Error('Could not mint a unique credit code')
						creditMessage.code = minted.code
						await tx
							.update(orderProblems)
							.set({ creditCodeId: minted.id })
							.where(eq(orderProblems.id, problem.id))
					}
					await tx.insert(orderProblemReplies).values({
						problemId: problem.id,
						kind: finish.entryKind,
						authorKind: 'operator',
						authorId: operator.userId,
						body: finish.message,
						createdAt: now,
					})
					return { ok: true, data: true }
				},
			),
		),
	)
	if (!settled.ok) {
		// A refund booked a moment before somebody else answered stays booked
		// (its key is the report's): say so, so nobody refunds twice by hand.
		return refundIntent
			? orderFailure(
					409,
					settled.failure.code,
					'This report was answered by someone else, and the refund you asked for was booked.',
					{ details: { refundBooked: true } },
				)
			: settled
	}

	const result = await getOperatorProblem(
		orgId,
		{ locationIds: operator.locationIds },
		problem.id,
		options,
	)
	if (!result.ok) return result
	runInBackground(
		notifyGuestOfProblemAnswer({
			orgId,
			db,
			order,
			problemId: problem.id,
			answer: {
				action: request.action,
				amountCents:
					request.action === 'refund'
						? (result.data.refundCents ?? undefined)
						: request.action === 'credit'
							? (creditMessage?.amountCents ?? undefined)
							: undefined,
				creditCode: creditMessage?.code || undefined,
				creditExpiresAt: creditMessage?.expiresAt,
				message: finish.message,
			},
		}).then(() => undefined),
	)
	return { ok: true, data: { problem: result.data, refundIntent } }
}

// ---------------------------------------------------------------------------
// Reading what the thread says about an order (used elsewhere by id only)
// ---------------------------------------------------------------------------

/** Whether the order has an open report (a later post-visit request skips it). */
export async function orderHasOpenProblem(
	db: TenantDatabase,
	orderId: string,
): Promise<boolean> {
	const [row] = await db
		.select({ id: orderProblems.id })
		.from(orderProblems)
		.where(
			and(eq(orderProblems.orderId, orderId), eq(orderProblems.status, 'open')),
		)
		.limit(1)
	return Boolean(row)
}

/** Reports whose date is older than `cutoff` and still open (for tests and sweeps). */
export async function openProblemsOlderThan(
	db: TenantDatabase,
	cutoff: number,
): Promise<OrderProblem[]> {
	return db
		.select()
		.from(orderProblems)
		.where(
			and(
				eq(orderProblems.status, 'open'),
				lte(orderProblems.createdAt, cutoff),
			),
		)
}
