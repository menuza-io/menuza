import { randomUUID } from 'node:crypto'
import {
	costMicroFromPackPriceClamped,
	creditLines,
	creditTotalMinor,
	INVOICE_PHOTO_MAX_BYTES,
	PRICE_RISE_ALERT_BP,
	priceRiseAlert,
	type CreditMessage,
	type DeliveryDetail,
	type InventoryBaseUnit,
	type InvoicePhotoUpload,
	type PriceAlert,
	type PriceAlerts,
} from '@repo/inventory'
import {
	getTenantDb,
	invDeliveries,
	invDeliveryLines,
	invItems,
	invOrderLines,
	invOrders,
	invSuppliers,
} from '@repo/tenant-db'
import { and, eq, gte, inArray, sql } from 'drizzle-orm'
import { queryInChunks } from '../lib/chunked-in.ts'
import { InventoryError } from '../lib/inventory-http.ts'
import {
	type InventoryReader,
	withInventoryWrite,
} from '../lib/inventory-write.ts'
import {
	deleteRecordingObject,
	headStorageObject,
	organizationInvoicePrefix,
	presignObjectUpload,
} from '../lib/recording-storage.ts'
import { recordInventoryAudit } from './inventory-audit.ts'
import { badRequest, stateConflict } from './inventory-common.ts'
import {
	type CreditMessageRequest,
	type InvoicePhotoRequest,
	type PriceAlertsQuery,
} from './inventory-contract-types.ts'
import { type InventoryCaller } from './inventory-items-service.ts'
import {
	buildMailtoLink,
	buildWhatsAppLink,
	renderCreditText,
} from './inventory-order-text.ts'
import { getLocationCurrency } from './inventory-location-settings.ts'
import { receivedByOrderLine } from './inventory-orders-service.ts'
import {
	deliveryDetail,
	loadAllowedDelivery,
} from './inventory-purchasing-service.ts'
import { getInventorySettings } from './inventory-settings-service.ts'

// ── Credit ──────────────────────────────────────────────────────────────────

/**
 * Drafts the message asking a supplier for credit on the lines of a
 * delivery's order that are short or missing (the figures after this
 * delivery). A read: it changes nothing and can be repeated. The text never
 * contains money; the value of the short lines is in `totalMinor` for the
 * cost grant only.
 */
export async function getCreditMessage(
	db: InventoryReader,
	input: { id: string; body: CreditMessageRequest; caller: InventoryCaller },
): Promise<CreditMessage> {
	const { caller, body } = input
	const row = await loadAllowedDelivery(db, input.id, caller)
	if (row.status !== 'received') throw stateConflict('not_received')
	const locale = body.locale ?? 'en'
	const supplier = row.supplierId
		? await db
				.select()
				.from(invSuppliers)
				.where(eq(invSuppliers.id, row.supplierId))
				.get()
		: undefined
	const empty: CreditMessage = {
		locale,
		subject: null,
		text: null,
		waLink: null,
		mailto: null,
		deliveryId: row.id,
		orderId: row.orderId,
		supplierName: supplier?.name ?? null,
		lines: [],
	}
	if (!row.orderId) return empty
	const order = await db
		.select()
		.from(invOrders)
		.where(eq(invOrders.id, row.orderId))
		.get()
	if (!order) return empty
	const orderLines = await db
		.select()
		.from(invOrderLines)
		.where(eq(invOrderLines.orderId, order.id))
		.orderBy(invOrderLines.sortOrder, invOrderLines.id)
	const only = body.orderLineIds ? new Set(body.orderLineIds) : null
	const wanted = orderLines.filter((line) => !only || only.has(line.id))
	const received = await receivedByOrderLine(
		db,
		wanted.map((line) => line.id),
		{ upToCreatedAt: row.createdAt },
	)
	const items = await queryInChunks(
		[...new Set(wanted.map((line) => line.itemId))],
		(chunk) =>
			db
				.select({
					id: invItems.id,
					name: invItems.name,
					baseUnit: invItems.baseUnit,
				})
				.from(invItems)
				.where(inArray(invItems.id, chunk)),
	)
	const itemById = new Map(items.map((item) => [item.id, item]))
	const lineById = new Map(wanted.map((line) => [line.id, line]))
	const short = creditLines(
		wanted.map((line) => ({
			itemId: line.itemId,
			orderLineId: line.id,
			orderedQuantity: line.quantity,
			receivedQuantity: received.get(line.id) ?? 0,
			pricedByWeight: line.pricedByWeight,
			costMicro:
				caller.cost && line.priceMinor !== null
					? costMicroFromPackPriceClamped(
							line.priceMinor,
							line.packBaseQuantity,
						)
					: null,
		})),
	)
	if (short.length === 0) return empty
	const settings = await getInventorySettings(db, caller.region)
	const wire = short.map((credit) => {
		const orderLine = lineById.get(credit.orderLineId!)!
		const item = itemById.get(credit.itemId)
		const out: CreditMessage['lines'][number] = {
			orderLineId: credit.orderLineId,
			itemId: credit.itemId,
			itemName: item?.name ?? '',
			packName: orderLine.packName,
			orderedQuantity: credit.orderedQuantity,
			receivedQuantity: credit.receivedQuantity,
			shortQuantity: credit.shortQuantity,
			kind: credit.kind,
		}
		if (caller.cost && credit.valueMinor !== undefined) {
			out.valueMinor = credit.valueMinor
		}
		return out
	})
	const rendered = renderCreditText({
		locale,
		orderNumber: order.number,
		supplierName: supplier?.name ?? '',
		contactName: supplier?.contactName ?? null,
		deliveryDate: row.businessDate,
		note: body.note ?? null,
		unitSystem: settings.unitSystem,
		lines: short.map((credit, index) => ({
			itemName: wire[index]!.itemName,
			packName: wire[index]!.packName,
			orderedQuantity: credit.orderedQuantity,
			receivedQuantity: credit.receivedQuantity,
			shortQuantity: credit.shortQuantity,
			kind: credit.kind,
			baseUnit: (itemById.get(credit.itemId)?.baseUnit ??
				'piece') as InventoryBaseUnit,
		})),
	})
	const message: CreditMessage = {
		...empty,
		subject: rendered.subject,
		text: rendered.text,
		waLink: buildWhatsAppLink(supplier?.phone ?? null, rendered.text),
		mailto: buildMailtoLink(
			supplier?.email ?? null,
			rendered.subject,
			rendered.text,
		),
		lines: wire,
	}
	if (caller.cost) {
		message.totalMinor = creditTotalMinor(short)
		const currency = order.currency ?? supplier?.currency
		if (currency) message.currency = currency
	}
	return message
}

// ── Invoice photo ───────────────────────────────────────────────────────────

const PHOTO_EXTENSIONS = {
	'image/jpeg': 'jpg',
	'image/png': 'png',
	'image/webp': 'webp',
} as const
const PHOTO_TYPES = Object.fromEntries(
	Object.entries(PHOTO_EXTENSIONS).map(([type, ext]) => [ext, type]),
) as Record<string, keyof typeof PHOTO_EXTENSIONS>

/**
 * One upload target for the invoice photo of a delivery, in the region's own
 * object storage (`inventory-invoices/<orgId>/<deliveryId>/<random>.<ext>`,
 * chosen here). The browser then `PUT`s the bytes straight to it. A node with
 * no object storage answers 503 `upload_not_configured`.
 */
export async function requestInvoicePhotoUpload(
	db: InventoryReader,
	input: { id: string; body: InvoicePhotoRequest; caller: InventoryCaller },
): Promise<InvoicePhotoUpload> {
	const { caller, body } = input
	const row = await loadAllowedDelivery(db, input.id, caller)
	if (row.status !== 'received') throw stateConflict('not_received')
	const key = `${organizationInvoicePrefix(caller.orgId)}${row.id}/${randomUUID()}.${PHOTO_EXTENSIONS[body.contentType]}`
	const target = presignObjectUpload(key, {
		contentType: body.contentType,
		sizeBytes: body.sizeBytes,
	})
	if (!target) throw new InventoryError('upload_not_configured', 503)
	return {
		key,
		method: 'PUT',
		uploadUrl: target.url,
		headers: target.headers,
		expiresAt: target.expiresAt,
		maxBytes: INVOICE_PHOTO_MAX_BYTES,
	}
}

/** The parts of a photo key this region would have issued for `deliveryId`. */
function parsePhotoKey(
	key: string,
	orgId: string,
	deliveryId: string,
): { contentType: keyof typeof PHOTO_EXTENSIONS } | null {
	const prefix = `${organizationInvoicePrefix(orgId)}${deliveryId}/`
	if (!key.startsWith(prefix)) return null
	const match = /^[0-9a-f-]{36}\.(jpg|png|webp)$/.exec(key.slice(prefix.length))
	return match ? { contentType: PHOTO_TYPES[match[1]!]! } : null
}

/**
 * Confirms an uploaded invoice photo: the object must exist, be within the
 * size limit and have the type its key says (otherwise it is deleted and the
 * request is refused). One photo per delivery: a new one replaces, and
 * deletes, the old one. Answers the delivery with a read link.
 */
export async function confirmInvoicePhoto(
	caller: InventoryCaller,
	input: { id: string; key: string },
): Promise<DeliveryDetail> {
	// The delivery first (404, location), then the key: a record that is not
	// this organization's never learns anything about its keys.
	await loadAllowedDelivery(await getTenantDb(caller.orgId), input.id, caller)
	const parsed = parsePhotoKey(input.key, caller.orgId, input.id)
	if (!parsed) throw badRequest('key')
	const head = await headStorageObject(input.key)
	if (head.status === 'not_configured') {
		throw new InventoryError('upload_not_configured', 503)
	}
	if (head.status === 'failed') {
		throw new InventoryError('inventory_unavailable', 503)
	}
	if (head.status === 'missing') throw stateConflict('upload_missing')
	const type = head.contentType?.split(';')[0]?.trim().toLowerCase() ?? null
	if (
		head.sizeBytes < 1 ||
		head.sizeBytes > INVOICE_PHOTO_MAX_BYTES ||
		type !== parsed.contentType
	) {
		await deleteRecordingObject(input.key)
		throw badRequest('photo_invalid')
	}
	return withInventoryWrite({ orgId: caller.orgId }, async (tx, ctx) => {
		const row = await loadAllowedDelivery(tx, input.id, caller)
		if (row.status !== 'received') throw stateConflict('not_received')
		if (row.photoKey !== input.key) {
			await tx
				.update(invDeliveries)
				.set({
					photoKey: input.key,
					photoContentType: parsed.contentType,
					photoUploadedAt: ctx.now,
					version: row.version + 1,
					updatedAt: ctx.now,
				})
				.where(eq(invDeliveries.id, row.id))
			const previous = row.photoKey
			if (previous) {
				ctx.afterCommit(async () => {
					await deleteRecordingObject(previous)
				})
			}
			await recordInventoryAudit(tx, {
				actorKind: caller.actor.kind,
				actorId: caller.actor.id,
				action: 'delivery.photo',
				resourceType: 'delivery',
				resourceId: row.id,
				locationId: row.locationId,
				detail: { replaced: previous !== null },
				at: ctx.now,
			})
		}
		const next = await loadAllowedDelivery(tx, row.id, caller)
		return deliveryDetail(tx, next, caller.cost, { photo: true })
	})
}

// ── Price rises ─────────────────────────────────────────────────────────────

export type PriceRiseRow = {
	itemId: string
	itemName: string
	supplierId: string | null
	deliveryId: string
	currency: string
	/** When the latest price was set (a quantity-only delivery: when confirmed). */
	pricedAt: number
	deliveredAt: number
	previousCostMicro: number
	costMicro: number
	changeBp: number
	severity: 'rise' | 'big'
	/** Base thousandths on the latest line. */
	quantity: number
	packName: string | null
	previousPackPriceMinor: number | null
	packPriceMinor: number | null
}

type PricedLine = {
	itemId: string
	lineId: string
	quantity: number
	totalMinor: number
	priceMinor: number | null
	packName: string | null
	createdAt: number
	pricedAt: number
	/** Insert order of the line (rowid): breaks ties between lines made in the same millisecond. */
	seq: number
	deliveryId: string
	supplierId: string | null
	currency: string
	receivedAt: number | null
}

/** Newest first: when the price was set, then the line's own time, then which was written last. */
function newerFirst(a: PricedLine, b: PricedLine): number {
	return b.pricedAt - a.pricedAt || b.createdAt - a.createdAt || b.seq - a.seq
}

/**
 * Items whose latest priced delivery at a location rose by more than the
 * alert threshold against the priced delivery before it, among prices set
 * since `sinceMs`. Lines still waiting for a price (quantity-only) are not
 * priced yet and are ignored. Largest rise first.
 */
export async function findPriceRises(
	db: InventoryReader,
	input: { locationId: string; sinceMs: number },
): Promise<PriceRiseRow[]> {
	const select = {
		itemId: invDeliveryLines.itemId,
		lineId: invDeliveryLines.id,
		quantity: invDeliveryLines.quantity,
		totalMinor: invDeliveryLines.lineTotalMinor,
		priceMinor: invDeliveryLines.priceMinor,
		packName: invDeliveryLines.packName,
		createdAt: invDeliveryLines.createdAt,
		pricedAt: sql<number>`${invDeliveryLines.pricedAt}`,
		seq: sql<number>`"inv_delivery_lines".rowid`,
		deliveryId: invDeliveries.id,
		supplierId: invDeliveries.supplierId,
		currency: invDeliveries.currency,
		receivedAt: invDeliveries.receivedAt,
	}
	const recent: PricedLine[] = await db
		.select(select)
		.from(invDeliveryLines)
		.innerJoin(invDeliveries, eq(invDeliveries.id, invDeliveryLines.deliveryId))
		.where(
			and(
				eq(invDeliveries.locationId, input.locationId),
				eq(invDeliveries.status, 'received'),
				gte(invDeliveryLines.pricedAt, input.sinceMs),
			),
		)
	const latest = new Map<string, PricedLine>()
	for (const line of [...recent].sort(newerFirst)) {
		if (line.quantity > 0 && !latest.has(line.itemId)) {
			latest.set(line.itemId, line)
		}
	}
	if (latest.size === 0) return []
	const earlier: PricedLine[] = await queryInChunks(
		[...latest.keys()],
		(chunk) =>
			db
				.select(select)
				.from(invDeliveryLines)
				.innerJoin(
					invDeliveries,
					eq(invDeliveries.id, invDeliveryLines.deliveryId),
				)
				.where(
					and(
						eq(invDeliveries.locationId, input.locationId),
						eq(invDeliveries.status, 'received'),
						inArray(invDeliveryLines.itemId, chunk),
						sql`${invDeliveryLines.pricedAt} is not null`,
					),
				),
	)
	const names = new Map(
		(
			await queryInChunks([...latest.keys()], (chunk) =>
				db
					.select({ id: invItems.id, name: invItems.name })
					.from(invItems)
					.where(inArray(invItems.id, chunk)),
			)
		).map((item) => [item.id, item.name]),
	)
	const rises: PriceRiseRow[] = []
	for (const line of latest.values()) {
		const before = earlier
			.filter(
				(candidate) =>
					candidate.itemId === line.itemId &&
					candidate.deliveryId !== line.deliveryId &&
					candidate.quantity > 0 &&
					newerFirst(line, candidate) < 0,
			)
			.sort(newerFirst)[0]
		if (!before) continue
		const costMicro = costMicroFromPackPriceClamped(
			line.totalMinor,
			line.quantity,
		)
		const previousCostMicro = costMicroFromPackPriceClamped(
			before.totalMinor,
			before.quantity,
		)
		const rise = priceRiseAlert({ previousCostMicro, costMicro })
		if (!rise) continue
		rises.push({
			itemId: line.itemId,
			itemName: names.get(line.itemId) ?? '',
			supplierId: line.supplierId,
			deliveryId: line.deliveryId,
			currency: line.currency,
			pricedAt: line.pricedAt,
			deliveredAt: line.receivedAt ?? line.createdAt,
			previousCostMicro,
			costMicro,
			changeBp: rise.changeBp,
			severity: rise.severity,
			quantity: line.quantity,
			packName: line.packName,
			previousPackPriceMinor: before.priceMinor,
			packPriceMinor: line.priceMinor,
		})
	}
	return rises.sort(
		(a, b) => b.changeBp - a.changeBp || (a.itemId < b.itemId ? -1 : 1),
	)
}

const DAY_MS = 24 * 60 * 60 * 1000

/** `GET /price-alerts` (the whole answer is money: the route needs the cost grant). */
export async function getPriceAlerts(
	db: InventoryReader,
	input: { query: PriceAlertsQuery; now: number },
): Promise<PriceAlerts> {
	const { query } = input
	const rises = await findPriceRises(db, {
		locationId: query.locationId,
		sinceMs: input.now - query.days * DAY_MS,
	})
	const supplierIds = [
		...new Set(
			rises.map((rise) => rise.supplierId).filter((id): id is string => !!id),
		),
	]
	const suppliers = await queryInChunks(supplierIds, (chunk) =>
		db
			.select({ id: invSuppliers.id, name: invSuppliers.name })
			.from(invSuppliers)
			.where(inArray(invSuppliers.id, chunk)),
	)
	const supplierName = new Map(suppliers.map((row) => [row.id, row.name]))
	const alerts: PriceAlert[] = rises.map((rise) => ({
		itemId: rise.itemId,
		itemName: rise.itemName,
		supplierId: rise.supplierId,
		supplierName: rise.supplierId
			? (supplierName.get(rise.supplierId) ?? null)
			: null,
		deliveryId: rise.deliveryId,
		deliveredAt: rise.deliveredAt,
		previousCostMicro: rise.previousCostMicro,
		costMicro: rise.costMicro,
		changeBp: rise.changeBp,
		severity: rise.severity,
		packName: rise.packName,
		previousPackPriceMinor: rise.previousPackPriceMinor,
		packPriceMinor: rise.packPriceMinor,
		affectedDishes: null,
	}))
	return {
		locationId: query.locationId,
		days: query.days,
		thresholdBp: PRICE_RISE_ALERT_BP,
		// The location's currency, '' while none is known (there are no alerts then).
		currency:
			rises[0]?.currency ??
			(await getLocationCurrency(db, query.locationId)) ??
			'',
		alerts,
	}
}
