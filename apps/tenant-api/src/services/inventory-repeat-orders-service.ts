import { createHash, randomUUID } from 'node:crypto'
import {
	createRepeatOrderSchema,
	DEFAULT_UPCOMING_RUNS_COUNT,
	findDueRepeatDeliveryDate,
	formatHolidaySkipNote,
	inventoryNotifyDedupeKey,
	type InventoryNotifyEvent,
	milliToPacks,
	type RepeatOrderCadenceWeeks,
	type RepeatOrderEffectiveStatus,
	repeatOrderCutoffFor,
	type RepeatOrderRunView,
	type RepeatOrderSummary,
	type SkipRepeatOrderRunInput,
	type UpdateRepeatOrderInput,
	upcomingRepeatDeliveryDates,
	type CreateRepeatOrderInput,
} from '@repo/inventory'
import {
	invItems,
	invOrderLines,
	invOrders,
	invRepeatOrderRuns,
	invRepeatOrders,
	type InvRepeatOrderFixedLine,
	invSupplierProducts,
	invSuppliers,
	type TenantDatabase,
} from '@repo/tenant-db'
import { and, asc, desc, eq, inArray, ne } from 'drizzle-orm'
import { type InventoryNotifyOutcome } from '../lib/inventory-notify.ts'
import { InventoryError } from '../lib/inventory-http.ts'
import { type inventoryCaller } from '../lib/inventory-route.ts'

type InventoryCaller = ReturnType<typeof inventoryCaller>
import {
	hashInventoryRequest,
	type InventoryIdempotency,
	type InventoryReader,
	withInventoryWrite,
} from '../lib/inventory-write.ts'
import { recordInventoryAudit } from './inventory-audit.ts'
import {
	assertLocationAllowed,
	assertVersion,
	badRequest,
	locationClock,
	notFound,
} from './inventory-common.ts'
import { getLocationClosedSpecialDates } from './inventory-location-settings.ts'
import {
	buildSuggestedOrders,
	createOrder,
	supplierSchedule,
} from './inventory-orders-service.ts'

const ALERT_GIVE_UP_MS = 3 * 24 * 60 * 60 * 1000
const ALERT_MAX_ATTEMPTS = 40
const ALERT_BATCH = 50

type RepeatOrderRow = typeof invRepeatOrders.$inferSelect
type RepeatOrderRunRow = typeof invRepeatOrderRuns.$inferSelect
type SupplierRow = typeof invSuppliers.$inferSelect

function repeatDraftEventId(orgId: string, locationId: string, runId: string) {
	return createHash('sha256')
		.update(
			inventoryNotifyDedupeKey({
				orgId,
				kind: 'inventory_repeat_order_draft',
				locationId,
				key: runId,
			}),
		)
		.digest('hex')
}

function computeEffectiveStatus(
	row: RepeatOrderRow,
	supplier: SupplierRow,
): RepeatOrderEffectiveStatus {
	if (row.status === 'cancelled') return 'cancelled'
	if (supplier.pausedAt !== null || supplier.archivedAt !== null) {
		return 'paused_supplier'
	}
	return row.status
}

function buildSummary(input: {
	row: RepeatOrderRow
	supplier: SupplierRow
	runs: readonly RepeatOrderRunRow[]
	closedDates: Map<string, string | null>
	todayDate: string
	runsCount: number
}): RepeatOrderSummary {
	const { row, supplier, runs, closedDates, todayDate, runsCount } = input
	const schedule = supplierSchedule(supplier)
	const runByDate = new Map(runs.map((run) => [run.deliveryDate, run]))
	const dates =
		row.status === 'cancelled'
			? []
			: upcomingRepeatDeliveryDates({
					fromDate: todayDate,
					cadenceWeeks: row.cadenceWeeks as RepeatOrderCadenceWeeks,
					weekdays: row.weekdays,
					anchorDate: row.anchorDate,
					count: runsCount,
				})
	const upcomingRuns: RepeatOrderRunView[] = dates.map((deliveryDate) => {
		const existing = runByDate.get(deliveryDate)
		if (existing) {
			return {
				deliveryDate,
				cutoffDate: existing.cutoffDate,
				cutoffTime: existing.cutoffTime,
				status: existing.status,
				orderId: existing.orderId,
				note: existing.note,
			}
		}
		const cutoff = repeatOrderCutoffFor(deliveryDate, schedule)
		if (closedDates.has(deliveryDate)) {
			return {
				deliveryDate,
				cutoffDate: cutoff.date,
				cutoffTime: cutoff.time,
				status: 'skipped_holiday',
				orderId: null,
				note: formatHolidaySkipNote(closedDates.get(deliveryDate) ?? null),
			}
		}
		return {
			deliveryDate,
			cutoffDate: cutoff.date,
			cutoffTime: cutoff.time,
			status: 'scheduled',
			orderId: null,
			note: null,
		}
	})

	return {
		id: row.id,
		locationId: row.locationId,
		supplierId: row.supplierId,
		supplierName: supplier.name,
		supplierPaused: supplier.pausedAt !== null,
		supplierArchived: supplier.archivedAt !== null,
		sourceOrderId: row.sourceOrderId,
		cadenceWeeks: row.cadenceWeeks as RepeatOrderCadenceWeeks,
		weekdays: row.weekdays,
		mode: row.mode,
		anchorDate: row.anchorDate,
		linesCount: row.linesJson.length,
		note: row.note,
		status: row.status,
		effectiveStatus: computeEffectiveStatus(row, supplier),
		version: row.version,
		upcomingRuns,
	}
}

async function loadRepeatSummary(
	db: InventoryReader,
	id: string,
	now: number,
	runsCount = DEFAULT_UPCOMING_RUNS_COUNT,
): Promise<RepeatOrderSummary> {
	const row = await db
		.select()
		.from(invRepeatOrders)
		.where(eq(invRepeatOrders.id, id))
		.get()
	if (!row) throw notFound()
	const [supplier, runs, closedDates, clock] = await Promise.all([
		db
			.select()
			.from(invSuppliers)
			.where(eq(invSuppliers.id, row.supplierId))
			.get(),
		db
			.select()
			.from(invRepeatOrderRuns)
			.where(eq(invRepeatOrderRuns.repeatOrderId, row.id)),
		getLocationClosedSpecialDates(db, row.locationId),
		locationClock(db, row.locationId, now),
	])
	if (!supplier) throw notFound()
	return buildSummary({
		row,
		supplier,
		runs,
		closedDates,
		todayDate: clock.date,
		runsCount,
	})
}

export async function listRepeatOrders(
	db: InventoryReader,
	input: {
		locationId: string
		includeCancelled?: boolean
		runs?: number
		now: number
	},
): Promise<{ repeatOrders: RepeatOrderSummary[] }> {
	const runsCount = input.runs ?? DEFAULT_UPCOMING_RUNS_COUNT
	const rows = await db
		.select()
		.from(invRepeatOrders)
		.where(
			input.includeCancelled
				? eq(invRepeatOrders.locationId, input.locationId)
				: and(
						eq(invRepeatOrders.locationId, input.locationId),
						ne(invRepeatOrders.status, 'cancelled'),
					),
		)
		.orderBy(desc(invRepeatOrders.createdAt), asc(invRepeatOrders.id))
	if (rows.length === 0) return { repeatOrders: [] }

	const supplierIds = [...new Set(rows.map((r) => r.supplierId))]
	const repeatIds = rows.map((r) => r.id)
	const [suppliers, runs, closedDates, clock] = await Promise.all([
		db.select().from(invSuppliers).where(inArray(invSuppliers.id, supplierIds)),
		db
			.select()
			.from(invRepeatOrderRuns)
			.where(inArray(invRepeatOrderRuns.repeatOrderId, repeatIds)),
		getLocationClosedSpecialDates(db, input.locationId),
		locationClock(db, input.locationId, input.now),
	])
	const supplierById = new Map(suppliers.map((s) => [s.id, s]))
	const runsByRepeat = new Map<string, RepeatOrderRunRow[]>()
	for (const run of runs) {
		const list = runsByRepeat.get(run.repeatOrderId)
		if (list) list.push(run)
		else runsByRepeat.set(run.repeatOrderId, [run])
	}
	const repeatOrders: RepeatOrderSummary[] = []
	for (const row of rows) {
		const supplier = supplierById.get(row.supplierId)
		if (!supplier) continue
		repeatOrders.push(
			buildSummary({
				row,
				supplier,
				runs: runsByRepeat.get(row.id) ?? [],
				closedDates,
				todayDate: clock.date,
				runsCount,
			}),
		)
	}
	return { repeatOrders }
}

export async function createRepeatOrder(
	caller: InventoryCaller,
	input: { body: CreateRepeatOrderInput; idempotency: InventoryIdempotency },
): Promise<RepeatOrderSummary> {
	const body = createRepeatOrderSchema.parse(input.body)
	assertLocationAllowed(caller.locationIds, body.locationId)
	return withInventoryWrite(
		{ orgId: caller.orgId, idempotency: input.idempotency },
		async (tx, ctx) => {
			const supplier = await tx
				.select()
				.from(invSuppliers)
				.where(eq(invSuppliers.id, body.supplierId))
				.get()
			if (!supplier || supplier.archivedAt !== null) throw notFound()

			let lines: InvRepeatOrderFixedLine[] = (body.lines ?? []).map((line) => ({
				itemId: line.itemId,
				supplierProductId: line.supplierProductId ?? null,
				packs: line.packs,
			}))

			if (body.sourceOrderId) {
				const sourceOrder = await tx
					.select()
					.from(invOrders)
					.where(eq(invOrders.id, body.sourceOrderId))
					.get()
				if (
					!sourceOrder ||
					sourceOrder.locationId !== body.locationId ||
					sourceOrder.supplierId !== body.supplierId
				) {
					throw notFound()
				}
				if (lines.length === 0 && body.mode === 'fixed_lines') {
					const sourceLines = await tx
						.select()
						.from(invOrderLines)
						.where(eq(invOrderLines.orderId, sourceOrder.id))
						.orderBy(asc(invOrderLines.id))
					lines = sourceLines.map((line) => ({
						itemId: line.itemId,
						supplierProductId: line.supplierProductId,
						packs: milliToPacks(line.packs),
					}))
				}
			}

			if (body.mode === 'fixed_lines' && lines.length === 0) {
				throw badRequest('lines')
			}

			const weekdays = [...new Set(body.weekdays)].sort((a, b) => a - b)
			const clock = await locationClock(tx, body.locationId, ctx.now)
			const anchorDate = body.anchorDate ?? clock.date
			const id = randomUUID()

			await tx.insert(invRepeatOrders).values({
				id,
				clientId: body.clientId,
				locationId: body.locationId,
				supplierId: supplier.id,
				sourceOrderId: body.sourceOrderId ?? null,
				cadenceWeeks: body.cadenceWeeks,
				weekdays,
				mode: body.mode,
				anchorDate,
				linesJson: lines,
				note: body.note?.trim() ? body.note.trim() : null,
				status: 'active',
				createdByKind: caller.actor.kind,
				createdById: caller.actor.id,
				createdAt: ctx.now,
				updatedAt: ctx.now,
			})

			await recordInventoryAudit(tx, {
				actorKind: caller.actor.kind,
				actorId: caller.actor.id,
				action: 'repeat_order.create',
				resourceType: 'repeat_order',
				resourceId: id,
				locationId: body.locationId,
				detail: {
					supplierId: supplier.id,
					cadenceWeeks: body.cadenceWeeks,
					mode: body.mode,
				},
				at: ctx.now,
			})
			return loadRepeatSummary(tx, id, ctx.now)
		},
	)
}

export async function updateRepeatOrder(
	caller: InventoryCaller,
	input: { id: string; body: UpdateRepeatOrderInput },
): Promise<RepeatOrderSummary> {
	return withInventoryWrite({ orgId: caller.orgId }, async (tx, ctx) => {
		const row = await tx
			.select()
			.from(invRepeatOrders)
			.where(eq(invRepeatOrders.id, input.id))
			.get()
		if (!row) throw notFound()
		assertLocationAllowed(caller.locationIds, row.locationId)
		assertVersion(row.version, input.body.expectedVersion)

		const updates: Partial<typeof invRepeatOrders.$inferInsert> = {
			version: row.version + 1,
			updatedAt: ctx.now,
		}
		if (input.body.status !== undefined) updates.status = input.body.status
		if (input.body.cadenceWeeks !== undefined) {
			updates.cadenceWeeks = input.body.cadenceWeeks
		}
		if (input.body.weekdays !== undefined) {
			updates.weekdays = [...new Set(input.body.weekdays)].sort((a, b) => a - b)
		}
		if (input.body.mode !== undefined) updates.mode = input.body.mode
		if (input.body.note !== undefined) {
			updates.note = input.body.note?.trim() ? input.body.note.trim() : null
		}

		await tx
			.update(invRepeatOrders)
			.set(updates)
			.where(eq(invRepeatOrders.id, row.id))

		await recordInventoryAudit(tx, {
			actorKind: caller.actor.kind,
			actorId: caller.actor.id,
			action: 'repeat_order.update',
			resourceType: 'repeat_order',
			resourceId: row.id,
			locationId: row.locationId,
			detail: { status: updates.status ?? row.status },
			at: ctx.now,
		})
		return loadRepeatSummary(tx, row.id, ctx.now)
	})
}

export async function skipRepeatOrderRun(
	caller: InventoryCaller,
	input: { id: string; body: SkipRepeatOrderRunInput },
): Promise<RepeatOrderSummary> {
	return withInventoryWrite({ orgId: caller.orgId }, async (tx, ctx) => {
		const row = await tx
			.select()
			.from(invRepeatOrders)
			.where(eq(invRepeatOrders.id, input.id))
			.get()
		if (!row) throw notFound()
		assertLocationAllowed(caller.locationIds, row.locationId)
		const supplier = await tx
			.select()
			.from(invSuppliers)
			.where(eq(invSuppliers.id, row.supplierId))
			.get()
		if (!supplier) throw notFound()

		const existing = await tx
			.select()
			.from(invRepeatOrderRuns)
			.where(
				and(
					eq(invRepeatOrderRuns.repeatOrderId, row.id),
					eq(invRepeatOrderRuns.deliveryDate, input.body.deliveryDate),
				),
			)
			.get()

		if (input.body.skipped) {
			if (existing?.status === 'drafted') {
				throw new InventoryError('invalid_request', 409, {
					reason: 'already_drafted',
				})
			}
			const cutoff = repeatOrderCutoffFor(
				input.body.deliveryDate,
				supplierSchedule(supplier),
			)
			const note = input.body.note?.trim() ? input.body.note.trim() : null
			if (existing) {
				await tx
					.update(invRepeatOrderRuns)
					.set({
						status: 'skipped',
						note,
						updatedAt: ctx.now,
					})
					.where(eq(invRepeatOrderRuns.id, existing.id))
			} else {
				await tx.insert(invRepeatOrderRuns).values({
					id: randomUUID(),
					repeatOrderId: row.id,
					deliveryDate: input.body.deliveryDate,
					cutoffDate: cutoff.date,
					cutoffTime: cutoff.time,
					status: 'skipped',
					orderId: null,
					note,
					alertStatus: 'sent',
					alertAttempts: 0,
					createdAt: ctx.now,
					updatedAt: ctx.now,
				})
			}
		} else if (existing && existing.status === 'skipped') {
			await tx
				.delete(invRepeatOrderRuns)
				.where(eq(invRepeatOrderRuns.id, existing.id))
		}

		await recordInventoryAudit(tx, {
			actorKind: caller.actor.kind,
			actorId: caller.actor.id,
			action: input.body.skipped
				? 'repeat_order.skip_run'
				: 'repeat_order.unskip_run',
			resourceType: 'repeat_order',
			resourceId: row.id,
			locationId: row.locationId,
			detail: { deliveryDate: input.body.deliveryDate },
			at: ctx.now,
		})
		return loadRepeatSummary(tx, row.id, ctx.now)
	})
}

// ── Tick execution: draft due repeat orders & deliver manager alerts ─────────

export type RepeatOrdersTickOutcome = {
	drafted: number
	skippedHoliday: number
	alertsSent: number
	alertsDeferred: number
	errors: number
}

export async function processDueRepeatOrders(
	db: TenantDatabase,
	input: {
		orgId: string
		region: InventoryCaller['region']
		now: number
		post: (event: InventoryNotifyEvent) => Promise<InventoryNotifyOutcome>
		deadline?: number
	},
): Promise<RepeatOrdersTickOutcome> {
	const { orgId, region, now, post } = input
	const deadline = input.deadline ?? Date.now() + 20_000
	const outcome: RepeatOrdersTickOutcome = {
		drafted: 0,
		skippedHoliday: 0,
		alertsSent: 0,
		alertsDeferred: 0,
		errors: 0,
	}

	const activeRows = await db
		.select({
			repeat: invRepeatOrders,
			supplier: invSuppliers,
		})
		.from(invRepeatOrders)
		.innerJoin(invSuppliers, eq(invSuppliers.id, invRepeatOrders.supplierId))
		.where(eq(invRepeatOrders.status, 'active'))

	const byLocation = new Map<
		string,
		Array<{ repeat: RepeatOrderRow; supplier: SupplierRow }>
	>()
	for (const entry of activeRows) {
		const list = byLocation.get(entry.repeat.locationId)
		if (list) list.push(entry)
		else byLocation.set(entry.repeat.locationId, [entry])
	}

	const systemCaller: InventoryCaller = {
		orgId,
		region,
		actor: { kind: 'system', id: null },
		locationIds: null,
		cost: false,
		purchasing: true,
	}

	for (const [locationId, entries] of byLocation) {
		let clock: Awaited<ReturnType<typeof locationClock>>
		let closedDates: Map<string, string | null>
		try {
			;[clock, closedDates] = await Promise.all([
				locationClock(db, locationId, now),
				getLocationClosedSpecialDates(db, locationId),
			])
		} catch {
			outcome.errors += 1
			continue
		}

		for (const { repeat, supplier } of entries) {
			try {
				if (supplier.pausedAt !== null || supplier.archivedAt !== null) {
					continue
				}
				const due = findDueRepeatDeliveryDate({
					now: clock.local,
					cadenceWeeks: repeat.cadenceWeeks as RepeatOrderCadenceWeeks,
					weekdays: repeat.weekdays,
					anchorDate: repeat.anchorDate,
					schedule: supplierSchedule(supplier),
				})
				if (!due) continue

				const existingRun = await db
					.select()
					.from(invRepeatOrderRuns)
					.where(
						and(
							eq(invRepeatOrderRuns.repeatOrderId, repeat.id),
							eq(invRepeatOrderRuns.deliveryDate, due.deliveryDate),
						),
					)
					.get()
				if (existingRun) continue

				if (closedDates.has(due.deliveryDate)) {
					await db
						.insert(invRepeatOrderRuns)
						.values({
							id: randomUUID(),
							repeatOrderId: repeat.id,
							deliveryDate: due.deliveryDate,
							cutoffDate: due.cutoff.date,
							cutoffTime: due.cutoff.time,
							status: 'skipped_holiday',
							orderId: null,
							note: formatHolidaySkipNote(
								closedDates.get(due.deliveryDate) ?? null,
							),
							alertStatus: 'sent',
							alertAttempts: 0,
							createdAt: now,
							updatedAt: now,
						})
						.onConflictDoNothing()
					outcome.skippedHoliday += 1
					continue
				}

				let draftLines: Array<{
					itemId: string
					supplierProductId: string
					packs: number
				}> = []
				const droppedArchivedNames: string[] = []

				if (repeat.mode === 'top_up') {
					const suggested = await buildSuggestedOrders(db, {
						locationId,
						cost: false,
						now,
					})
					const card = suggested.suppliers.find(
						(s) => s.supplierId === supplier.id,
					)
					draftLines = (card?.lines ?? []).map((line) => ({
						itemId: line.itemId,
						supplierProductId: line.supplierProductId,
						packs: line.packs,
					}))
					if (draftLines.length === 0) {
						continue
					}
				} else {
					const itemIds = [...new Set(repeat.linesJson.map((l) => l.itemId))]
					const [items, products] = await Promise.all([
						itemIds.length > 0
							? db.select().from(invItems).where(inArray(invItems.id, itemIds))
							: Promise.resolve([]),
						db
							.select()
							.from(invSupplierProducts)
							.where(eq(invSupplierProducts.supplierId, supplier.id)),
					])
					const itemById = new Map(items.map((item) => [item.id, item]))
					const activeProductsById = new Map(
						products.filter((p) => p.archivedAt === null).map((p) => [p.id, p]),
					)
					const activeProductByItem = new Map<
						string,
						(typeof products)[number]
					>()
					for (const p of products) {
						if (p.archivedAt !== null) continue
						const current = activeProductByItem.get(p.itemId)
						if (!current || (p.preferred && !current.preferred)) {
							activeProductByItem.set(p.itemId, p)
						}
					}
					for (const line of repeat.linesJson) {
						const item = itemById.get(line.itemId)
						if (!item || item.archivedAt !== null) {
							if (item) droppedArchivedNames.push(item.name)
							continue
						}
						const product =
							(line.supplierProductId
								? activeProductsById.get(line.supplierProductId)
								: undefined) ?? activeProductByItem.get(item.id)
						if (!product) {
							droppedArchivedNames.push(item.name)
							continue
						}
						draftLines.push({
							itemId: item.id,
							supplierProductId: product.id,
							packs: line.packs,
						})
					}
					if (draftLines.length === 0) {
						const note =
							droppedArchivedNames.length > 0
								? `Skipped: all items archived (${droppedArchivedNames.join(', ')})`
								: 'Skipped: no active items'
						await db
							.insert(invRepeatOrderRuns)
							.values({
								id: randomUUID(),
								repeatOrderId: repeat.id,
								deliveryDate: due.deliveryDate,
								cutoffDate: due.cutoff.date,
								cutoffTime: due.cutoff.time,
								status: 'skipped',
								orderId: null,
								note,
								alertStatus: 'sent',
								alertAttempts: 0,
								createdAt: now,
								updatedAt: now,
							})
							.onConflictDoNothing()
						continue
					}
				}

				const droppedNote =
					droppedArchivedNames.length > 0
						? `Dropped archived item(s): ${droppedArchivedNames.join(', ')}`
						: null
				const orderNote =
					[repeat.note, droppedNote].filter(Boolean).join(' · ') || undefined
				const clientKey = `repeat:${repeat.id}:${due.deliveryDate}`
				const orderBody = {
					clientId: clientKey,
					locationId,
					supplierId: supplier.id,
					expectedDate: due.deliveryDate,
					note: orderNote,
					fromSuggestion: false,
					lines: draftLines,
				}
				const created = await createOrder(systemCaller, {
					body: orderBody,
					idempotency: {
						key: clientKey,
						scope: 'repeat_order:draft',
						requestHash: hashInventoryRequest(orderBody),
					},
				})
				await db
					.update(invOrders)
					.set({ repeatOrderId: repeat.id })
					.where(eq(invOrders.id, created.id))

				await db
					.insert(invRepeatOrderRuns)
					.values({
						id: randomUUID(),
						repeatOrderId: repeat.id,
						deliveryDate: due.deliveryDate,
						cutoffDate: due.cutoff.date,
						cutoffTime: due.cutoff.time,
						status: 'drafted',
						orderId: created.id,
						note: droppedNote,
						alertStatus: 'pending',
						alertAttempts: 0,
						createdAt: now,
						updatedAt: now,
					})
					.onConflictDoNothing()
				outcome.drafted += 1
			} catch {
				outcome.errors += 1
			}
		}
	}

	// Deliver pending repeat-order draft alerts to App
	const pendingAlerts = await db
		.select({
			run: invRepeatOrderRuns,
			repeat: invRepeatOrders,
			orderNumber: invOrders.number,
		})
		.from(invRepeatOrderRuns)
		.innerJoin(
			invRepeatOrders,
			eq(invRepeatOrders.id, invRepeatOrderRuns.repeatOrderId),
		)
		.innerJoin(invOrders, eq(invOrders.id, invRepeatOrderRuns.orderId))
		.where(eq(invRepeatOrderRuns.alertStatus, 'pending'))
		.orderBy(asc(invRepeatOrderRuns.createdAt), asc(invRepeatOrderRuns.id))
		.limit(ALERT_BATCH)

	for (const entry of pendingAlerts) {
		const { run, repeat, orderNumber } = entry
		if (
			now - run.createdAt > ALERT_GIVE_UP_MS ||
			run.alertAttempts >= ALERT_MAX_ATTEMPTS
		) {
			await db
				.update(invRepeatOrderRuns)
				.set({ alertStatus: 'sent', updatedAt: now })
				.where(eq(invRepeatOrderRuns.id, run.id))
			outcome.errors += 1
			continue
		}
		if (Date.now() >= deadline) {
			outcome.alertsDeferred += 1
			continue
		}
		const notifyOutcome = await post({
			orgId,
			eventId: repeatDraftEventId(orgId, repeat.locationId, run.id),
			kind: 'inventory_repeat_order_draft',
			locationId: repeat.locationId,
			count: 1,
			repeatOrderDraft: {
				orderId: run.orderId!,
				orderNumber,
				repeatOrderId: repeat.id,
				expectedDate: run.deliveryDate,
			},
		})
		if (notifyOutcome.status === 'delivered') {
			await db
				.update(invRepeatOrderRuns)
				.set({
					alertStatus: 'sent',
					alertAttempts: run.alertAttempts + 1,
					updatedAt: now,
				})
				.where(eq(invRepeatOrderRuns.id, run.id))
			outcome.alertsSent += 1
		} else if (notifyOutcome.status === 'retry') {
			await db
				.update(invRepeatOrderRuns)
				.set({ alertAttempts: run.alertAttempts + 1, updatedAt: now })
				.where(eq(invRepeatOrderRuns.id, run.id))
			outcome.alertsDeferred += 1
		} else {
			await db
				.update(invRepeatOrderRuns)
				.set({
					alertStatus: 'sent',
					alertAttempts: run.alertAttempts + 1,
					updatedAt: now,
				})
				.where(eq(invRepeatOrderRuns.id, run.id))
			outcome.errors += 1
		}
	}

	return outcome
}
