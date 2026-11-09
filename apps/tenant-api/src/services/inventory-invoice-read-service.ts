import { type InvoiceRead } from '@repo/inventory'
import {
	getTenantDb,
	invItems,
	invSupplierProducts,
	invSuppliers,
} from '@repo/tenant-db'
import { and, eq, isNull } from 'drizzle-orm'
import { fetchNoRedirect } from '../lib/fetch-no-redirect.ts'
import { errorLogFields } from '../lib/error-log.ts'
import { InventoryError } from '../lib/inventory-http.ts'
import {
	isInvoiceReaderConfigured,
	readInvoiceImage,
} from '../lib/invoice-reader.ts'
import { presignObjectRead } from '../lib/recording-storage.ts'
import { recordInventoryAudit } from './inventory-audit.ts'
import { type InventoryCaller } from './inventory-items-service.ts'
import { loadAllowedDelivery } from './inventory-purchasing-service.ts'
import { withInventoryWrite } from '../lib/inventory-write.ts'

/**
 * Reads the stored invoice photo of a delivery into suggested lines for the
 * "check these lines" step. Nothing is recorded or priced from the answer, and
 * it never reaches past this node's region (see `lib/invoice-reader.ts`). A
 * line is matched to an item only when its text equals (ignoring case and
 * spacing) the name of an item, or of a pack this delivery's supplier sells.
 */

const MAX_PHOTO_BYTES = 5 * 1024 * 1024

const normalize = (value: string) =>
	value
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, ' ')
		.trim()

const toMinor = (major: number | null): number | undefined =>
	major === null ? undefined : Math.round(major * 100)

export async function readDeliveryInvoice(
	caller: InventoryCaller,
	input: { id: string },
): Promise<InvoiceRead> {
	const db = await getTenantDb(caller.orgId)
	const delivery = await loadAllowedDelivery(db, input.id, caller)
	if (!delivery.photoKey || !delivery.photoContentType) {
		throw new InventoryError('no_photo', 409)
	}
	if (!isInvoiceReaderConfigured()) {
		throw new InventoryError('reader_not_configured', 503)
	}
	const link = presignObjectRead(delivery.photoKey, {
		contentType: delivery.photoContentType,
		expiresInSeconds: 60,
	})
	if (!link) throw new InventoryError('upload_not_configured', 503)

	let read: Awaited<ReturnType<typeof readInvoiceImage>>
	try {
		const photo = await fetchNoRedirect(link.url, {
			signal: AbortSignal.timeout(15_000),
		})
		if (!photo.ok) throw new Error('photo unavailable')
		const bytes = new Uint8Array(await photo.arrayBuffer())
		if (bytes.byteLength === 0 || bytes.byteLength > MAX_PHOTO_BYTES) {
			throw new Error('photo too large')
		}
		read = await readInvoiceImage({
			bytes,
			contentType: delivery.photoContentType,
		})
	} catch (error) {
		console.error('Inventory invoice reader failed', errorLogFields(error))
		throw new InventoryError('reader_failed', 502)
	}

	const [items, packs] = await Promise.all([
		db
			.select({ id: invItems.id, name: invItems.name })
			.from(invItems)
			.where(isNull(invItems.archivedAt)),
		delivery.supplierId
			? db
					.select({
						itemId: invSupplierProducts.itemId,
						packName: invSupplierProducts.packName,
					})
					.from(invSupplierProducts)
					.innerJoin(
						invSuppliers,
						eq(invSuppliers.id, invSupplierProducts.supplierId),
					)
					.where(
						and(
							eq(invSupplierProducts.supplierId, delivery.supplierId),
							isNull(invSupplierProducts.archivedAt),
						),
					)
			: Promise.resolve([] as { itemId: string; packName: string }[]),
	])
	const nameOf = new Map(items.map((item) => [item.id, item.name]))
	const byText = new Map<string, string>()
	// Names of the supplier's packs first, so they win over a plain item name.
	for (const pack of packs) byText.set(normalize(pack.packName), pack.itemId)
	for (const item of items) {
		if (!byText.has(normalize(item.name)))
			byText.set(normalize(item.name), item.id)
	}

	await withInventoryWrite(
		{ orgId: caller.orgId, skipAutoSoldOut: true },
		async (tx, ctx) => {
			await recordInventoryAudit(tx, {
				actorKind: caller.actor.kind,
				actorId: caller.actor.id,
				action: 'invoice.read',
				resourceType: 'delivery',
				resourceId: delivery.id,
				locationId: delivery.locationId,
				detail: { lines: read.lines.length },
				at: ctx.now,
			})
		},
	)

	return {
		deliveryId: delivery.id,
		supplierName: read.supplierName,
		invoiceNumber: read.invoiceNumber,
		...(toMinor(read.total) !== undefined
			? { totalMinor: toMinor(read.total) }
			: {}),
		lines: read.lines.map((line) => {
			const itemId = byText.get(normalize(line.text)) ?? null
			return {
				text: line.text,
				quantity: line.quantity,
				unit: line.unit,
				...(toMinor(line.lineTotal) !== undefined
					? { lineTotalMinor: toMinor(line.lineTotal) }
					: {}),
				itemId,
				itemName: itemId ? (nameOf.get(itemId) ?? null) : null,
			}
		}),
	}
}
