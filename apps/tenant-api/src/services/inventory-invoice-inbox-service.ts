import { randomUUID } from 'node:crypto'
import {
	INVOICE_INBOX_FILE_TYPES,
	INVOICE_INBOX_MAX_FILES,
	INVOICE_MAIL_MAX_BYTES,
	type InboundMail,
	type InvoiceInboxDetail,
	type InvoiceInboxFileType,
	type InvoiceInboxItem,
} from '@repo/inventory'
import {
	getTenantDb,
	invDeliveries,
	invDeliveryLines,
	invInvoiceInbox,
	invInvoiceInboxFiles,
	invInvoiceSenders,
	invItems,
	invOrderLines,
	invOrders,
	invSuppliers,
	type InvInvoiceInboxFileRow,
	type InvInvoiceInboxRow,
	type InvInvoiceReadLine,
} from '@repo/tenant-db'
import {
	and,
	desc,
	eq,
	inArray,
	isNull,
	lt,
	ne,
	or,
	sql,
} from 'drizzle-orm'
import { queryInChunks } from '../lib/chunked-in.ts'
import { fetchNoRedirect } from '../lib/fetch-no-redirect.ts'
import { getInventoryFlagState } from '../lib/inventory-context.ts'
import { InventoryError } from '../lib/inventory-http.ts'
import {
	type InventoryReader,
	type InventoryTx,
	withInventoryWrite,
} from '../lib/inventory-write.ts'
import {
	invoiceInboxDeps,
	invoiceInboxDomain,
	isInvoiceInboxConfigured,
} from '../lib/invoice-inbox.ts'
import {
	isInvoiceReaderConfigured,
	readInvoiceDocument,
	type ReadInvoice,
} from '../lib/invoice-reader.ts'
import { runInBackground } from '../lib/background.ts'
import {
	organizationInvoicePrefix,
	presignObjectRead,
	putStorageObject,
} from '../lib/recording-storage.ts'
import {
	deleteCachedVisionRead,
	getCachedVisionRead,
	setCachedVisionRead,
	takeVisionReadSlot,
} from '../lib/vision-read-limit.ts'
import { getNodeRegion } from '../lib/region.ts'
import { recordInventoryAudit } from './inventory-audit.ts'
import {
	assertLocationAllowed,
	assertVersion,
	badRequest,
	notFound,
	stateConflict,
} from './inventory-common.ts'
import { type InventoryCaller } from './inventory-items-service.ts'
import { getLocationCurrency } from './inventory-location-settings.ts'

/**
 * Supplier invoices that arrive without a delivery (#503): emailed to the
 * location's invoice address, uploaded in the App or photographed on Station.
 * Files and the mail's words go straight to THIS region's storage (the node
 * only ever receives mail for an organization of its own region); the reader,
 * where one is set up, reads supplier, number, date, total and lines; a person
 * then matches the invoice to an open order or a delivery, or makes a delivery
 * from it. Nothing is recorded as stock here.
 */

const EXTENSION: Record<InvoiceInboxFileType, string> = {
	'application/pdf': 'pdf',
	'image/jpeg': 'jpg',
	'image/png': 'png',
	'image/webp': 'webp',
}

/** The list a person sees: how many invoices one page holds at most. */
const MAX_BODY_TEXT = 50_000

export type InboxFile = {
	fileName: string | null
	contentType: InvoiceInboxFileType
	bytes: Uint8Array
}

/** Letters, digits and `. _ -` of a sender's file name, never a path. */
function safeFileName(name: string | undefined | null): string | null {
	const base = (name ?? '').split(/[\\/]/).pop() ?? ''
	const cleaned = base.replace(/[^\p{L}\p{N}._ -]/gu, '').trim().slice(0, 120)
	return cleaned || null
}

/** The content type of an attachment, or null when it is not one we keep. */
export function invoiceFileType(
	contentType: string,
	fileName: string | null | undefined,
): InvoiceInboxFileType | null {
	const type = contentType.toLowerCase().split(';')[0]!.trim()
	if ((INVOICE_INBOX_FILE_TYPES as readonly string[]).includes(type)) {
		return type as InvoiceInboxFileType
	}
	if (type === 'image/jpg') return 'image/jpeg'
	if (type === 'application/octet-stream' || type === '') {
		const ext = (fileName ?? '').toLowerCase().split('.').pop()
		if (ext === 'pdf') return 'application/pdf'
		if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
		if (ext === 'png') return 'image/png'
		if (ext === 'webp') return 'image/webp'
	}
	return null
}

function decodeBase64(value: string): Uint8Array | null {
	try {
		const binary = atob(value.replace(/\s+/g, ''))
		const bytes = new Uint8Array(binary.length)
		for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
		return bytes
	} catch {
		return null
	}
}

const approxDecodedBytes = (base64: string) =>
	Math.floor((base64.replace(/\s+/g, '').length * 3) / 4)

// ── Config ──────────────────────────────────────────────────────────────────

/** `GET /invoice-inbox/config`: show the address only when this node receives mail for it. */
export function inboxConfig(caller: InventoryCaller): {
	enabled: boolean
	domain: string | null
} {
	const enabled =
		caller.features?.invoiceInbox === true && isInvoiceInboxConfigured()
	return { enabled, domain: enabled ? invoiceInboxDomain() : null }
}

function assertInboxEnabled(caller: InventoryCaller): void {
	if (!caller.features?.invoiceInbox) {
		throw new InventoryError('feature_disabled', 403, {
			feature: 'invoiceInbox',
		})
	}
}

// ── Storing ─────────────────────────────────────────────────────────────────

async function storeFiles(
	orgId: string,
	inboxId: string,
	files: readonly InboxFile[],
	body: string | null,
): Promise<
	| { ok: true; keys: string[]; bodyKey: string | null }
	| { ok: false; reason: 'storage_unavailable' }
> {
	const prefix = `${organizationInvoicePrefix(orgId)}inbox-${inboxId}/`
	const keys: string[] = []
	for (const [index, file] of files.entries()) {
		const key = `${prefix}${index}.${EXTENSION[file.contentType]}`
		const result = await putStorageObject(key, file.bytes, file.contentType)
		if (result !== 'uploaded') return { ok: false, reason: 'storage_unavailable' }
		keys.push(key)
	}
	let bodyKey: string | null = null
	if (body) {
		bodyKey = `${prefix}body.txt`
		const result = await putStorageObject(
			bodyKey,
			new TextEncoder().encode(body),
			'text/plain',
		)
		if (result !== 'uploaded') return { ok: false, reason: 'storage_unavailable' }
	}
	return { ok: true, keys, bodyKey }
}

async function senderStateOf(
	db: InventoryReader,
	address: string | null,
): Promise<'known' | 'allowed' | 'unknown'> {
	if (!address) return 'unknown'
	const lower = address.toLowerCase()
	const allowed = await db
		.select({ id: invInvoiceSenders.id })
		.from(invInvoiceSenders)
		.where(eq(invInvoiceSenders.address, lower))
		.get()
	if (allowed) return 'allowed'
	const suppliers = await db
		.select({ email: invSuppliers.email })
		.from(invSuppliers)
		.where(isNull(invSuppliers.archivedAt))
	return suppliers.some((row) => row.email?.trim().toLowerCase() === lower)
		? 'known'
		: 'unknown'
}

async function insertInbox(
	tx: InventoryTx,
	input: {
		id: string
		locationId: string
		source: 'email' | 'upload' | 'station'
		messageId: string | null
		fromAddress: string | null
		subject: string | null
		bodyKey: string | null
		files: { file: InboxFile; key: string }[]
		senderState: 'known' | 'allowed' | 'unknown'
		readState: 'pending' | 'not_configured'
		addedBy: { kind: 'operator' | 'staff' | 'system'; id: string | null }
		receivedAt: number
		now: number
	},
) {
	const sizeBytes = input.files.reduce((sum, row) => sum + row.file.bytes.length, 0)
	await tx.insert(invInvoiceInbox).values({
		id: input.id,
		locationId: input.locationId,
		source: input.source,
		messageId: input.messageId,
		fromAddress: input.fromAddress,
		subject: input.subject,
		bodyKey: input.bodyKey,
		sizeBytes,
		senderState: input.senderState,
		status: 'new',
		readState: input.readState,
		addedByKind: input.addedBy.kind,
		addedById: input.addedBy.id,
		receivedAt: input.receivedAt,
		createdAt: input.now,
		updatedAt: input.now,
	})
	for (const [position, row] of input.files.entries()) {
		await tx.insert(invInvoiceInboxFiles).values({
			inboxId: input.id,
			storageKey: row.key,
			contentType: row.file.contentType,
			sizeBytes: row.file.bytes.length,
			fileName: row.file.fileName,
			position,
			createdAt: input.now,
		})
	}
}

// ── Receiving mail ──────────────────────────────────────────────────────────

export type MailOutcome =
	| { status: 'stored'; inboxId: string; files: number; ignored: number }
	| { status: 'duplicate'; inboxId: string }
	| { status: 'ignored' }
	| { status: 'too_large' }
	| { status: 'feature_off' }
	| { status: 'storage_unavailable' }

/**
 * Keeps one email for one location: the invoice attachments (PDF or image,
 * other attachments ignored) and the body, straight into this region's
 * storage, then one inbox row. A message id seen before at the location is
 * answered, not stored again. An email over 25 MB (attachments together) is
 * refused whole. The reader runs in the background.
 */
export async function receiveInvoiceMail(
	orgId: string,
	locationId: string,
	mail: InboundMail,
): Promise<MailOutcome> {
	const flags = await getInventoryFlagState(orgId)
	if (flags.status !== 'on' || !flags.features.invoiceInbox) {
		return { status: 'feature_off' }
	}
	let total = (mail.text ?? '').length
	for (const attachment of mail.attachments) {
		total += approxDecodedBytes(attachment.contentBase64)
	}
	if (total > INVOICE_MAIL_MAX_BYTES) return { status: 'too_large' }

	const db = await getTenantDb(orgId)
	const messageId = mail.messageId.slice(0, 300)
	const earlier = await db
		.select({ id: invInvoiceInbox.id })
		.from(invInvoiceInbox)
		.where(
			and(
				eq(invInvoiceInbox.locationId, locationId),
				eq(invInvoiceInbox.messageId, messageId),
			),
		)
		.get()
	if (earlier) return { status: 'duplicate', inboxId: earlier.id }

	const kept: InboxFile[] = []
	let ignored = 0
	for (const attachment of mail.attachments) {
		const type = invoiceFileType(attachment.contentType, attachment.filename)
		const bytes = type ? decodeBase64(attachment.contentBase64) : null
		if (!type || !bytes || bytes.length === 0 || kept.length >= INVOICE_INBOX_MAX_FILES) {
			ignored += 1
			continue
		}
		kept.push({ fileName: safeFileName(attachment.filename), contentType: type, bytes })
	}
	if (kept.length === 0) return { status: 'ignored' }

	const id = randomUUID()
	const stored = await storeFiles(
		orgId,
		id,
		kept,
		mail.text ? mail.text.slice(0, MAX_BODY_TEXT) : null,
	)
	if (!stored.ok) return { status: 'storage_unavailable' }

	const now = invoiceInboxDeps.now()
	const from = mail.from.address.trim().toLowerCase()
	const readState = isInvoiceReaderConfigured() ? 'pending' : 'not_configured'
	await withInventoryWrite({ orgId }, async (tx) => {
		await insertInbox(tx, {
			id,
			locationId,
			source: 'email',
			messageId,
			fromAddress: from,
			subject: mail.subject?.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 200) || null,
			bodyKey: stored.bodyKey,
			files: kept.map((file, index) => ({ file, key: stored.keys[index]! })),
			senderState: await senderStateOf(tx, from),
			readState,
			addedBy: { kind: 'system', id: null },
			receivedAt: Math.min(mail.receivedAt ?? now, now),
			now,
		})
	})
	if (readState === 'pending') {
		runInBackground(
			readInboxInvoiceFromBytes(orgId, id, kept[0]!).catch(() => undefined),
		)
	}
	return { status: 'stored', inboxId: id, files: kept.length, ignored }
}

// ── Uploads (App and Station) ───────────────────────────────────────────────

/**
 * Invoices added by a person: one inbox row per file (several files at once),
 * from the App, or a photo from Station with no delivery. Files of another
 * kind, or beyond ten, are ignored.
 */
export async function addInvoiceFiles(
	caller: InventoryCaller,
	input: {
		locationId: string
		files: { fileName: string | null; contentType: string; bytes: Uint8Array }[]
		source: 'upload' | 'station'
		/** Station: one press, one row (a retry answers the first). */
		clientId?: string
	},
): Promise<{ invoices: InvoiceInboxItem[]; ignored: number }> {
	assertInboxEnabled(caller)
	assertLocationAllowed(caller.locationIds, input.locationId)
	let total = 0
	const kept: InboxFile[] = []
	let ignored = 0
	for (const file of input.files) {
		total += file.bytes.length
		const type = invoiceFileType(file.contentType, file.fileName)
		if (!type || file.bytes.length === 0 || kept.length >= INVOICE_INBOX_MAX_FILES) {
			ignored += 1
			continue
		}
		kept.push({ fileName: safeFileName(file.fileName), contentType: type, bytes: file.bytes })
	}
	if (total > INVOICE_MAIL_MAX_BYTES) throw badRequest('uploads_too_large')
	if (kept.length === 0) throw badRequest('no_invoice_files')
	const db = await getTenantDb(caller.orgId)
	const messageIdFor = (index: number) =>
		input.clientId ? `${input.source}:${input.clientId}:${index}` : null
	// A repeated Station press answers the rows it made.
	if (input.clientId) {
		const earlier = await db
			.select({ id: invInvoiceInbox.id })
			.from(invInvoiceInbox)
			.where(
				and(
					eq(invInvoiceInbox.locationId, input.locationId),
					eq(invInvoiceInbox.messageId, messageIdFor(0)!),
				),
			)
		if (earlier.length > 0) {
			return {
				invoices: await itemsOf(db, earlier.map((row) => row.id), caller),
				ignored,
			}
		}
	}
	const now = invoiceInboxDeps.now()
	const ids: string[] = []
	const toRead: Array<{ id: string; file: InboxFile }> = []
	const readState = isInvoiceReaderConfigured() ? 'pending' : 'not_configured'
	for (const [index, file] of kept.entries()) {
		const id = randomUUID()
		const stored = await storeFiles(caller.orgId, id, [file], null)
		if (!stored.ok) throw new InventoryError('upload_not_configured', 503)
		await withInventoryWrite({ orgId: caller.orgId }, async (tx) => {
			await insertInbox(tx, {
				id,
				locationId: input.locationId,
				source: input.source,
				messageId: messageIdFor(index),
				fromAddress: null,
				subject: null,
				bodyKey: null,
				files: [{ file, key: stored.keys[0]! }],
				senderState: 'known',
				readState,
				addedBy: caller.actor,
				receivedAt: now,
				now,
			})
			await recordInventoryAudit(tx, {
				actorKind: caller.actor.kind,
				actorId: caller.actor.id,
				action: 'invoice_inbox.add',
				resourceType: 'invoice_inbox',
				resourceId: id,
				locationId: input.locationId,
				detail: { source: input.source },
				at: now,
			})
		})
		ids.push(id)
		toRead.push({ id, file })
	}
	if (readState === 'pending') {
		for (const row of toRead) {
			runInBackground(
				readInboxInvoiceFromBytes(caller.orgId, row.id, row.file).catch(
					() => undefined,
				),
			)
		}
	}
	return { invoices: await itemsOf(db, ids, caller), ignored }
}

// ── Reading ─────────────────────────────────────────────────────────────────

function minorOf(major: number | null): number | null {
	return major === null ? null : Math.round(major * 100)
}

const norm = (value: string) => value.trim().toLowerCase().replace(/\s+/g, ' ')

/**
 * Reads one stored invoice with the node's own reader and keeps what it found:
 * supplier (matched by name to a known one), number, date, total and lines
 * (each matched to an item by name when it can be). Marks a duplicate: the same
 * number from the same supplier already in the inbox. The reader never decides
 * anything: a person checks it.
 */
async function readInboxInvoiceFromBytes(
	orgId: string,
	inboxId: string,
	file: Pick<InboxFile, 'bytes' | 'contentType' | 'fileName'>,
): Promise<void> {
	const db = await getTenantDb(orgId)
	let read: ReadInvoice | null = null
	let state: 'read' | 'failed' | 'not_configured' = 'not_configured'
	if (isInvoiceReaderConfigured()) {
		const cacheKey = `${orgId}:inbox:${inboxId}`
		read = getCachedVisionRead<ReadInvoice>(cacheKey) ?? null
		if (!read) {
			if (takeVisionReadSlot(orgId)) {
				try {
					read = await readInvoiceDocument({
						bytes: file.bytes,
						contentType: file.contentType,
						fileName: file.fileName ?? undefined,
					})
					setCachedVisionRead(cacheKey, read)
				} catch {
					read = null
				}
			}
		}
		state = read ? 'read' : 'failed'
	}
	const row = await db
		.select()
		.from(invInvoiceInbox)
		.where(eq(invInvoiceInbox.id, inboxId))
		.get()
	if (!row) return
	if (!read) {
		await db
			.update(invInvoiceInbox)
			.set({ readState: state, updatedAt: invoiceInboxDeps.now() })
			.where(eq(invInvoiceInbox.id, inboxId))
		return
	}
	const [suppliers, items, currency] = await Promise.all([
		db.select().from(invSuppliers).where(isNull(invSuppliers.archivedAt)),
		db.select({ id: invItems.id, name: invItems.name }).from(invItems).where(isNull(invItems.archivedAt)),
		getLocationCurrency(db, row.locationId),
	])
	const supplier = read.supplierName
		? suppliers.find((candidate) => norm(candidate.name) === norm(read!.supplierName!))
		: undefined
	const itemByName = new Map(items.map((item) => [norm(item.name), item.id]))
	const lines: InvInvoiceReadLine[] = read.lines.map((line) => ({
		description: line.text,
		itemId: itemByName.get(norm(line.text)) ?? null,
		quantity: line.quantity,
		unit: line.unit,
		lineTotalMinor: minorOf(line.lineTotal),
	}))
	let duplicateOfId: string | null = null
	if (read.invoiceNumber) {
		const same = await db
			.select({ id: invInvoiceInbox.id, supplierName: invInvoiceInbox.supplierName, supplierId: invInvoiceInbox.supplierId })
			.from(invInvoiceInbox)
			.where(
				and(
					ne(invInvoiceInbox.id, inboxId),
					eq(invInvoiceInbox.invoiceNumber, read.invoiceNumber),
					lt(invInvoiceInbox.createdAt, row.createdAt + 1),
				),
			)
			.orderBy(invInvoiceInbox.createdAt)
		const hit = same.find((other) =>
			supplier
				? other.supplierId === supplier.id
				: other.supplierName !== null &&
					read!.supplierName !== null &&
					norm(other.supplierName) === norm(read!.supplierName),
		)
		duplicateOfId = hit?.id ?? null
	}
	await db
		.update(invInvoiceInbox)
		.set({
			readState: 'read',
			supplierId: supplier?.id ?? null,
			supplierName: read.supplierName,
			invoiceNumber: read.invoiceNumber,
			invoiceDate: read.invoiceDate ?? null,
			totalMinor: minorOf(read.total),
			currency: supplier?.currency ?? currency ?? (getNodeRegion() === 'ksa' ? 'SAR' : 'USD'),
			linesJson: lines,
			duplicateOfId,
			version: sql`${invInvoiceInbox.version} + 1`,
			updatedAt: invoiceInboxDeps.now(),
		})
		.where(eq(invInvoiceInbox.id, inboxId))
}

/** `POST /invoice-inbox/:id/read`: ask the reader again, from the stored file. */
export async function rereadInboxInvoice(
	caller: InventoryCaller,
	input: { id: string },
): Promise<InvoiceInboxItem> {
	assertInboxEnabled(caller)
	const db = await getTenantDb(caller.orgId)
	const row = await loadAllowed(db, input.id, caller)
	if (!isInvoiceReaderConfigured()) {
		throw new InventoryError('reader_not_configured', 503)
	}
	const file = (await filesOf(db, [row.id])).get(row.id)?.[0]
	if (!file) throw new InventoryError('no_photo', 409)
	const link = presignObjectRead(file.storageKey, {
		contentType: file.contentType,
		expiresInSeconds: 60,
	})
	if (!link) throw new InventoryError('upload_not_configured', 503)
	let bytes: Uint8Array
	try {
		const response = await fetchNoRedirect(link.url, { signal: AbortSignal.timeout(15_000) })
		if (!response.ok) throw new Error('file unavailable')
		bytes = new Uint8Array(await response.arrayBuffer())
	} catch {
		throw new InventoryError('reader_failed', 502)
	}
	deleteCachedVisionRead(`${caller.orgId}:inbox:${row.id}`)
	await readInboxInvoiceFromBytes(caller.orgId, row.id, {
		bytes,
		contentType: file.contentType as InvoiceInboxFileType,
		fileName: file.fileName,
	})
	return (await itemsOf(db, [row.id], caller))[0]!
}

// ── Reading the inbox ───────────────────────────────────────────────────────

async function loadAllowed(
	db: InventoryReader,
	id: string,
	caller: InventoryCaller,
): Promise<InvInvoiceInboxRow> {
	const row = await db
		.select()
		.from(invInvoiceInbox)
		.where(eq(invInvoiceInbox.id, id))
		.get()
	if (!row) throw notFound()
	assertLocationAllowed(caller.locationIds, row.locationId)
	return row
}

async function filesOf(
	db: InventoryReader,
	ids: readonly string[],
): Promise<Map<string, InvInvoiceInboxFileRow[]>> {
	const map = new Map<string, InvInvoiceInboxFileRow[]>()
	if (ids.length === 0) return map
	const rows = (
		await queryInChunks([...ids], (chunk) =>
			db
				.select()
				.from(invInvoiceInboxFiles)
				.where(inArray(invInvoiceInboxFiles.inboxId, chunk)),
		)
	).sort((a, b) => a.position - b.position)
	for (const row of rows) {
		const list = map.get(row.inboxId)
		if (list) list.push(row)
		else map.set(row.inboxId, [row])
	}
	return map
}

function itemOf(
	row: InvInvoiceInboxRow,
	files: InvInvoiceInboxFileRow[],
	duplicateDeliveryId: string | null,
	cost: boolean,
): InvoiceInboxItem {
	const out: InvoiceInboxItem = {
		id: row.id,
		locationId: row.locationId,
		source: row.source,
		receivedAt: row.receivedAt,
		fromAddress: row.fromAddress,
		subject: row.subject,
		senderState: row.senderState,
		status: row.status,
		readState: row.readState,
		supplierId: row.supplierId,
		supplierName: row.supplierName,
		invoiceNumber: row.invoiceNumber,
		invoiceDate: row.invoiceDate,
		lineCount: row.linesJson?.length ?? 0,
		files: files.map((file) => ({
			id: file.id,
			fileName: file.fileName,
			contentType: file.contentType,
			sizeBytes: file.sizeBytes,
		})),
		duplicateOfId: row.duplicateOfId,
		duplicateDeliveryId,
		orderId: row.orderId,
		deliveryId: row.deliveryId,
		version: row.version,
	}
	if (cost) {
		if (row.totalMinor !== null) out.totalMinor = row.totalMinor
		if (row.currency) out.currency = row.currency
	}
	return out
}

async function duplicateDeliveries(
	db: InventoryReader,
	rows: readonly InvInvoiceInboxRow[],
): Promise<Map<string, string>> {
	const out = new Map<string, string>()
	const keyed = rows.filter((row) => row.supplierId && row.invoiceNumber)
	for (const row of keyed) {
		const hit = await db
			.select({ id: invDeliveries.id })
			.from(invDeliveries)
			.where(
				and(
					eq(invDeliveries.supplierId, row.supplierId!),
					eq(invDeliveries.invoiceNumber, row.invoiceNumber!),
					ne(invDeliveries.status, 'cancelled'),
					row.deliveryId ? ne(invDeliveries.id, row.deliveryId) : undefined,
				),
			)
			.limit(1)
			.get()
		if (hit) out.set(row.id, hit.id)
	}
	return out
}

async function itemsOf(
	db: InventoryReader,
	ids: readonly string[],
	caller: InventoryCaller,
): Promise<InvoiceInboxItem[]> {
	if (ids.length === 0) return []
	const rows = await queryInChunks([...ids], (chunk) =>
		db.select().from(invInvoiceInbox).where(inArray(invInvoiceInbox.id, chunk)),
	)
	const order = new Map(ids.map((id, index) => [id, index]))
	rows.sort((a, b) => order.get(a.id)! - order.get(b.id)!)
	const [files, duplicates] = await Promise.all([
		filesOf(db, ids),
		duplicateDeliveries(db, rows),
	])
	return rows.map((row) =>
		itemOf(row, files.get(row.id) ?? [], duplicates.get(row.id) ?? null, caller.cost),
	)
}

/** `GET /invoice-inbox`: newest first, with how many invoices still wait. */
export async function listInbox(
	db: InventoryReader,
	input: {
		caller: InventoryCaller
		locationId: string
		status: 'open' | 'all' | InvInvoiceInboxRow['status']
		limit: number
		cursor?: string
	},
) {
	assertInboxEnabled(input.caller)
	assertLocationAllowed(input.caller.locationIds, input.locationId)
	const before = input.cursor ? Number(input.cursor) : null
	if (before !== null && !Number.isSafeInteger(before)) throw badRequest('cursor')
	const statusCondition =
		input.status === 'all'
			? undefined
			: input.status === 'open'
				? or(eq(invInvoiceInbox.status, 'new'), eq(invInvoiceInbox.status, 'matched'))
				: eq(invInvoiceInbox.status, input.status)
	const rows = await db
		.select()
		.from(invInvoiceInbox)
		.where(
			and(
				eq(invInvoiceInbox.locationId, input.locationId),
				statusCondition,
				before !== null ? lt(invInvoiceInbox.receivedAt, before) : undefined,
			),
		)
		.orderBy(desc(invInvoiceInbox.receivedAt), desc(invInvoiceInbox.id))
		.limit(input.limit + 1)
	const page = rows.slice(0, input.limit)
	const open = await db
		.select({ n: sql<number>`count(*)` })
		.from(invInvoiceInbox)
		.where(
			and(
				eq(invInvoiceInbox.locationId, input.locationId),
				or(eq(invInvoiceInbox.status, 'new'), eq(invInvoiceInbox.status, 'matched')),
			),
		)
		.get()
	return {
		items: await itemsOf(db, page.map((row) => row.id), input.caller),
		nextCursor:
			rows.length > input.limit ? String(page.at(-1)!.receivedAt) : null,
		openCount: Number(open?.n ?? 0),
	}
}

/** `GET /invoice-inbox/:id`: the invoice with read links and where it could go. */
export async function getInboxDetail(
	db: InventoryReader,
	input: { caller: InventoryCaller; id: string },
): Promise<InvoiceInboxDetail> {
	assertInboxEnabled(input.caller)
	const row = await loadAllowed(db, input.id, input.caller)
	const base = (await itemsOf(db, [row.id], input.caller))[0]!
	const files = await filesOf(db, [row.id])
	const stored = files.get(row.id) ?? []
	const orders = row.supplierId
		? await db
				.select()
				.from(invOrders)
				.where(
					and(
						eq(invOrders.locationId, row.locationId),
						eq(invOrders.supplierId, row.supplierId),
						inArray(invOrders.status, ['sent', 'partly_received']),
					),
				)
				.orderBy(invOrders.expectedDate, invOrders.number)
		: []
	const orderLines = await Promise.all(
		orders.map(async (order) => {
			const lines = await db
				.select({ id: invOrderLines.id })
				.from(invOrderLines)
				.where(eq(invOrderLines.orderId, order.id))
			return lines.length
		}),
	)
	const deliveries = row.supplierId
		? await db
				.select()
				.from(invDeliveries)
				.where(
					and(
						eq(invDeliveries.locationId, row.locationId),
						eq(invDeliveries.supplierId, row.supplierId),
						eq(invDeliveries.status, 'received'),
						isNull(invDeliveries.invoiceNumber),
					),
				)
				.orderBy(desc(invDeliveries.receivedAt))
				.limit(10)
		: []
	const deliveryLines = await Promise.all(
		deliveries.map(async (delivery) => {
			const lines = await db
				.select({ id: invDeliveryLines.id })
				.from(invDeliveryLines)
				.where(eq(invDeliveryLines.deliveryId, delivery.id))
			return lines.length
		}),
	)
	return {
		...base,
		files: base.files.map((file, index) => ({
			...file,
			url:
				presignObjectRead(stored[index]!.storageKey, {
					contentType: file.contentType,
				})?.url ?? null,
		})),
		lines: (row.linesJson ?? []).map((line) => ({
			description: line.description,
			itemId: line.itemId,
			quantity: line.quantity,
			unit: line.unit,
			...(input.caller.cost && line.lineTotalMinor !== null
				? { lineTotalMinor: line.lineTotalMinor }
				: {}),
		})),
		suggestedOrders: orders.map((order, index) => ({
			id: order.id,
			number: order.number,
			status: order.status,
			expectedDate: order.expectedDate,
			lineCount: orderLines[index]!,
		})),
		suggestedDeliveries: deliveries.map((delivery, index) => ({
			id: delivery.id,
			receivedAt: delivery.receivedAt,
			lineCount: deliveryLines[index]!,
			invoiceNumber: delivery.invoiceNumber,
		})),
	}
}

// ── Matching ────────────────────────────────────────────────────────────────

/**
 * Matches an invoice to an open order (the receive screen opens prefilled from
 * `prefill`), to a delivery already recorded (the invoice is then delivered), or
 * clears the match. Nothing is received by matching.
 */
export async function matchInvoice(
	caller: InventoryCaller,
	input: {
		id: string
		body: { expectedVersion: number; orderId?: string | null; deliveryId?: string | null }
	},
) {
	assertInboxEnabled(caller)
	return withInventoryWrite({ orgId: caller.orgId }, async (tx, ctx) => {
		const row = await loadAllowed(tx, input.id, caller)
		assertVersion(row.version, input.body.expectedVersion)
		if (row.status === 'delivered' || row.status === 'dismissed') {
			throw stateConflict('invoice_closed')
		}
		let status: InvInvoiceInboxRow['status'] = 'new'
		let orderId: string | null = null
		let deliveryId: string | null = null
		let supplierId = row.supplierId
		if (input.body.orderId) {
			const order = await tx
				.select()
				.from(invOrders)
				.where(eq(invOrders.id, input.body.orderId))
				.get()
			if (!order || order.locationId !== row.locationId) throw notFound()
			if (order.status === 'received' || order.status === 'cancelled') {
				throw new InventoryError('order_closed', 409)
			}
			if (row.supplierId && order.supplierId !== row.supplierId) {
				throw new InventoryError('supplier_mismatch', 409)
			}
			orderId = order.id
			supplierId = order.supplierId
			status = 'matched'
		} else if (input.body.deliveryId) {
			const delivery = await tx
				.select()
				.from(invDeliveries)
				.where(eq(invDeliveries.id, input.body.deliveryId))
				.get()
			if (!delivery || delivery.locationId !== row.locationId) throw notFound()
			deliveryId = delivery.id
			supplierId = delivery.supplierId ?? supplierId
			status = 'delivered'
		}
		await tx
			.update(invInvoiceInbox)
			.set({
				status,
				orderId,
				deliveryId,
				supplierId,
				version: row.version + 1,
				updatedAt: ctx.now,
			})
			.where(eq(invInvoiceInbox.id, row.id))
		await recordInventoryAudit(tx, {
			actorKind: caller.actor.kind,
			actorId: caller.actor.id,
			action: 'invoice_inbox.match',
			resourceType: 'invoice_inbox',
			resourceId: row.id,
			locationId: row.locationId,
			detail: { status },
			at: ctx.now,
		})
		const updated = await tx
			.select()
			.from(invInvoiceInbox)
			.where(eq(invInvoiceInbox.id, row.id))
			.get()
		const item = (await itemsOf(tx, [row.id], caller))[0]!
		return {
			invoice: item,
			prefill: orderId
				? {
						orderId,
						supplierId,
						invoiceNumber: updated!.invoiceNumber,
						invoiceDate: updated!.invoiceDate,
						...(caller.cost && updated!.totalMinor !== null
							? { totalMinor: updated!.totalMinor }
							: {}),
						...(caller.cost && updated!.currency ? { currency: updated!.currency } : {}),
						inboxId: row.id,
					}
				: null,
		}
	})
}

export async function dismissInvoice(
	caller: InventoryCaller,
	input: { id: string; expectedVersion: number },
): Promise<InvoiceInboxItem> {
	assertInboxEnabled(caller)
	return withInventoryWrite({ orgId: caller.orgId }, async (tx, ctx) => {
		const row = await loadAllowed(tx, input.id, caller)
		assertVersion(row.version, input.expectedVersion)
		if (row.status === 'delivered') throw stateConflict('invoice_closed')
		await tx
			.update(invInvoiceInbox)
			.set({ status: 'dismissed', version: row.version + 1, updatedAt: ctx.now })
			.where(eq(invInvoiceInbox.id, row.id))
		await recordInventoryAudit(tx, {
			actorKind: caller.actor.kind,
			actorId: caller.actor.id,
			action: 'invoice_inbox.dismiss',
			resourceType: 'invoice_inbox',
			resourceId: row.id,
			locationId: row.locationId,
			at: ctx.now,
		})
		return (await itemsOf(tx, [row.id], caller))[0]!
	})
}

/**
 * The owner allows the sender of this invoice: their address is remembered, and
 * the unknown-sender mark comes off every invoice from it.
 */
export async function allowInvoiceSender(
	caller: InventoryCaller,
	input: { id: string },
): Promise<InvoiceInboxItem> {
	assertInboxEnabled(caller)
	if (!caller.isOwner && !caller.canManageSettings) {
		throw new InventoryError('forbidden', 403, { reason: 'owner_required' })
	}
	return withInventoryWrite({ orgId: caller.orgId }, async (tx, ctx) => {
		const row = await loadAllowed(tx, input.id, caller)
		if (!row.fromAddress) throw stateConflict('no_sender')
		await tx
			.insert(invInvoiceSenders)
			.values({
				address: row.fromAddress,
				supplierId: row.supplierId,
				allowedByKind: caller.actor.kind,
				allowedById: caller.actor.id,
				createdAt: ctx.now,
			})
			.onConflictDoNothing()
		await tx
			.update(invInvoiceInbox)
			.set({ senderState: 'allowed', updatedAt: ctx.now })
			.where(
				and(
					eq(invInvoiceInbox.fromAddress, row.fromAddress),
					eq(invInvoiceInbox.senderState, 'unknown'),
				),
			)
		await recordInventoryAudit(tx, {
			actorKind: caller.actor.kind,
			actorId: caller.actor.id,
			action: 'invoice_inbox.allow_sender',
			resourceType: 'invoice_inbox',
			resourceId: row.id,
			locationId: row.locationId,
			at: ctx.now,
		})
		return (await itemsOf(tx, [row.id], caller))[0]!
	})
}

/**
 * Called by `recordDelivery` when the delivery was made from an inbox invoice:
 * the invoice is delivered and points at it, and the delivery keeps the
 * invoice's facts a person confirmed on the receive screen.
 */
export async function linkInboxToDelivery(
	tx: InventoryTx,
	input: {
		inboxId: string
		locationId: string
		deliveryId: string
		now: number
	},
): Promise<void> {
	const row = await tx
		.select()
		.from(invInvoiceInbox)
		.where(eq(invInvoiceInbox.id, input.inboxId))
		.get()
	if (!row || row.locationId !== input.locationId) throw notFound()
	if (row.status === 'delivered' || row.status === 'dismissed') {
		throw stateConflict('invoice_closed')
	}
	await tx
		.update(invInvoiceInbox)
		.set({
			status: 'delivered',
			deliveryId: input.deliveryId,
			version: row.version + 1,
			updatedAt: input.now,
		})
		.where(eq(invInvoiceInbox.id, row.id))
}

