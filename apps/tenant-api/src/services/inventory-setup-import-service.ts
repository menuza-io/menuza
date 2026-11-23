import { createHash } from 'node:crypto'
import { parseDelimited } from '@repo/common/csv'
import { parseXlsxToRows } from '@repo/common/xlsx'
import {
	INVENTORY_LIMITS,
	type ApplySetupImportResult,
	type InventoryBaseUnit,
	type InventoryCategory,
	type SetupImportDetail,
	type SetupImportProposedLine,
	type SetupImportProposedSupplier,
} from '@repo/inventory'
import {
	getTenantDb,
	invItems,
	invSetupImportFiles,
	invSetupImports,
	invSupplierProductPrices,
	invSupplierProducts,
	invSuppliers,
	type TenantDatabase,
} from '@repo/tenant-db'
import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { runInBackground } from '../lib/background.ts'
import { InventoryError } from '../lib/inventory-http.ts'
import { withInventoryWrite } from '../lib/inventory-write.ts'
import {
	isInvoiceReaderConfigured,
	readInvoiceDocument,
} from '../lib/invoice-reader.ts'
import {
	getCachedVisionRead,
	setCachedVisionRead,
	takeVisionReadSlot,
	VISION_BATCH_READS_PER_HOUR,
} from '../lib/vision-read-limit.ts'
import { recordInventoryAudit } from './inventory-audit.ts'
import {
	badRequest,
	newId,
	notFound,
	stateConflict,
} from './inventory-common.ts'
import { type InventoryCaller } from './inventory-items-service.ts'
import {
	canonicalItemKey,
	decodeBase64Bytes,
	detectImportFileKind,
	getOrgDefaultCurrency,
	guessInventoryCategory,
	normalizeItemText,
	parsePackSpec,
	parseSpreadsheetRows,
	toMinorClamped,
} from './inventory-price-list-service.ts'

const cleanText = (value: string, max: number): string =>
	value
		// eslint-disable-next-line no-control-regex
		.replace(/[\u0000-\u001f\u007f]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, max)

type ExtractedLine = {
	rawName: string
	supplierName: string | null
	sku: string | null
	packSizeText: string | null
	unit: string | null
	priceMinor: number | null
	category: string | null
}

type StoredFileRead = {
	supplierName: string | null
	lines: ExtractedLine[]
}

const MAX_SETUP_IMPORT_BYTES = 18 * 1024 * 1024

const inFlightImports = new Map<string, Promise<void>>()

function supplierNameFromFileName(fileName: string): string {
	const stem = fileName.replace(/\.[^.]+$/, '')
	const cleaned = cleanText(stem.replace(/[_-]+/g, ' '), 80)
	return cleaned || 'Imported Supplier'
}

async function readSingleImportFile(
	orgId: string,
	file: {
		fileName: string
		contentType: string
		fileKind: 'image' | 'pdf' | 'csv' | 'xlsx'
		inlineContent: string
	},
): Promise<StoredFileRead> {
	const bytes = decodeBase64Bytes(file.inlineContent)
	if (file.fileKind === 'csv') {
		const text = new TextDecoder('utf-8').decode(bytes)
		const parsed = parseSpreadsheetRows(parseDelimited(text))
		return {
			supplierName: parsed.supplierName,
			lines: parsed.lines.map((line) => ({
				rawName: line.name,
				supplierName: line.supplierName,
				sku: line.sku,
				packSizeText: line.packSizeText,
				unit: line.unit,
				priceMinor: toMinorClamped(
					line.price ??
						(line.lineTotal !== null && line.quantity && line.quantity > 0
							? line.lineTotal / line.quantity
							: line.lineTotal),
				),
				category: line.category,
			})),
		}
	}
	if (file.fileKind === 'xlsx') {
		const parsed = parseSpreadsheetRows(await parseXlsxToRows(bytes))
		return {
			supplierName: parsed.supplierName,
			lines: parsed.lines.map((line) => ({
				rawName: line.name,
				supplierName: line.supplierName,
				sku: line.sku,
				packSizeText: line.packSizeText,
				unit: line.unit,
				priceMinor: toMinorClamped(
					line.price ??
						(line.lineTotal !== null && line.quantity && line.quantity > 0
							? line.lineTotal / line.quantity
							: line.lineTotal),
				),
				category: line.category,
			})),
		}
	}
	const digest = createHash('sha256').update(bytes).digest('hex')
	const cacheKey = `setup:${orgId}:${file.contentType}:${digest}`
	const now = Date.now()
	let read = getCachedVisionRead<
		Awaited<ReturnType<typeof readInvoiceDocument>>
	>(cacheKey, now)
	if (!read) {
		if (!takeVisionReadSlot(orgId, now, VISION_BATCH_READS_PER_HOUR)) {
			throw new InventoryError('invalid_request', 429, {
				reason: 'reader_rate_limited',
			})
		}
		read = await readInvoiceDocument({
			bytes,
			contentType: file.contentType,
			fileName: file.fileName,
		})
		setCachedVisionRead(cacheKey, read, now)
	}
	return {
		supplierName: read.supplierName,
		lines: read.lines.map((line) => {
			const derivedMajor =
				line.unitPrice ??
				(line.lineTotal !== null && line.quantity && line.quantity > 0
					? line.lineTotal / line.quantity
					: line.lineTotal)
			return {
				rawName: line.text,
				supplierName: read.supplierName,
				sku: null,
				packSizeText: line.packSizeText ?? null,
				unit: line.unit,
				priceMinor: toMinorClamped(derivedMajor),
				category: null,
			}
		}),
	}
}

type WorkingItem = {
	canonKey: string
	itemName: string
	category: InventoryCategory
	baseUnit: InventoryBaseUnit
	packName: string
	packBaseQuantity: number
	recognizedUnit: boolean
	priceMinor: number | null
	sku: string | null
	sourceFiles: string[]
	mergedAliases: string[]
}

type WorkingSupplier = {
	key: string
	name: string
	sourceFiles: string[]
	items: WorkingItem[]
}

async function buildGroupedSuppliersProposal(
	db: TenantDatabase,
	doneFiles: Array<{ fileName: string; read: StoredFileRead }>,
): Promise<SetupImportProposedSupplier[]> {
	const [existingSuppliers, existingItems, existingProducts] =
		await Promise.all([
			db.select().from(invSuppliers).where(isNull(invSuppliers.archivedAt)),
			db.select().from(invItems).where(isNull(invItems.archivedAt)),
			db
				.select()
				.from(invSupplierProducts)
				.where(isNull(invSupplierProducts.archivedAt)),
		])

	const supplierByNorm = new Map(
		existingSuppliers.map((s) => [normalizeItemText(s.name), s]),
	)
	const itemByNorm = new Map<string, (typeof existingItems)[number]>()
	const itemByCanon = new Map<string, (typeof existingItems)[number]>()
	for (const item of existingItems) {
		const norm = normalizeItemText(item.name)
		if (norm && !itemByNorm.has(norm)) itemByNorm.set(norm, item)
		const canon = canonicalItemKey(item.name)
		if (canon && !itemByCanon.has(canon)) itemByCanon.set(canon, item)
	}
	const productBySupplierItem = new Map<
		string,
		Array<(typeof existingProducts)[number]>
	>()
	for (const prod of existingProducts) {
		const key = `${prod.supplierId}:${prod.itemId}`
		const list = productBySupplierItem.get(key)
		if (list) list.push(prod)
		else productBySupplierItem.set(key, [prod])
	}

	const suppliersMap = new Map<string, WorkingSupplier>()

	for (const file of doneFiles) {
		const fileFallbackSupplier =
			file.read.supplierName || supplierNameFromFileName(file.fileName)
		for (const line of file.read.lines) {
			const supplierDisplay = cleanText(
				line.supplierName || fileFallbackSupplier,
				80,
			)
			if (!supplierDisplay) continue
			const supplierKey =
				normalizeItemText(supplierDisplay) || supplierDisplay.toLowerCase()
			let supGroup = suppliersMap.get(supplierKey)
			if (!supGroup) {
				supGroup = {
					key: supplierKey,
					name: supplierDisplay,
					sourceFiles: [],
					items: [],
				}
				suppliersMap.set(supplierKey, supGroup)
			}
			if (!supGroup.sourceFiles.includes(file.fileName)) {
				supGroup.sourceFiles.push(file.fileName)
			}

			const pack = parsePackSpec({
				packSizeText: line.packSizeText,
				unit: line.unit,
				itemName: line.rawName,
			})
			const displayItemName =
				cleanText(pack.strippedItemName ?? line.rawName, 80) ||
				cleanText(line.rawName, 80)
			const canonKey =
				canonicalItemKey(displayItemName) || normalizeItemText(displayItemName)
			if (!canonKey) continue

			let existingGroup = supGroup.items.find((entry) => {
				if (entry.canonKey !== canonKey) return false
				if (entry.packBaseQuantity === pack.packBaseQuantity) return true
				if (!entry.recognizedUnit || !pack.recognizedUnit) return true
				return false
			})

			if (!existingGroup) {
				existingGroup = {
					canonKey,
					itemName: displayItemName,
					category: guessInventoryCategory(line.category, displayItemName),
					baseUnit: pack.baseUnit,
					packName: pack.packName,
					packBaseQuantity: pack.packBaseQuantity,
					recognizedUnit: pack.recognizedUnit,
					priceMinor: line.priceMinor,
					sku: line.sku,
					sourceFiles: [file.fileName],
					mergedAliases: [line.rawName],
				}
				supGroup.items.push(existingGroup)
			} else {
				if (!existingGroup.mergedAliases.includes(line.rawName)) {
					existingGroup.mergedAliases.push(line.rawName)
				}
				if (!existingGroup.sourceFiles.includes(file.fileName)) {
					existingGroup.sourceFiles.push(file.fileName)
				}
				if (!existingGroup.recognizedUnit && pack.recognizedUnit) {
					existingGroup.recognizedUnit = true
					existingGroup.baseUnit = pack.baseUnit
					existingGroup.packName = pack.packName
					existingGroup.packBaseQuantity = pack.packBaseQuantity
				}
				// Later files overwrite earlier prices so latest invoice price wins.
				if (line.priceMinor !== null) {
					existingGroup.priceMinor = line.priceMinor
				}
				if (line.sku && !existingGroup.sku) {
					existingGroup.sku = line.sku
				}
			}
		}
	}

	const proposals: SetupImportProposedSupplier[] = []
	let supIdx = 0
	for (const sup of suppliersMap.values()) {
		supIdx++
		const matchedSupplier = supplierByNorm.get(normalizeItemText(sup.name))
		const items: SetupImportProposedLine[] = sup.items.map((item, itemIdx) => {
			const matchedItem =
				itemByNorm.get(normalizeItemText(item.itemName)) ??
				itemByCanon.get(item.canonKey)
			let matchedProduct: (typeof existingProducts)[number] | undefined
			if (matchedSupplier && matchedItem) {
				const prods =
					productBySupplierItem.get(
						`${matchedSupplier.id}:${matchedItem.id}`,
					) ?? []
				matchedProduct =
					prods.find((p) => p.packBaseQuantity === item.packBaseQuantity) ??
					(prods.length === 1 ? prods[0] : undefined)
			}
			return {
				tempKey: `sup-${supIdx}-item-${itemIdx + 1}`,
				itemName: matchedItem ? matchedItem.name : item.itemName,
				category: matchedItem
					? (matchedItem.category as InventoryCategory)
					: item.category,
				baseUnit: matchedItem ? matchedItem.baseUnit : item.baseUnit,
				packName: item.packName,
				packBaseQuantity: item.packBaseQuantity,
				...(item.priceMinor !== null ? { priceMinor: item.priceMinor } : {}),
				sku: item.sku,
				existingItemId: matchedItem?.id ?? null,
				existingProductId: matchedProduct?.id ?? null,
				sourceFiles: item.sourceFiles,
				mergedAliases: item.mergedAliases,
			}
		})

		proposals.push({
			tempKey: `sup-${supIdx}`,
			name: matchedSupplier ? matchedSupplier.name : sup.name,
			existingSupplierId: matchedSupplier?.id ?? null,
			sourceFiles: sup.sourceFiles,
			items,
		})
	}

	return proposals
}

function toDetail(
	row: typeof invSetupImports.$inferSelect,
	files: Array<typeof invSetupImportFiles.$inferSelect>,
	currency: string,
	cost = true,
): SetupImportDetail {
	const proposal = row.proposalJson as
		{ suppliers?: SetupImportProposedSupplier[] } | null | undefined
	const rawSuppliers = Array.isArray(proposal?.suppliers)
		? proposal.suppliers
		: []
	const suppliers = rawSuppliers.map((sup) => ({
		...sup,
		items: sup.items.map(({ priceMinor, ...rest }) =>
			cost && priceMinor != null ? { ...rest, priceMinor } : rest,
		),
	}))
	return {
		id: row.id,
		status: row.status,
		totalFiles: row.totalFiles,
		completedFiles: row.completedFiles,
		failedFiles: row.failedFiles,
		currency,
		readerConfigured: isInvoiceReaderConfigured(),
		appliedAt: row.appliedAt,
		createdAt: row.createdAt,
		files: files.map((file) => ({
			id: file.id,
			fileName: file.fileName,
			fileKind: file.fileKind,
			status: file.status,
			errorCode: file.errorCode,
		})),
		suppliers,
	}
}

export async function processSetupImport(
	orgId: string,
	importId: string,
): Promise<void> {
	const key = `${orgId}:${importId}`
	const existingFlight = inFlightImports.get(key)
	if (existingFlight) return existingFlight

	const task = (async () => {
		const db = await getTenantDb(orgId)
		const importRow = await db
			.select()
			.from(invSetupImports)
			.where(eq(invSetupImports.id, importId))
			.get()
		if (!importRow || importRow.status === 'applied') return

		const files = await db
			.select()
			.from(invSetupImportFiles)
			.where(eq(invSetupImportFiles.importId, importId))
			.orderBy(invSetupImportFiles.createdAt, invSetupImportFiles.id)

		let completedFiles = files.filter((f) => f.status === 'done').length
		let failedFiles = files.filter((f) => f.status === 'failed').length

		for (const file of files) {
			if (file.status === 'done' || file.status === 'failed') continue
			const claimed = await db
				.update(invSetupImportFiles)
				.set({ status: 'reading', updatedAt: Date.now() })
				.where(
					and(
						eq(invSetupImportFiles.id, file.id),
						eq(invSetupImportFiles.status, 'pending'),
					),
				)
				.returning({ id: invSetupImportFiles.id })
			if (claimed.length === 0) continue

			if (!file.inlineContent) {
				failedFiles++
				await db
					.update(invSetupImportFiles)
					.set({
						status: 'failed',
						errorCode: 'missing_content',
						updatedAt: Date.now(),
					})
					.where(eq(invSetupImportFiles.id, file.id))
				await db
					.update(invSetupImports)
					.set({ failedFiles, updatedAt: Date.now() })
					.where(eq(invSetupImports.id, importId))
				continue
			}

			try {
				const read = await readSingleImportFile(orgId, {
					fileName: file.fileName,
					contentType: file.contentType,
					fileKind: file.fileKind,
					inlineContent: file.inlineContent,
				})
				completedFiles++
				await db
					.update(invSetupImportFiles)
					.set({
						status: 'done',
						errorCode: null,
						inlineContent: null,
						readJson: read as unknown as Record<string, unknown>,
						updatedAt: Date.now(),
					})
					.where(eq(invSetupImportFiles.id, file.id))
				await db
					.update(invSetupImports)
					.set({ completedFiles, updatedAt: Date.now() })
					.where(eq(invSetupImports.id, importId))
			} catch (error) {
				failedFiles++
				const errorCode =
					error instanceof InventoryError && error.status === 429
						? 'rate_limited'
						: 'read_failed'
				await db
					.update(invSetupImportFiles)
					.set({
						status: 'failed',
						errorCode,
						inlineContent: null,
						updatedAt: Date.now(),
					})
					.where(eq(invSetupImportFiles.id, file.id))
				await db
					.update(invSetupImports)
					.set({ failedFiles, updatedAt: Date.now() })
					.where(eq(invSetupImports.id, importId))
			}
		}

		const refreshedFiles = await db
			.select()
			.from(invSetupImportFiles)
			.where(eq(invSetupImportFiles.importId, importId))
			.orderBy(invSetupImportFiles.createdAt, invSetupImportFiles.id)

		const finalCompleted = refreshedFiles.filter(
			(f) => f.status === 'done',
		).length
		const finalFailed = refreshedFiles.filter(
			(f) => f.status === 'failed',
		).length

		const doneReads = refreshedFiles
			.filter((f) => f.status === 'done' && f.readJson)
			.map((f) => ({
				fileName: f.fileName,
				read: f.readJson as unknown as StoredFileRead,
			}))

		const suppliers = await buildGroupedSuppliersProposal(db, doneReads)
		const finalStatus =
			doneReads.length === 0 && finalFailed > 0 ? 'failed' : 'ready'

		await db
			.update(invSetupImports)
			.set({
				status: finalStatus,
				completedFiles: finalCompleted,
				failedFiles: finalFailed,
				proposalJson: { suppliers },
				updatedAt: Date.now(),
			})
			.where(eq(invSetupImports.id, importId))
	})().finally(() => {
		inFlightImports.delete(key)
	})

	inFlightImports.set(key, task)
	return task
}

export async function listSetupImports(
	orgId: string,
	cost = true,
): Promise<{
	imports: SetupImportDetail[]
	readerConfigured: boolean
}> {
	const db = await getTenantDb(orgId)
	const [rows, currency] = await Promise.all([
		db
			.select()
			.from(invSetupImports)
			.orderBy(desc(invSetupImports.createdAt), desc(invSetupImports.id))
			.limit(20),
		getOrgDefaultCurrency(db),
	])
	const importIds = rows.map((r) => r.id)
	const files =
		importIds.length > 0
			? await db
					.select()
					.from(invSetupImportFiles)
					// bounded: rows is limited to 20 setup imports above
					.where(inArray(invSetupImportFiles.importId, importIds))
					.orderBy(invSetupImportFiles.createdAt, invSetupImportFiles.id)
			: []
	const filesByImport = new Map<
		string,
		Array<typeof invSetupImportFiles.$inferSelect>
	>()
	for (const file of files) {
		const list = filesByImport.get(file.importId)
		if (list) list.push(file)
		else filesByImport.set(file.importId, [file])
	}

	return {
		imports: rows.map((row) =>
			toDetail(row, filesByImport.get(row.id) ?? [], currency, cost),
		),
		readerConfigured: isInvoiceReaderConfigured(),
	}
}

export async function startSetupImport(
	caller: InventoryCaller,
	body: {
		files: Array<{
			fileName: string
			contentType: string
			contentBase64: string
		}>
	},
): Promise<SetupImportDetail> {
	let totalBytes = 0
	const parsedFiles = body.files.map((file) => {
		const fileKind = detectImportFileKind(file.fileName, file.contentType)
		const bytes = decodeBase64Bytes(file.contentBase64)
		totalBytes += bytes.byteLength
		if (totalBytes > MAX_SETUP_IMPORT_BYTES) {
			throw badRequest('batch_too_large')
		}
		return { ...file, fileKind }
	})

	const needsReader = parsedFiles.some(
		(file) => file.fileKind === 'pdf' || file.fileKind === 'image',
	)
	if (needsReader && !isInvoiceReaderConfigured()) {
		throw new InventoryError('reader_not_configured', 503)
	}

	const { importRow, fileRows, currency } = await withInventoryWrite(
		{ orgId: caller.orgId, skipAutoSoldOut: true },
		async (tx, ctx) => {
			const now = ctx.now
			const importId = newId()
			const row: typeof invSetupImports.$inferSelect = {
				id: importId,
				status: 'reading',
				totalFiles: parsedFiles.length,
				completedFiles: 0,
				failedFiles: 0,
				proposalJson: { suppliers: [] },
				createdByKind: caller.actor.kind,
				createdById: caller.actor.id,
				appliedAt: null,
				createdAt: now,
				updatedAt: now,
			}
			await tx.insert(invSetupImports).values(row)

			const createdFiles: Array<typeof invSetupImportFiles.$inferSelect> = []
			for (let i = 0; i < parsedFiles.length; i++) {
				const file = parsedFiles[i]!
				const fileRow: typeof invSetupImportFiles.$inferSelect = {
					id: newId(),
					importId,
					fileName: file.fileName,
					contentType: file.contentType,
					fileKind: file.fileKind,
					storageKey: null,
					inlineContent: file.contentBase64,
					status: 'pending',
					errorCode: null,
					readJson: null,
					createdAt: now + i,
					updatedAt: now + i,
				}
				await tx.insert(invSetupImportFiles).values(fileRow)
				createdFiles.push(fileRow)
			}

			const orgCurrency = await getOrgDefaultCurrency(tx)
			return {
				importRow: row,
				fileRows: createdFiles,
				currency: orgCurrency,
			}
		},
	)

	runInBackground(processSetupImport(caller.orgId, importRow.id))

	return toDetail(importRow, fileRows, currency, caller.cost)
}

export async function getSetupImport(
	orgId: string,
	importId: string,
	cost = true,
): Promise<SetupImportDetail> {
	const db = await getTenantDb(orgId)
	let row = await db
		.select()
		.from(invSetupImports)
		.where(eq(invSetupImports.id, importId))
		.get()
	if (!row) throw notFound()

	// Never start new vision model work from a GET read; only wait on an
	// already-running in-process background task so immediate polls stay fresh.
	const running = inFlightImports.get(`${orgId}:${importId}`)
	if (row.status === 'reading' && running) {
		await running
		row = await db
			.select()
			.from(invSetupImports)
			.where(eq(invSetupImports.id, importId))
			.get()
		if (!row) throw notFound()
	}

	const [files, currency] = await Promise.all([
		db
			.select()
			.from(invSetupImportFiles)
			.where(eq(invSetupImportFiles.importId, importId))
			.orderBy(invSetupImportFiles.createdAt, invSetupImportFiles.id),
		getOrgDefaultCurrency(db),
	])
	return toDetail(row, files, currency, cost)
}

export async function applySetupImport(
	caller: InventoryCaller,
	importId: string,
	body: {
		currency: string
		suppliers: Array<{
			include: boolean
			existingSupplierId?: string | null
			name: string
			items: Array<{
				include: boolean
				existingItemId?: string | null
				itemName: string
				category: string
				baseUnit: InventoryBaseUnit
				packName: string
				packBaseQuantity: number
				priceMinor?: number | null
				sku?: string | null
			}>
		}>
	},
): Promise<ApplySetupImportResult> {
	const db = await getTenantDb(caller.orgId)
	const precheck = await db
		.select()
		.from(invSetupImports)
		.where(eq(invSetupImports.id, importId))
		.get()
	if (!precheck) throw notFound()
	if (precheck.status === 'reading') {
		await processSetupImport(caller.orgId, importId)
	}

	return withInventoryWrite(
		{ orgId: caller.orgId, skipAutoSoldOut: true },
		async (tx, ctx) => {
			const importRow = await tx
				.select()
				.from(invSetupImports)
				.where(eq(invSetupImports.id, importId))
				.get()
			if (!importRow) throw notFound()
			if (importRow.status === 'applied') {
				throw stateConflict('already_applied')
			}
			if (importRow.status === 'failed') {
				throw stateConflict('import_failed')
			}

			const [existingSuppliers, existingItems, existingProducts] =
				await Promise.all([
					tx.select().from(invSuppliers).where(isNull(invSuppliers.archivedAt)),
					tx.select().from(invItems).where(isNull(invItems.archivedAt)),
					tx
						.select()
						.from(invSupplierProducts)
						.where(isNull(invSupplierProducts.archivedAt)),
				])

			const supplierById = new Map(existingSuppliers.map((s) => [s.id, s]))
			const supplierByLower = new Map(
				existingSuppliers.map((s) => [s.name.toLowerCase(), s]),
			)
			let activeSupplierCount = existingSuppliers.length

			const itemById = new Map(existingItems.map((i) => [i.id, i]))
			const itemByLower = new Map(
				existingItems.map((i) => [i.name.toLowerCase(), i]),
			)
			let activeItemCount = existingItems.length

			const productsBySupplier = new Map<
				string,
				Array<typeof invSupplierProducts.$inferSelect>
			>()
			for (const prod of existingProducts) {
				const list = productsBySupplier.get(prod.supplierId)
				if (list) list.push(prod)
				else productsBySupplier.set(prod.supplierId, [prod])
			}

			let suppliersCreated = 0
			let itemsCreated = 0
			let productsUpserted = 0
			let pricesRecorded = 0

			for (const supInput of body.suppliers) {
				if (!supInput.include) continue

				let supplier = supInput.existingSupplierId
					? supplierById.get(supInput.existingSupplierId)
					: undefined
				if (supInput.existingSupplierId && !supplier) throw notFound()
				if (!supplier) {
					supplier = supplierByLower.get(supInput.name.trim().toLowerCase())
				}
				if (!supplier) {
					if (activeSupplierCount >= INVENTORY_LIMITS.suppliers) {
						throw new InventoryError('limit_reached', 409)
					}
					const supplierId = newId()
					const insertedSupplier: typeof invSuppliers.$inferSelect = {
						id: supplierId,
						name: supInput.name,
						contactName: null,
						phone: null,
						email: null,
						orderChannel: 'email',
						deliveryDays: [],
						cutoffTime: null,
						cutoffDaysBefore: 1,
						minimumOrderMinor: null,
						currency: body.currency,
						paymentTerms: null,
						vatNumber: null,
						notes: null,
						isMarketCash: false,
						mergedIntoId: null,
						pausedAt: null,
						archivedAt: null,
						version: 1,
						createdAt: ctx.now,
						updatedAt: ctx.now,
					}
					await tx.insert(invSuppliers).values(insertedSupplier)
					supplier = insertedSupplier
					supplierById.set(supplierId, insertedSupplier)
					supplierByLower.set(
						insertedSupplier.name.toLowerCase(),
						insertedSupplier,
					)
					activeSupplierCount++
					suppliersCreated++
				}

				const supProducts = productsBySupplier.get(supplier.id) ?? []
				if (!productsBySupplier.has(supplier.id)) {
					productsBySupplier.set(supplier.id, supProducts)
				}

				for (const itemInput of supInput.items) {
					if (!itemInput.include) continue

					let item = itemInput.existingItemId
						? itemById.get(itemInput.existingItemId)
						: undefined
					if (itemInput.existingItemId && !item) throw notFound()
					if (!item) {
						item = itemByLower.get(itemInput.itemName.trim().toLowerCase())
					}
					if (!item) {
						if (activeItemCount >= INVENTORY_LIMITS.items) {
							throw new InventoryError('limit_reached', 409)
						}
						const itemId = newId()
						const insertedItem: typeof invItems.$inferSelect = {
							id: itemId,
							name: itemInput.itemName,
							category: itemInput.category,
							kind: 'bought',
							baseUnit: itemInput.baseUnit,
							notes: null,
							batchCounted: false,
							autoSoldOut: false,
							isDraft: false,
							isKey: false,
							countedByBottle: false,
							bottleSizeMl: null,
							fullBottleWeightG: null,
							emptyBottleWeightG: null,
							mergedIntoId: null,
							archivedAt: null,
							version: 1,
							createdAt: ctx.now,
							updatedAt: ctx.now,
						}
						await tx.insert(invItems).values(insertedItem)
						item = insertedItem
						itemById.set(itemId, insertedItem)
						itemByLower.set(insertedItem.name.toLowerCase(), insertedItem)
						activeItemCount++
						itemsCreated++
					}

					const skuNorm = itemInput.sku?.trim().toLowerCase()
					const existingProduct = supProducts.find(
						(p) =>
							p.itemId === item.id &&
							((skuNorm && p.sku?.trim().toLowerCase() === skuNorm) ||
								p.packBaseQuantity === itemInput.packBaseQuantity ||
								p.packName.toLowerCase() === itemInput.packName.toLowerCase()),
					)
					const priceMinor = itemInput.priceMinor ?? null
					let productId: string
					if (existingProduct) {
						productId = existingProduct.id
						const nextPrice = priceMinor ?? existingProduct.priceMinor
						const nextCurrency =
							nextPrice !== null ? body.currency : existingProduct.currency
						await tx
							.update(invSupplierProducts)
							.set({
								packName: itemInput.packName,
								packBaseQuantity: itemInput.packBaseQuantity,
								priceMinor: nextPrice,
								currency: nextCurrency,
								sku: itemInput.sku ?? existingProduct.sku,
								version: existingProduct.version + 1,
								updatedAt: ctx.now,
							})
							.where(eq(invSupplierProducts.id, existingProduct.id))
						existingProduct.packName = itemInput.packName
						existingProduct.packBaseQuantity = itemInput.packBaseQuantity
						existingProduct.priceMinor = nextPrice
						existingProduct.currency = nextCurrency
						existingProduct.version += 1
					} else {
						productId = newId()
						const insertedProduct: typeof invSupplierProducts.$inferSelect = {
							id: productId,
							supplierId: supplier.id,
							itemId: item.id,
							packName: itemInput.packName,
							packBaseQuantity: itemInput.packBaseQuantity,
							priceMinor,
							currency: priceMinor !== null ? body.currency : null,
							pricedByWeight: false,
							sku: itemInput.sku ? itemInput.sku : null,
							preferred: false,
							archivedAt: null,
							version: 1,
							createdAt: ctx.now,
							updatedAt: ctx.now,
						}
						await tx.insert(invSupplierProducts).values(insertedProduct)
						supProducts.push(insertedProduct)
					}
					productsUpserted++

					if (priceMinor !== null) {
						await tx.insert(invSupplierProductPrices).values({
							id: newId(),
							supplierId: supplier.id,
							supplierProductId: productId,
							itemId: item.id,
							packName: itemInput.packName,
							packBaseQuantity: itemInput.packBaseQuantity,
							priceMinor,
							currency: body.currency,
							source: 'setup_import',
							deliveryLineId: null,
							effectiveAt: ctx.now,
							createdAt: ctx.now,
						})
						pricesRecorded++
					}
				}
			}

			await tx
				.update(invSetupImports)
				.set({
					status: 'applied',
					appliedAt: ctx.now,
					updatedAt: ctx.now,
				})
				.where(eq(invSetupImports.id, importId))

			await recordInventoryAudit(tx, {
				actorKind: caller.actor.kind,
				actorId: caller.actor.id,
				action: 'setup_import.apply',
				resourceType: 'setup_import',
				resourceId: importId,
				detail: {
					suppliersCreated,
					itemsCreated,
					productsUpserted,
					pricesRecorded,
				},
				at: ctx.now,
			})

			return {
				importId,
				suppliersCreated,
				itemsCreated,
				productsUpserted,
				pricesRecorded,
			}
		},
	)
}
