import { Hono } from 'hono'
import {
	clampMadeAt,
	confirmInvoicePhotoSchema,
	doneTaskSchema,
	generatePrepSchema,
	prepQuerySchema,
	prepTaskActionSchema,
	prepPlanSchema,
	prepTaskSchema,
	stationLabelSchema,
	stationPrepDoneResultSchema,
	stationInvoiceInboxSchema,
	invoiceInboxUploadResultSchema,
	STATION_PHOTO_MAX_BYTES,
	stationVoiceParseSchema,
	stationVoiceProposeQuerySchema,
	VOICE_AUDIO_MAX_BYTES,
	voiceProposalSchema,
	inventoryIdSchema,
	labelResultSchema,
	stationCatalogQuerySchema,
	stationCashPurchaseResultSchema,
	stationCashPurchaseSchema,
	stationCountEntriesResultSchema,
	stationCountEntriesSchema,
	stationCountSheetSchema,
	stationCountSummarySchema,
	stationDeliveryResultSchema,
	stationDeliverySchema,
	stationDishWasteResultSchema,
	stationDishWasteSchema,
	stationLogDishWasteResultSchema,
	stationLogDishWasteSchema,
	stationOrderNotYetResultSchema,
	stationOrderNotYetSchema,
	stationPhotoConfirmResultSchema,
	stationPhotoRequestSchema,
	stationPhotoUploadSchema,
	stationReceiveAsOrderedResultSchema,
	stationReceiveAsOrderedSchema,
	stationSendCountSchema,
	stationStartCountResultSchema,
	stationStartCountSchema,
	stationTransferActionSchema,
	stationTransferRequestSchema,
	stationTransferResultSchema,
	stationUndoWasteResultSchema,
	stationWasteResultSchema,
	stationWasteSchema,
	STATION_WASTE_UNDO_SERVER_MS,
	undoWasteSchema,
} from '@repo/inventory'
import { invCounts, invItems } from '@repo/tenant-db'
import { and, eq, inArray } from 'drizzle-orm'
import { queryInChunks } from '../lib/chunked-in.ts'
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
	markCountDeviceDone,
	startOrJoinCount,
} from '../services/inventory-counts-service.ts'
import { addInvoiceFiles } from '../services/inventory-invoice-inbox-service.ts'
import { isSpeechReaderConfigured } from '../lib/speech-reader.ts'
import { printItemLabel } from '../services/inventory-labels-service.ts'
import {
	proposeFromAudio,
	proposeFromText,
} from '../services/inventory-voice-count-service.ts'
import {
	loadAllowedDelivery,
	recordDelivery,
} from '../services/inventory-purchasing-service.ts'
import {
	receiveOrderAsOrdered,
	rescheduleOrder,
} from '../services/inventory-orders-service.ts'
import {
	confirmInvoicePhoto,
	requestInvoicePhotoUpload,
} from '../services/inventory-receiving-service.ts'
import { getInventorySettings } from '../services/inventory-settings-service.ts'
import {
	logDishWaste,
	logWasteDish,
	undoWasteDish,
} from '../services/inventory-dish-waste-service.ts'
import {
	donePrepTask,
	generatePrep,
	getPrepPlan,
	skipPrepTask,
	startPrepTask,
} from '../services/inventory-prep-service.ts'
import {
	createTransfer,
	receiveTransfer,
	sendTransfer,
} from '../services/inventory-transfers-service.ts'
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
				transfersEnabled: flags.features.transfers,
				recipesEnabled: flags.features.recipes,
				useByEnabled: flags.features.useBy === true,
				voiceCountsEnabled:
					flags.features.voiceCounts === true && isSpeechReaderConfigured(),
				invoiceInboxEnabled: flags.features.invoiceInbox === true,
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
					kind: body.kind,
					idempotency: idempotency(ctx, 'count_start', body.clientId, body),
					syncedBy: ctx.session.staffId,
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
		const now = posInventoryDeps.now()
		const countRow = await ctx.pos.db
			.select({ createdAt: invCounts.createdAt })
			.from(invCounts)
			.where(eq(invCounts.id, id))
			.get()
		if (!countRow) throw notFound()
		const { actorFor } = await actorsFor(ctx, body.entries)
		const made = new Map(
			body.entries.map((entry) => {
				const clamped = clampMadeAt(entry.madeAt, now)
				return [
					entry.clientId,
					{
						...clamped,
						at: Math.max(clamped.at, countRow.createdAt),
					},
				]
			}),
		)
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
			{
				station: {
					actorFor,
					syncedBy: ctx.session.staffId,
					madeAt: (clientId) => made.get(clientId)?.at,
				},
				// This terminal and what it still holds unsent (#474); the id and
				// name come from the pairing, never from the body.
				device: {
					id: ctx.pos.device.id,
					name: ctx.pos.device.label,
					kind: 'station',
					unsent: body.unsent ?? null,
				},
			},
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
		// Contract 1 and 2 alike: a per-device "I'm done", never a state change.
		const summary = await markCountDeviceDone(
			{ ...ctx.caller, actor: resolve(body.madeBy) },
			{
				id,
				deviceId: ctx.pos.device.id,
				deviceName: ctx.pos.device.label,
				syncedBy: ctx.session.staffId,
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
			// `madeAt` is the device clock: bounded, never trusted far from now.
			const made = new Map(
				body.entries.map((entry) => [
					entry.clientId,
					clampMadeAt(entry.madeAt, now),
				]),
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
						madeAt: (clientId) => made.get(clientId)?.at,
						lateSync: (clientId) => made.get(clientId)?.late === true,
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

/** The general Log waste picker (#517): one dish with a reason, grouped ingredient rows. */
async function recipesGate(ctx: StationCtx): Promise<Response | null> {
	const flags = await getInventoryFlagState(ctx.pos.orgId)
	if (flags.status === 'on' && flags.features.recipes) return null
	return stationError(
		flags.status === 'on' || flags.status === 'off'
			? 'inventory_disabled'
			: 'inventory_unavailable',
	)
}

posInventoryRoutes.post(
	'/waste/dish',
	stationRoute(
		{
			body: stationLogDishWasteSchema,
			locations: (body) => [body.locationId],
		},
		async (ctx, body) => {
			const refused = await recipesGate(ctx)
			if (refused) return refused
			const now = posInventoryDeps.now()
			const { resolve } = await actorsFor(ctx, [
				{ clientId: body.clientId, madeBy: body.madeBy },
			])
			const { madeBy, madeAt: deviceMadeAt, ...entry } = body
			const made = clampMadeAt(deviceMadeAt, now)
			const result = await logWasteDish(ctx.caller, {
				body: entry,
				idempotency: idempotency(ctx, 'waste_dish', body.clientId, body),
				station: {
					deviceId: ctx.pos.device.id,
					madeAt: made.at,
					actor: resolve(madeBy),
					syncedBy: ctx.session.staffId,
				},
			})
			return stationJson(
				stationLogDishWasteResultSchema.parse({
					id: result.id,
					entries: result.entries,
					basis: result.basis,
					duplicate: result.duplicate,
				}),
			)
		},
	),
)

posInventoryRoutes.post(
	'/waste/dishes/:id/undo',
	stationRoute({ body: undoWasteSchema }, async (ctx, body) => {
		const refused = await recipesGate(ctx)
		if (refused) return refused
		const result = await undoWasteDish(
			ctx.caller,
			{ id: idParam(ctx), clientId: body.clientId },
			{
				station: {
					deviceId: ctx.pos.device.id,
					windowMs: STATION_WASTE_UNDO_SERVER_MS,
				},
			},
		)
		return stationJson(stationUndoWasteResultSchema.parse({ id: result.id }))
	}),
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
			return stationJson(
				prepPlanSchema.parse({
					...plan,
					// "Print labels" with Done (#523) only while use-by dates are on.
					...(ctx.caller.features?.useBy ? { labelsEnabled: true } : {}),
				}),
			)
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
		// "Print labels" with the batch (#523): best effort, never undoes the task.
		let label: Awaited<ReturnType<typeof printItemLabel>> | null = null
		if (body.labels && ctx.caller.features?.useBy) {
			label = await printItemLabel(ctx.pos.db, {
				caller: ctx.caller,
				locationId: ctx.locationId,
				itemId: task.itemId,
				kind: 'made',
				copies: body.labels.copies,
				quantityLabel: body.labels.quantityLabel,
				madeBy: ctx.session.staff.name,
				requestId: body.clientId,
				now: posInventoryDeps.now(),
			}).catch(() => null)
		}
		return stationJson(stationPrepDoneResultSchema.parse({ ...task, label }))
	}),
)

/**
 * The Labels screen of Station Kitchen (#523): a label for any made item (made
 * time) or stock item (opened time), through the one cloud print path.
 */
posInventoryRoutes.post(
	'/labels',
	stationRoute(
		{ body: stationLabelSchema, locations: (body) => [body.locationId] },
		async (ctx, body) => {
			const result = await printItemLabel(ctx.pos.db, {
				caller: ctx.caller,
				locationId: body.locationId,
				itemId: body.itemId,
				kind: body.kind,
				copies: body.copies,
				quantityLabel: body.quantityLabel,
				madeAt: body.madeAt,
				madeBy: ctx.session.staff.name,
				requestId: body.requestId,
				now: posInventoryDeps.now(),
			})
			return stationJson(labelResultSchema.parse(result))
		},
	),
)

// ── Invoice photos with no delivery (#503) ──────────────────────────────────

/**
 * A photo of a supplier invoice taken on the tablet, with no delivery: it goes
 * to the location's "Invoices to match" inbox, in this region's storage. One
 * press (`clientId`) makes one row. Needs the receive permission.
 */
posInventoryRoutes.post(
	'/invoice-inbox',
	stationRoute(
		{
			body: stationInvoiceInboxSchema,
			locations: (body) => [body.locationId],
			receive: true,
		},
		async (ctx, body) => {
			let bytes: Uint8Array
			try {
				bytes = Uint8Array.from(
					atob(body.contentBase64.replace(/\s+/g, '')),
					(ch) => ch.charCodeAt(0),
				)
			} catch {
				return stationError('invalid_request')
			}
			if (bytes.length > STATION_PHOTO_MAX_BYTES) {
				return stationError('payload_too_large')
			}
			const result = await addInvoiceFiles(ctx.caller, {
				locationId: body.locationId,
				source: 'station',
				clientId: body.clientId,
				files: [
					{
						fileName: body.fileName ?? null,
						contentType: body.contentType,
						bytes,
					},
				],
			})
			return stationJson(invoiceInboxUploadResultSchema.parse(result))
		},
	),
)

// ── Counting by voice (#488) ────────────────────────────────────────────────

/**
 * A recording becomes proposed lines for the terminal's own location. Nothing
 * is written and the audio is never stored; the lines are confirmed on the
 * tablet and go through the ordinary count entries route.
 */
posInventoryRoutes.post(
	'/voice/propose',
	stationRoute({ query: stationVoiceProposeQuerySchema }, async (ctx, query) => {
		const length = Number(ctx.c.req.header('content-length') ?? 0)
		if (length > VOICE_AUDIO_MAX_BYTES) return stationError('payload_too_large')
		const bytes = new Uint8Array(await ctx.c.req.arrayBuffer())
		const proposal = await proposeFromAudio(ctx.pos.db, {
			caller: ctx.caller,
			locationId: ctx.locationId,
			audio: {
				bytes,
				contentType: ctx.c.req.header('content-type') ?? 'application/octet-stream',
			},
			language: query.language,
			now: posInventoryDeps.now(),
		})
		return stationJson(voiceProposalSchema.parse(proposal))
	}),
)

posInventoryRoutes.post(
	'/voice/parse',
	stationRoute({ body: stationVoiceParseSchema }, async (ctx, body) =>
		stationJson(
			voiceProposalSchema.parse(
				await proposeFromText(ctx.pos.db, {
					caller: ctx.caller,
					locationId: ctx.locationId,
					transcript: body.transcript,
				}),
			),
		),
	),
)

// ── Transfers (#515) ────────────────────────────────────────────────────────

/** Transfers need `inventory.transfers` on top of the Stock gate. */
async function transfersGate(ctx: StationCtx): Promise<Response | null> {
	const flags = await getInventoryFlagState(ctx.pos.orgId)
	if (flags.status === 'on' && flags.features.transfers) return null
	return stationError(
		flags.status === 'on' || flags.status === 'off'
			? 'inventory_disabled'
			: 'inventory_unavailable',
	)
}

/** What a tablet is told about a transfer after an action: ids and counts, never a price. */
function transferResult(
	detail: Awaited<ReturnType<typeof sendTransfer>>,
	duplicate: boolean,
) {
	return stationTransferResultSchema.parse({
		id: detail.id,
		number: detail.number,
		status: detail.status,
		version: detail.version,
		missingLines: detail.missingLines,
		duplicate,
	})
}

for (const step of ['send', 'receive'] as const) {
	posInventoryRoutes.post(
		`/transfers/:id/${step}`,
		stationRoute(
			{
				body: stationTransferActionSchema,
				locations: (body) => [body.locationId],
				receive: true,
			},
			async (ctx, body) => {
				const refused = await transfersGate(ctx)
				if (refused) return refused
				const id = idParam(ctx)
				const { resolve } = await actorsFor(ctx, [
					{ clientId: body.clientId, madeBy: body.madeBy },
				])
				let duplicate = false
				const act = step === 'send' ? sendTransfer : receiveTransfer
				const detail = await act(
					{ ...ctx.caller, actor: resolve(body.madeBy) },
					{
						id,
						expectedVersion: body.expectedVersion,
						lines: body.lines,
						idempotency: idempotency(ctx, `transfer_${step}`, body.clientId, {
							id,
							...body,
						}),
						onReplay: () => {
							duplicate = true
						},
					},
				)
				return stationJson(transferResult(detail, duplicate))
			},
		),
	)
}

posInventoryRoutes.post(
	'/transfers',
	stationRoute(
		{
			body: stationTransferRequestSchema,
			locations: (body) => [body.locationId],
			receive: true,
		},
		async (ctx, body) => {
			const refused = await transfersGate(ctx)
			if (refused) return refused
			const { resolve } = await actorsFor(ctx, [
				{ clientId: body.clientId, madeBy: body.madeBy },
			])
			// This terminal's place asks `fromLocationId`: a request is made by the
			// place that needs stock (it is the receiver), items and amounts only.
			const detail = await createTransfer(
				{ ...ctx.caller, actor: resolve(body.madeBy) },
				{
					body: {
						clientId: body.clientId,
						kind: 'request',
						fromLocationId: body.fromLocationId,
						toLocationId: body.locationId,
						lines: body.lines,
						...(body.note ? { note: body.note } : {}),
					},
					idempotency: idempotency(
						ctx,
						'transfer_request',
						body.clientId,
						body,
					),
				},
			)
			return stationJson(transferResult(detail, false), 201)
		},
	),
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
			const { madeBy, madeAt: deviceMadeAt, ...received } = body
			const made = clampMadeAt(deviceMadeAt, posInventoryDeps.now())
			const madeAt = deviceMadeAt === undefined ? undefined : made.at
			const lateSync = made.late
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

/** Overdue order actions need `inventory.purchasing` on top of the Stock gate. */
async function purchasingGate(ctx: StationCtx): Promise<Response | null> {
	const flags = await getInventoryFlagState(ctx.pos.orgId)
	if (flags.status === 'on' && flags.features.purchasing) return null
	return stationError(
		flags.status === 'on' || flags.status === 'off'
			? 'inventory_disabled'
			: 'inventory_unavailable',
	)
}

posInventoryRoutes.post(
	'/orders/:id/receive-as-ordered',
	stationRoute(
		{
			body: stationReceiveAsOrderedSchema,
			locations: (body) => [body.locationId],
			receive: true,
		},
		async (ctx, body) => {
			const refused = await purchasingGate(ctx)
			if (refused) return refused
			const id = idParam(ctx)
			const { resolve } = await actorsFor(ctx, [
				{ clientId: body.clientId, madeBy: body.madeBy },
			])
			const made = clampMadeAt(body.madeAt, posInventoryDeps.now())
			const madeAt = body.madeAt === undefined ? undefined : made.at
			let duplicate = false
			const result = await receiveOrderAsOrdered(
				{ ...ctx.caller, actor: resolve(body.madeBy) },
				{
					orderId: id,
					expectedVersion: body.expectedVersion,
					clientId: body.clientId,
					idempotency: idempotency(
						ctx,
						'order_receive_as_ordered',
						body.clientId,
						{ id, ...body },
					),
					options: {
						source: 'station',
						lateSync: made.late,
						madeAt,
						onReplay: () => {
							duplicate = true
						},
					},
				},
			)
			return stationJson(
				stationReceiveAsOrderedResultSchema.parse({
					deliveryId: result.delivery.id,
					orderId: id,
					orderStatus: result.order?.status ?? 'received',
					lineCount: result.delivery.lineCount,
					receivedAt: result.delivery.receivedAt ?? posInventoryDeps.now(),
					duplicate,
				}),
			)
		},
	),
)

posInventoryRoutes.post(
	'/orders/:id/not-yet',
	stationRoute(
		{
			body: stationOrderNotYetSchema,
			locations: (body) => [body.locationId],
			receive: true,
		},
		async (ctx, body) => {
			const refused = await purchasingGate(ctx)
			if (refused) return refused
			const id = idParam(ctx)
			const { resolve } = await actorsFor(ctx, [
				{ clientId: id, madeBy: body.madeBy },
			])
			const updated = await rescheduleOrder(
				{ ...ctx.caller, actor: resolve(body.madeBy) },
				{
					id,
					expectedVersion: body.expectedVersion,
					expectedDate: body.expectedDate,
				},
			)
			return stationJson(
				stationOrderNotYetResultSchema.parse({
					orderId: updated.id,
					status: updated.status,
					expectedDate: updated.expectedDate!,
					version: updated.version,
				}),
			)
		},
	),
)

posInventoryRoutes.post(
	'/cash-purchase',
	stationRoute(
		{
			body: stationCashPurchaseSchema,
			locations: (body) => [body.locationId],
			receive: true,
		},
		async (ctx, body) => {
			const { resolve } = await actorsFor(ctx, [
				{ clientId: body.clientId, madeBy: body.madeBy },
			])
			const made = clampMadeAt(body.madeAt, posInventoryDeps.now())
			const madeAt = body.madeAt === undefined ? undefined : made.at
			let duplicate = false
			const result = await recordDelivery(
				{ ...ctx.caller, actor: resolve(body.madeBy) },
				{
					body: {
						clientId: body.clientId,
						locationId: body.locationId,
						supplierId: null,
						isCashPurchase: true,
						paid: true,
						lines: body.lines.map((line) => ({
							itemId: line.itemId ?? null,
							draftItem: line.draftItem,
							quantity: line.quantity,
							lineTotalMinor: line.amountPaidMinor,
						})),
					},
					idempotency: idempotency(ctx, 'cash_purchase', body.clientId, body),
					options: {
						source: 'station',
						lateSync: made.late,
						madeAt,
						onReplay: () => {
							duplicate = true
						},
					},
				},
			)
			const itemIds = [
				...new Set(result.delivery.lines.map((line) => line.itemId)),
			]
			const draftRows = await queryInChunks(itemIds, (chunk) =>
				ctx.pos.db
					.select({ id: invItems.id })
					.from(invItems)
					.where(and(inArray(invItems.id, chunk), eq(invItems.isDraft, true))),
			)
			return stationJson(
				stationCashPurchaseResultSchema.parse({
					id: result.delivery.id,
					lineCount: result.delivery.lineCount,
					receivedAt: result.delivery.receivedAt ?? posInventoryDeps.now(),
					lateSync: result.delivery.lateSync === true,
					duplicate,
					draftItemIds: draftRows.map((row) => row.id),
				}),
			)
		},
	),
)
