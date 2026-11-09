import { Hono } from 'hono'
import {
	confirmInvoicePhotoSchema,
	doneTaskSchema,
	generatePrepSchema,
	prepQuerySchema,
	prepTaskActionSchema,
	prepPlanSchema,
	prepTaskSchema,
	inventoryIdSchema,
	isLateSync,
	stationCatalogQuerySchema,
	stationCountEntriesResultSchema,
	stationCountEntriesSchema,
	stationCountSheetSchema,
	stationCountSummarySchema,
	stationDeliveryResultSchema,
	stationDeliverySchema,
	stationDishWasteResultSchema,
	stationDishWasteSchema,
	stationPhotoConfirmResultSchema,
	stationPhotoRequestSchema,
	stationPhotoUploadSchema,
	stationSendCountSchema,
	stationStartCountResultSchema,
	stationStartCountSchema,
	stationUndoWasteResultSchema,
	stationWasteResultSchema,
	stationWasteSchema,
	STATION_WASTE_UNDO_SERVER_MS,
	undoWasteSchema,
} from '@repo/inventory'
import { InventoryError } from '../lib/inventory-http.ts'
import { getInventoryFlagState } from '../lib/inventory-context.ts'
import {
	hashInventoryRequest,
	type InventoryIdempotency,
} from '../lib/inventory-write.ts'
import {
	stationError,
	stationJson,
	stationRoute,
	type StationCtx,
} from '../lib/pos-inventory-http.ts'
import { notFound, type InventoryActor } from '../services/inventory-common.ts'
import {
	addCountEntries,
	getCountSheet,
	sendCountForReview,
	startOrJoinCount,
} from '../services/inventory-counts-service.ts'
import {
	loadAllowedDelivery,
	recordDelivery,
} from '../services/inventory-purchasing-service.ts'
import {
	confirmInvoicePhoto,
	requestInvoicePhotoUpload,
} from '../services/inventory-receiving-service.ts'
import { getInventorySettings } from '../services/inventory-settings-service.ts'
import { logDishWaste } from '../services/inventory-dish-waste-service.ts'
import {
	donePrepTask,
	generatePrep,
	getPrepPlan,
	skipPrepTask,
	startPrepTask,
} from '../services/inventory-prep-service.ts'
import { logWaste, undoWaste } from '../services/inventory-waste-service.ts'
import {
	activeRosterIds,
	buildStationCatalog,
	makeActorResolver,
} from '../services/pos-inventory-service.ts'

/**
 * `/pos/inventory`: the Stock app on a paired Station terminal. Counts, waste
 * and quantity-only deliveries, all through the same regional services the App
 * uses, on the terminal's device secret plus the signed-in person's session
 * (`lib/pos-inventory-http.ts` has the envelope; the wire contract is
 * `packages/inventory/src/contract/station.ts`).
 *
 * The actor is the signed-in person. A queued item may name another person
 * (`madeBy`), honoured only while that person is still on this terminal's
 * roster; the audit trail then also records who synced it. Money never
 * appears: prices are confirmed later in the App (`pricesPending`).
 */
export const posInventoryRoutes = new Hono()

/** Test seam: the clock `lateSync` is judged against. */
export const posInventoryDeps = { now: () => Date.now() }

const scope = (ctx: StationCtx, kind: string) =>
	`pos-inventory:${ctx.pos.device.id}:${kind}`

function idempotency(
	ctx: StationCtx,
	kind: string,
	clientId: string,
	body: unknown,
): InventoryIdempotency {
	return {
		scope: scope(ctx, kind),
		key: clientId,
		requestHash: hashInventoryRequest(body),
	}
}

/** A path id; anything that cannot be an id is a 404 like an unknown one. */
function idParam(ctx: StationCtx, name = 'id'): string {
	const parsed = inventoryIdSchema.safeParse(ctx.c.req.param(name))
	if (!parsed.success) throw notFound()
	return parsed.data
}

/** Who each queued item is attributed to: the session's person unless a roster member is named. */
async function actorsFor(
	ctx: StationCtx,
	items: ReadonlyArray<{ clientId: string; madeBy?: string }>,
): Promise<{
	actorFor: (clientId: string) => InventoryActor
	resolve: (madeBy: string | undefined) => InventoryActor
}> {
	const named = items
		.map((item) => item.madeBy)
		.filter((id): id is string => !!id && id !== ctx.session.staffId)
	const roster = named.length
		? await activeRosterIds(ctx.pos.db, ctx.pos.device.scopeId, named)
		: new Set<string>()
	const resolve = makeActorResolver({
		sessionStaffId: ctx.session.staffId,
		roster,
	})
	const byClient = new Map(
		items.map((item) => [item.clientId, resolve(item.madeBy)]),
	)
	return {
		resolve,
		actorFor: (clientId) => byClient.get(clientId) ?? resolve(undefined),
	}
}

const etagOf = (version: string) => `"${version}"`

/** Whether an `If-None-Match` header names this version (a strong or weak tag, or a list). */
function matchesEtag(header: string | undefined, version: string): boolean {
	if (!header) return false
	return header
		.split(',')
		.map((tag) => tag.trim().replace(/^W\//, ''))
		.some((tag) => tag === '*' || tag === etagOf(version))
}

// ── Catalogue ───────────────────────────────────────────────────────────────

posInventoryRoutes.get(
	'/catalog',
	stationRoute(
		{
			query: stationCatalogQuerySchema,
			locations: (query) => [query.locationId],
		},
		async (ctx) => {
			const flags = await getInventoryFlagState(ctx.pos.orgId)
			const settings = await getInventorySettings(ctx.pos.db, ctx.caller.region)
			const catalog = await buildStationCatalog(ctx.pos.db, {
				orgId: ctx.pos.orgId,
				region: ctx.caller.region,
				locationId: ctx.locationId,
				deviceId: ctx.pos.device.id,
				ordersEnabled: flags.features.purchasing,
				anyStaffCanReceive: settings.anyStaffCanReceive === true,
				now: posInventoryDeps.now(),
			})
			const headers = {
				'Cache-Control': 'private, no-store',
				ETag: etagOf(catalog.version),
			}
			if (matchesEtag(ctx.c.req.header('If-None-Match'), catalog.version)) {
				return new Response(null, { status: 304, headers })
			}
			return Response.json(catalog, { status: 200, headers })
		},
	),
)

// ── Counts ──────────────────────────────────────────────────────────────────

posInventoryRoutes.post(
	'/counts',
	stationRoute(
		{
			body: stationStartCountSchema,
			locations: (body) => [body.locationId],
		},
		async (ctx, body) => {
			const { resolve } = await actorsFor(ctx, [
				{ clientId: body.clientId, madeBy: body.madeBy },
			])
			const result = await startOrJoinCount(
				{ ...ctx.caller, actor: resolve(body.madeBy) },
				{
					clientId: body.clientId,
					locationId: body.locationId,
					listId: body.listId,
					idempotency: idempotency(ctx, 'count_start', body.clientId, body),
				},
			)
			return stationJson(
				stationStartCountResultSchema.parse({
					count: stationCountSummarySchema.parse(result.count),
					joined: result.joined,
				}),
			)
		},
	),
)

posInventoryRoutes.get(
	'/counts/:id',
	stationRoute({}, async (ctx) => {
		const sheet = await getCountSheet(ctx.pos.db, {
			id: idParam(ctx),
			caller: ctx.caller,
		})
		return stationJson(stationCountSheetSchema.parse(sheet))
	}),
)

posInventoryRoutes.post(
	'/counts/:id/entries',
	stationRoute({ body: stationCountEntriesSchema }, async (ctx, body) => {
		const id = idParam(ctx)
		const { actorFor } = await actorsFor(ctx, body.entries)
		const result = await addCountEntries(
			ctx.caller,
			{
				id,
				body: {
					entries: body.entries.map(
						({ madeBy: ignoredBy, madeAt: ignoredAt, ...entry }) => entry,
					),
				},
			},
			{ station: { actorFor, syncedBy: ctx.session.staffId } },
		)
		return stationJson(stationCountEntriesResultSchema.parse(result))
	}),
)

posInventoryRoutes.post(
	'/counts/:id/send',
	stationRoute({ body: stationSendCountSchema }, async (ctx, body) => {
		const id = idParam(ctx)
		const { resolve } = await actorsFor(ctx, [
			{ clientId: body.clientId, madeBy: body.madeBy },
		])
		const summary = await sendCountForReview(
			{ ...ctx.caller, actor: resolve(body.madeBy) },
			{
				id,
				idempotency: idempotency(ctx, 'count_send', body.clientId, {
					id,
					...body,
				}),
			},
		)
		return stationJson(stationCountSummarySchema.parse(summary))
	}),
)

// ── Waste ───────────────────────────────────────────────────────────────────

posInventoryRoutes.post(
	'/waste',
	stationRoute(
		{
			body: stationWasteSchema,
			locations: (body) => body.entries.map((entry) => entry.locationId),
		},
		async (ctx, body) => {
			const now = posInventoryDeps.now()
			const { actorFor } = await actorsFor(ctx, body.entries)
			const madeAt = new Map(
				body.entries.map((entry) => [entry.clientId, entry.madeAt]),
			)
			const result = await logWaste(
				ctx.caller,
				{
					entries: body.entries.map(
						({ madeBy: ignoredBy, madeAt: ignoredAt, ...entry }) => entry,
					),
				},
				{
					station: {
						deviceId: ctx.pos.device.id,
						actorFor,
						syncedBy: ctx.session.staffId,
						madeAt: (clientId) => madeAt.get(clientId),
						lateSync: (clientId) => {
							const at = madeAt.get(clientId)
							return at !== undefined && isLateSync(at, now)
						},
					},
				},
			)
			return stationJson(stationWasteResultSchema.parse(result))
		},
	),
)

/**
 * Kitchen "Log it as waste?": dishes a cook had started on a ticket that was
 * cancelled, recorded as waste of their ingredients. Needs the recipes flag.
 */
posInventoryRoutes.post(
	'/waste/dishes',
	stationRoute(
		{
			body: stationDishWasteSchema,
			locations: (body) => [body.locationId],
		},
		async (ctx, body) => {
			const flags = await getInventoryFlagState(ctx.pos.orgId)
			if (flags.status !== 'on' || !flags.features.recipes) {
				return stationError(
					flags.status === 'on' || flags.status === 'off'
						? 'inventory_disabled'
						: 'inventory_unavailable',
				)
			}
			const result = await logDishWaste(ctx.caller, {
				clientId: body.clientId,
				locationId: body.locationId,
				lines: body.lines.map((line) => ({
					itemId: line.itemId,
					variantId: line.variantId ?? null,
					quantity: line.quantity,
				})),
				deviceId: ctx.pos.device.id,
				idempotency: idempotency(ctx, 'dish_waste', body.clientId, body),
			})
			return stationJson(stationDishWasteResultSchema.parse(result))
		},
	),
)

posInventoryRoutes.post(
	'/waste/:id/undo',
	stationRoute({ body: undoWasteSchema }, async (ctx, body) => {
		const entry = await undoWaste(
			ctx.caller,
			{ id: idParam(ctx), clientId: body.clientId },
			{
				station: {
					deviceId: ctx.pos.device.id,
					windowMs: STATION_WASTE_UNDO_SERVER_MS,
				},
			},
		)
		return stationJson(stationUndoWasteResultSchema.parse({ id: entry.id }))
	}),
)

// ── Prep ────────────────────────────────────────────────────────────────────

/** Prep needs `inventory.prep` on top of the Stock gate. */
async function prepGate(ctx: StationCtx): Promise<Response | null> {
	const flags = await getInventoryFlagState(ctx.pos.orgId)
	if (flags.status === 'on' && flags.features.prep) return null
	return stationError(
		flags.status === 'on' || flags.status === 'off'
			? 'inventory_disabled'
			: 'inventory_unavailable',
	)
}

posInventoryRoutes.get(
	'/prep',
	stationRoute(
		{ query: prepQuerySchema, locations: (query) => [query.locationId] },
		async (ctx, query) => {
			const refused = await prepGate(ctx)
			if (refused) return refused
			const plan = await getPrepPlan(ctx.pos.db, {
				caller: ctx.caller,
				locationId: query.locationId,
				date: query.date,
				stationId: query.stationId,
				now: posInventoryDeps.now(),
			})
			return stationJson(prepPlanSchema.parse(plan))
		},
	),
)

posInventoryRoutes.post(
	'/prep/generate',
	stationRoute(
		{ body: generatePrepSchema, locations: (body) => [body.locationId] },
		async (ctx, body) => {
			const refused = await prepGate(ctx)
			if (refused) return refused
			const plan = await generatePrep(ctx.caller, {
				locationId: body.locationId,
				date: body.date,
			})
			return stationJson(prepPlanSchema.parse(plan))
		},
	),
)

posInventoryRoutes.post(
	'/prep/tasks/:id/start',
	stationRoute({ body: prepTaskActionSchema }, async (ctx, body) => {
		const refused = await prepGate(ctx)
		if (refused) return refused
		const task = await startPrepTask(ctx.caller, {
			id: idParam(ctx),
			expectedVersion: body.expectedVersion,
		})
		return stationJson(prepTaskSchema.parse(task))
	}),
)

posInventoryRoutes.post(
	'/prep/tasks/:id/skip',
	stationRoute({ body: prepTaskActionSchema }, async (ctx, body) => {
		const refused = await prepGate(ctx)
		if (refused) return refused
		const task = await skipPrepTask(ctx.caller, {
			id: idParam(ctx),
			expectedVersion: body.expectedVersion,
		})
		return stationJson(prepTaskSchema.parse(task))
	}),
)

posInventoryRoutes.post(
	'/prep/tasks/:id/done',
	stationRoute({ body: doneTaskSchema }, async (ctx, body) => {
		const refused = await prepGate(ctx)
		if (refused) return refused
		const task = await donePrepTask(ctx.caller, { id: idParam(ctx), body })
		return stationJson(prepTaskSchema.parse(task))
	}),
)

// ── Deliveries ──────────────────────────────────────────────────────────────

posInventoryRoutes.post(
	'/deliveries',
	stationRoute(
		{
			body: stationDeliverySchema,
			locations: (body) => [body.locationId],
			receive: true,
		},
		async (ctx, body) => {
			const { resolve } = await actorsFor(ctx, [
				{ clientId: body.clientId, madeBy: body.madeBy },
			])
			const { madeBy, madeAt, ...received } = body
			const lateSync =
				madeAt !== undefined && isLateSync(madeAt, posInventoryDeps.now())
			let duplicate = false
			const result = await recordDelivery(
				{ ...ctx.caller, actor: resolve(madeBy) },
				{
					body: { ...received, quantityOnly: true, paid: false },
					idempotency: idempotency(ctx, 'delivery', body.clientId, body),
					options: {
						source: 'station',
						lenientOrder: true,
						lateSync,
						madeAt,
						onReplay: () => {
							duplicate = true
						},
					},
				},
			)
			return stationJson(
				stationDeliveryResultSchema.parse({
					id: result.delivery.id,
					lineCount: result.delivery.lineCount,
					receivedAt: result.delivery.receivedAt ?? posInventoryDeps.now(),
					pricesPending: true,
					lateSync: result.delivery.lateSync === true,
					duplicate,
					order: result.order
						? { id: result.order.id, status: result.order.status }
						: null,
					orderLinkIgnored: result.orderLinkIgnored ?? null,
				}),
			)
		},
	),
)

/** A delivery this terminal's location recorded from a tablet; anything else is a 404. */
async function assertStationDelivery(ctx: StationCtx, id: string) {
	const row = await loadAllowedDelivery(ctx.pos.db, id, ctx.caller)
	if (row.source !== 'station') throw notFound()
	return row
}

posInventoryRoutes.post(
	'/deliveries/:id/photo',
	stationRoute(
		{ body: stationPhotoRequestSchema, receive: true },
		async (ctx, body) => {
			const id = idParam(ctx)
			await assertStationDelivery(ctx, id)
			const upload = await requestInvoicePhotoUpload(ctx.pos.db, {
				id,
				body,
				caller: ctx.caller,
			})
			return stationJson(stationPhotoUploadSchema.parse(upload))
		},
	),
)

posInventoryRoutes.post(
	'/deliveries/:id/photo/confirm',
	stationRoute(
		{ body: confirmInvoicePhotoSchema, receive: true },
		async (ctx, body) => {
			const id = idParam(ctx)
			await assertStationDelivery(ctx, id)
			try {
				await confirmInvoicePhoto(ctx.caller, { id, key: body.key })
			} catch (error) {
				// The object store could not be asked: the tablet tries again.
				if (
					error instanceof InventoryError &&
					error.code === 'inventory_unavailable'
				) {
					return stationError('service_unavailable')
				}
				throw error
			}
			return stationJson(stationPhotoConfirmResultSchema.parse({ ok: true }))
		},
	),
)
