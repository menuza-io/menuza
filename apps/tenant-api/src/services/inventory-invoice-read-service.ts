import { createHash } from 'node:crypto'
import {
	INVENTORY_MAX_MINOR,
	inventoryValueMinorClamped,
	PRICE_RISE_ALERT_BP,
	STANDARD_UNIT_SPECS,
	toBaseQuantity,
	type InventoryBaseUnit,
	type InvoiceLineWarning,
	type InvoiceRead,
	type InvoiceReadLine,
	type StandardUnit,
} from '@repo/inventory'
import {
	getTenantDb,
	invItemCosts,
	invItems,
	invSupplierProducts,
	invSuppliers,
	type TenantDatabase,
} from '@repo/tenant-db'
import { and, eq, isNull } from 'drizzle-orm'
import { errorLogFields } from '../lib/error-log.ts'
import { fetchNoRedirect } from '../lib/fetch-no-redirect.ts'
import { InventoryError } from '../lib/inventory-http.ts'
import { withInventoryWrite } from '../lib/inventory-write.ts'
import {
	isInvoiceReaderConfigured,
	readInvoiceDocument,
	type ReadInvoice,
} from '../lib/invoice-reader.ts'
import { presignObjectRead } from '../lib/recording-storage.ts'
import { recordInventoryAudit } from './inventory-audit.ts'
import { badRequest } from './inventory-common.ts'
import { type InventoryCaller } from './inventory-items-service.ts'
import {
	decodeBase64Bytes,
	normalizeItemText,
	parsePackSpec,
} from './inventory-price-list-service.ts'
import { loadAllowedDelivery } from './inventory-purchasing-service.ts'

/**
 * Reads a stored invoice photo or a newly selected invoice image/PDF into
 * suggested lines for the "check these lines" step. Nothing is recorded or
 * priced from the answer, and it never reaches past this node's region (see
 * `lib/invoice-reader.ts`).
 */

const MAX_PHOTO_BYTES = 5 * 1024 * 1024

const toMinor = (major: number | null | undefined): number | undefined => {
	if (major === null || major === undefined || !Number.isFinite(major)) {
		return undefined
	}
	const minor = Math.round(major * 100)
	// An absurd read (a stray digit run) is left out, never passed on.
	return minor >= 0 && minor <= INVENTORY_MAX_MINOR ? minor : undefined
}

const STANDARD_UNIT_ALIASES: Record<string, StandardUnit> = {
	g: 'g',
	gr: 'g',
	gm: 'g',
	gram: 'g',
	grams: 'g',
	kg: 'kg',
	kgs: 'kg',
	kilo: 'kg',
	kilogram: 'kg',
	kilograms: 'kg',
	ml: 'ml',
	l: 'l',
	lt: 'l',
	ltr: 'l',
	liter: 'l',
	liters: 'l',
	litre: 'l',
	litres: 'l',
	oz: 'oz',
	lb: 'lb',
	lbs: 'lb',
	fl_oz: 'fl_oz',
	qt: 'qt',
	gal: 'gal',
	pc: 'piece',
	pcs: 'piece',
	piece: 'piece',
	pieces: 'piece',
	ea: 'piece',
	each: 'piece',
}

/**
 * A read costs a paid vision model call (up to 45 s), so the answer for an
 * unchanged document is kept for an hour (a re-read, a second tab and a reload
 * cost nothing) and each organization may start only a few new reads an
 * hour. In-process memory: per node, per Durable Object.
 */
export const INVOICE_READ_CACHE_TTL_MS = 60 * 60 * 1000
export const INVOICE_READS_PER_HOUR = 10
const readCache = new Map<string, { at: number; read: ReadInvoice }>()
const readStarts = new Map<string, number[]>()

export function resetInvoiceReadLimits(): void {
	readCache.clear()
	readStarts.clear()
}

function takeReadSlot(orgId: string, now: number): boolean {
	const recent = (readStarts.get(orgId) ?? []).filter(
		(at) => now - at < INVOICE_READ_CACHE_TTL_MS,
	)
	if (recent.length >= INVOICE_READS_PER_HOUR) {
		readStarts.set(orgId, recent)
		return false
	}
	recent.push(now)
	readStarts.set(orgId, recent)
	return true
}

function assertRawInvoiceContentType(contentType: string): string {
	const ct = contentType.toLowerCase().split(';')[0]!.trim()
	if (ct === 'application/pdf' || ct.startsWith('image/')) return ct
	throw badRequest('unsupported_file_type')
}

async function buildInvoiceReadResult(
	db: TenantDatabase,
	input: {
		deliveryId: string
		supplierId: string | null
		cost: boolean
		read: ReadInvoice
	},
): Promise<InvoiceRead> {
	const { read } = input
	const [items, costs, packs] = await Promise.all([
		db
			.select({
				id: invItems.id,
				name: invItems.name,
				baseUnit: invItems.baseUnit,
			})
			.from(invItems)
			.where(isNull(invItems.archivedAt)),
		input.cost
			? db
					.select({
						itemId: invItemCosts.itemId,
						lastCostMicro: invItemCosts.lastCostMicro,
					})
					.from(invItemCosts)
			: Promise.resolve(
					[] as Array<{ itemId: string; lastCostMicro: number | null }>,
				),
		input.supplierId
			? db
					.select({
						id: invSupplierProducts.id,
						itemId: invSupplierProducts.itemId,
						packName: invSupplierProducts.packName,
						packBaseQuantity: invSupplierProducts.packBaseQuantity,
						priceMinor: invSupplierProducts.priceMinor,
					})
					.from(invSupplierProducts)
					.innerJoin(
						invSuppliers,
						eq(invSuppliers.id, invSupplierProducts.supplierId),
					)
					.where(
						and(
							eq(invSupplierProducts.supplierId, input.supplierId),
							isNull(invSupplierProducts.archivedAt),
						),
					)
			: Promise.resolve(
					[] as Array<{
						id: string
						itemId: string
						packName: string
						packBaseQuantity: number
						priceMinor: number | null
					}>,
				),
	])

	const itemById = new Map(items.map((item) => [item.id, item]))
	const itemByNorm = new Map<
		string,
		{ id: string; name: string; baseUnit: InventoryBaseUnit }
	>()
	for (const item of items) {
		const key = normalizeItemText(item.name)
		if (key && !itemByNorm.has(key)) itemByNorm.set(key, item)
	}
	const lastCostByItem = new Map(costs.map((c) => [c.itemId, c.lastCostMicro]))

	const packsByNorm = new Map<string, (typeof packs)[number]>()
	const packsByItemId = new Map<string, Array<(typeof packs)[number]>>()
	for (const pack of packs) {
		const norm = normalizeItemText(pack.packName)
		if (norm && !packsByNorm.has(norm)) packsByNorm.set(norm, pack)
		const list = packsByItemId.get(pack.itemId)
		if (list) list.push(pack)
		else packsByItemId.set(pack.itemId, [pack])
	}

	let linesSum = 0
	let hasAnyLineTotal = false

	const lines: InvoiceReadLine[] = read.lines.map((line) => {
		// Parse pack size only when explicitly present in packSizeText, unit with
		// numeric amount (e.g. "6kg"), or embedded in line.text (e.g. "Tomatoes 6 kg").
		const hasExplicitPack =
			Boolean(line.packSizeText) ||
			Boolean(line.unit && /\d/.test(line.unit)) ||
			/\d+(?:[.,]\d+)?\s*(?:kg|g|ml|l|oz|lb|gal|qt|pcs?|pieces?)\b/i.test(
				line.text,
			)
		const parsedPack = hasExplicitPack
			? parsePackSpec({
					packSizeText: line.packSizeText ?? undefined,
					unit: line.unit && /\d/.test(line.unit) ? line.unit : undefined,
					itemName: line.text,
				})
			: null
		const packSizeText =
			line.packSizeText ??
			(parsedPack?.recognizedUnit ? parsedPack.packName : null)
		const packBaseQuantity = parsedPack?.recognizedUnit
			? parsedPack.packBaseQuantity
			: null

		const lineNorm = normalizeItemText(line.text)
		const strippedNorm = parsedPack?.strippedItemName
			? normalizeItemText(parsedPack.strippedItemName)
			: null

		let matchedProduct =
			packsByNorm.get(lineNorm) ??
			(strippedNorm ? packsByNorm.get(strippedNorm) : undefined)
		let matchedItem = matchedProduct
			? itemById.get(matchedProduct.itemId)
			: (itemByNorm.get(lineNorm) ??
				(strippedNorm ? itemByNorm.get(strippedNorm) : undefined))

		if (!matchedProduct && matchedItem) {
			const candidates = packsByItemId.get(matchedItem.id) ?? []
			if (packBaseQuantity !== null) {
				matchedProduct =
					candidates.find((p) => p.packBaseQuantity === packBaseQuantity) ??
					candidates[0]
			} else {
				matchedProduct = candidates[0]
			}
		}

		const itemId = matchedItem?.id ?? null
		const itemName = matchedItem?.name ?? null
		const matchedSupplierProductId = matchedProduct?.id ?? null
		const expectedPackBaseQuantity = matchedProduct?.packBaseQuantity ?? null

		const warnings: InvoiceLineWarning[] = []
		if (!itemId) warnings.push('unmatched')
		if (
			expectedPackBaseQuantity !== null &&
			packBaseQuantity !== null &&
			packBaseQuantity !== expectedPackBaseQuantity
		) {
			warnings.push('pack_diff')
		}

		const out: InvoiceReadLine = {
			text: line.text,
			quantity: line.quantity,
			unit: line.unit,
			itemId,
			itemName,
		}
		if (packSizeText) out.packSizeText = packSizeText
		if (packBaseQuantity !== null) out.packBaseQuantity = packBaseQuantity
		if (matchedSupplierProductId) {
			out.matchedSupplierProductId = matchedSupplierProductId
		}
		if (expectedPackBaseQuantity !== null) {
			out.expectedPackBaseQuantity = expectedPackBaseQuantity
		}

		if (input.cost) {
			const lineTotalMinor = toMinor(line.lineTotal)
			const unitPriceMinor = toMinor(line.unitPrice)
			if (lineTotalMinor !== undefined) {
				out.lineTotalMinor = lineTotalMinor
				linesSum += lineTotalMinor
				hasAnyLineTotal = true
			}
			if (unitPriceMinor !== undefined) out.unitPriceMinor = unitPriceMinor

			let previousPriceMinor: number | undefined
			if (matchedProduct?.priceMinor != null) {
				previousPriceMinor = matchedProduct.priceMinor
			} else if (matchedItem) {
				const lastCostMicro = lastCostByItem.get(matchedItem.id) ?? null
				if (lastCostMicro !== null) {
					if (packBaseQuantity !== null) {
						previousPriceMinor = inventoryValueMinorClamped(
							packBaseQuantity,
							lastCostMicro,
						)
					} else if (line.unit) {
						const stdUnit =
							STANDARD_UNIT_ALIASES[line.unit.toLowerCase().trim()]
						if (
							stdUnit &&
							STANDARD_UNIT_SPECS[stdUnit].base === matchedItem.baseUnit
						) {
							const unitQty = toBaseQuantity(
								1,
								{ kind: 'standard', unit: stdUnit },
								matchedItem.baseUnit,
							)
							previousPriceMinor = inventoryValueMinorClamped(
								unitQty,
								lastCostMicro,
							)
						}
					}
				}
			}
			if (previousPriceMinor !== undefined) {
				out.previousPriceMinor = previousPriceMinor
			}

			if (
				line.quantity !== null &&
				line.quantity > 0 &&
				unitPriceMinor !== undefined &&
				lineTotalMinor !== undefined &&
				Math.abs(Math.round(line.quantity * unitPriceMinor) - lineTotalMinor) >
					1
			) {
				warnings.push('line_total_mismatch')
			}

			const effectiveUnitPrice =
				unitPriceMinor ??
				(lineTotalMinor !== undefined &&
				line.quantity !== null &&
				line.quantity > 0
					? Math.round(lineTotalMinor / line.quantity)
					: undefined)
			if (
				previousPriceMinor !== undefined &&
				previousPriceMinor > 0 &&
				effectiveUnitPrice !== undefined &&
				Math.abs(effectiveUnitPrice - previousPriceMinor) * 10_000 >
					previousPriceMinor * PRICE_RISE_ALERT_BP
			) {
				warnings.push('price_change_gt_5pct')
			}
		}

		if (warnings.length > 0) out.warnings = warnings
		return out
	})

	const totalMinor = input.cost ? toMinor(read.total) : undefined
	const result: InvoiceRead = {
		deliveryId: input.deliveryId,
		supplierName: read.supplierName,
		invoiceNumber: read.invoiceNumber,
		lines,
	}
	if (input.cost) {
		if (totalMinor !== undefined) result.totalMinor = totalMinor
		if (hasAnyLineTotal || totalMinor !== undefined) {
			result.linesSumMinor = linesSum
		}
		if (totalMinor !== undefined) {
			result.invoiceTotalMismatch = Math.abs(totalMinor - linesSum) > 1
		}
	}
	return result
}

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
	const now = Date.now()
	const cacheKey = `${caller.orgId}:${delivery.photoKey}`
	const cached = readCache.get(cacheKey)
	let read: ReadInvoice | undefined =
		cached && now - cached.at < INVOICE_READ_CACHE_TTL_MS
			? cached.read
			: undefined
	if (!read && !takeReadSlot(caller.orgId, now)) {
		throw new InventoryError('invalid_request', 429, {
			reason: 'reader_rate_limited',
		})
	}
	const link = presignObjectRead(delivery.photoKey, {
		contentType: delivery.photoContentType,
		expiresInSeconds: 60,
	})
	if (!link) throw new InventoryError('upload_not_configured', 503)

	if (!read) {
		try {
			const photo = await fetchNoRedirect(link.url, {
				signal: AbortSignal.timeout(15_000),
			})
			if (!photo.ok) throw new Error('photo unavailable')
			const bytes = new Uint8Array(await photo.arrayBuffer())
			if (bytes.byteLength === 0 || bytes.byteLength > MAX_PHOTO_BYTES) {
				throw new Error('photo too large')
			}
			read = await readInvoiceDocument({
				bytes,
				contentType: delivery.photoContentType,
			})
		} catch (error) {
			console.error('Inventory invoice reader failed', errorLogFields(error))
			throw new InventoryError('reader_failed', 502)
		}
		readCache.set(cacheKey, { at: now, read })
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

	return buildInvoiceReadResult(db, {
		deliveryId: delivery.id,
		supplierId: delivery.supplierId,
		cost: caller.cost,
		read,
	})
}

export async function readRawInvoice(
	caller: InventoryCaller,
	input: {
		supplierId?: string | null
		fileName: string
		contentType: string
		contentBase64: string
	},
): Promise<InvoiceRead> {
	const contentType = assertRawInvoiceContentType(input.contentType)
	const bytes = decodeBase64Bytes(input.contentBase64)
	if (!isInvoiceReaderConfigured()) {
		throw new InventoryError('reader_not_configured', 503)
	}

	const digest = createHash('sha256').update(bytes).digest('hex')
	const now = Date.now()
	const cacheKey = `${caller.orgId}:raw:${digest}`
	const cached = readCache.get(cacheKey)
	let read: ReadInvoice | undefined =
		cached && now - cached.at < INVOICE_READ_CACHE_TTL_MS
			? cached.read
			: undefined
	if (!read && !takeReadSlot(caller.orgId, now)) {
		throw new InventoryError('invalid_request', 429, {
			reason: 'reader_rate_limited',
		})
	}

	if (!read) {
		try {
			read = await readInvoiceDocument({
				bytes,
				contentType,
				fileName: input.fileName,
			})
		} catch (error) {
			console.error('Inventory invoice reader failed', errorLogFields(error))
			throw new InventoryError('reader_failed', 502)
		}
		readCache.set(cacheKey, { at: now, read })
	}

	const db = await getTenantDb(caller.orgId)
	await withInventoryWrite(
		{ orgId: caller.orgId, skipAutoSoldOut: true },
		async (tx, ctx) => {
			await recordInventoryAudit(tx, {
				actorKind: caller.actor.kind,
				actorId: caller.actor.id,
				action: 'invoice.read',
				resourceType: 'raw_invoice',
				resourceId: digest.slice(0, 32),
				detail: { lines: read.lines.length },
				at: ctx.now,
			})
		},
	)

	return buildInvoiceReadResult(db, {
		deliveryId: '',
		supplierId: input.supplierId ?? null,
		cost: caller.cost,
		read,
	})
}
