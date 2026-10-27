import crypto from 'node:crypto'
import {
	PRINT_DEFAULT_BLEED_MM,
	type PrintDownloadFormat,
	type PrintHomeSheet,
	type PrintSnapshot,
} from '@repo/common/print-shop'
import { and, db, eq, lt, PrintRender, sql } from '@repo/database'
import { readPrintFile, uploadPrintFile } from '#app/utils/storage.server.ts'
import {
	isPdfRendererConfigured,
	renderLimitPerHour,
	renderPdf,
} from './pdf-renderer.server.ts'
import { renderPrintHtml } from './print-document.server.tsx'
import { qrSvgsFor, snapshotHash } from './print-snapshot.server.ts'

/**
 * Print files: a PDF is rendered once per organization and distinct input
 * (template version, snapshot, format, sheet, bleed) and kept in object
 * storage; the same input is served from the cache and does not count
 * against the hourly limit. A render first reserves its `PrintRender` row in
 * one statement that also checks the limit, so concurrent requests cannot
 * render past it; a failed render gives the slot back.
 */

/** A reserved slot older than this is a render that died: try again. */
const RENDER_STALE_MS = 2 * 60_000

export type PrintFileRequest = {
	organizationId: string
	snapshot: PrintSnapshot
	format: PrintDownloadFormat
	homeSheet?: PrintHomeSheet
	bleedMm?: number
}

export type PrintFileResult =
	| { kind: 'pdf'; bytes: Uint8Array<ArrayBuffer>; objectKey: string }
	/** No renderer configured: a page that opens the browser print dialog. */
	| { kind: 'html'; html: string; nonce: string }
	| { kind: 'limited' }
	/** Another request is rendering the same file right now. */
	| { kind: 'busy' }
	| { kind: 'failed' }

export function printFileHash(input: PrintFileRequest): string {
	return crypto
		.createHash('sha256')
		.update(
			JSON.stringify({
				v: input.snapshot.templateVersion,
				snapshot: snapshotHash(input.snapshot),
				format: input.format,
				sheet: input.format === 'home' ? (input.homeSheet ?? 'letter') : null,
				bleed:
					input.format === 'pro'
						? (input.bleedMm ?? PRINT_DEFAULT_BLEED_MM)
						: 0,
			}),
		)
		.digest('hex')
}

export async function printDocumentHtml(
	input: PrintFileRequest & { autoPrint?: boolean; nonce?: string },
) {
	return renderPrintHtml({
		nonce: input.nonce,
		snapshot: input.snapshot,
		format: input.format,
		homeSheet: input.homeSheet,
		bleedMm: input.bleedMm ?? PRINT_DEFAULT_BLEED_MM,
		qrSvgs: await qrSvgsFor(input.snapshot),
		autoPrint: input.autoPrint,
	})
}

export async function getPrintFile(
	input: PrintFileRequest,
	/** Paid orders: already bounded by the pieces paid for, so no hourly cap. */
	options: { skipLimit?: boolean } = {},
): Promise<PrintFileResult> {
	const hash = printFileHash(input)
	const organizationId = input.organizationId
	const thisRow = and(
		eq(PrintRender.organizationId, organizationId),
		eq(PrintRender.hash, hash),
	)
	const [cached] = await db
		.select({
			objectKey: PrintRender.objectKey,
			byteLength: PrintRender.byteLength,
			createdAt: PrintRender.createdAt,
		})
		.from(PrintRender)
		.where(thisRow)
		.limit(1)
	if (cached && cached.byteLength > 0) {
		const bytes = await readPrintFile(cached.objectKey)
		if (bytes) return { kind: 'pdf', bytes, objectKey: cached.objectKey }
		await db.delete(PrintRender).where(thisRow)
	} else if (cached) {
		if (Date.now() - cached.createdAt.getTime() < RENDER_STALE_MS) {
			return { kind: 'busy' }
		}
		await db
			.delete(PrintRender)
			.where(
				and(
					thisRow,
					eq(PrintRender.byteLength, 0),
					lt(PrintRender.createdAt, new Date(Date.now() - RENDER_STALE_MS)),
				),
			)
	}

	if (!isPdfRendererConfigured()) {
		const nonce = crypto.randomBytes(16).toString('base64')
		return {
			kind: 'html',
			nonce,
			html: await printDocumentHtml({ ...input, autoPrint: true, nonce }),
		}
	}

	const objectKey = `print/${organizationId}/${hash}.pdf`
	const now = new Date()
	const counts = !options.skipLimit
	// Reserve the slot: one statement, so the limit holds under concurrency.
	const reserved = await db
		.insert(PrintRender)
		.select(
			sql`select ${organizationId}, ${hash}, ${objectKey}, 0, ${counts ? 1 : 0}, ${now.getTime()} where ${
				counts
					? sql`(select count(*) from ${PrintRender} where ${PrintRender.organizationId} = ${organizationId} and ${PrintRender.countsTowardLimit} = 1 and ${PrintRender.createdAt} >= ${now.getTime() - 3_600_000}) < ${renderLimitPerHour()}`
					: sql`1 = 1`
			}`,
		)
		.onConflictDoNothing()
		.returning({ hash: PrintRender.hash })
	if (reserved.length === 0) {
		const [taken] = await db
			.select({ hash: PrintRender.hash })
			.from(PrintRender)
			.where(thisRow)
			.limit(1)
		return taken ? { kind: 'busy' } : { kind: 'limited' }
	}

	const release = () =>
		db.delete(PrintRender).where(and(thisRow, eq(PrintRender.byteLength, 0)))
	try {
		const rendered = await renderPdf(await printDocumentHtml(input))
		if (!rendered.ok) {
			await release()
			return { kind: 'failed' }
		}
		await uploadPrintFile(objectKey, rendered.bytes, 'application/pdf')
		await db
			.update(PrintRender)
			.set({ byteLength: rendered.bytes.byteLength })
			.where(thisRow)
		return { kind: 'pdf', bytes: rendered.bytes, objectKey }
	} catch (error) {
		await release().catch(() => {})
		throw error
	}
}
