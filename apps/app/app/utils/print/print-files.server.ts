import crypto from 'node:crypto'
import {
	PRINT_DEFAULT_BLEED_MM,
	type PrintDownloadFormat,
	type PrintHomeSheet,
	type PrintSnapshot,
} from '@repo/common/print-shop'
import { and, count, db, eq, gte, PrintRender } from '@repo/database'
import { readPrintFile, uploadPrintFile } from '#app/utils/storage.server.ts'
import {
	isPdfRendererConfigured,
	renderLimitPerHour,
	renderPdf,
} from './pdf-renderer.server.ts'
import { renderPrintHtml } from './print-document.server.tsx'
import { qrSvgsFor, snapshotHash } from './print-snapshot.server.ts'

/**
 * Print files: a PDF is rendered once per distinct input (template version,
 * snapshot, format, sheet, bleed) and kept in object storage; the same input
 * is served from the cache and does not count against the hourly limit.
 */

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
): Promise<PrintFileResult> {
	const hash = printFileHash(input)
	const [cached] = await db
		.select({ objectKey: PrintRender.objectKey })
		.from(PrintRender)
		.where(
			and(
				eq(PrintRender.hash, hash),
				eq(PrintRender.organizationId, input.organizationId),
			),
		)
		.limit(1)
	if (cached) {
		const bytes = await readPrintFile(cached.objectKey)
		if (bytes) return { kind: 'pdf', bytes, objectKey: cached.objectKey }
		await db.delete(PrintRender).where(eq(PrintRender.hash, hash))
	}

	if (!isPdfRendererConfigured()) {
		const nonce = crypto.randomBytes(16).toString('base64')
		return {
			kind: 'html',
			nonce,
			html: await printDocumentHtml({ ...input, autoPrint: true, nonce }),
		}
	}

	const [recent] = await db
		.select({ value: count() })
		.from(PrintRender)
		.where(
			and(
				eq(PrintRender.organizationId, input.organizationId),
				gte(PrintRender.createdAt, new Date(Date.now() - 3_600_000)),
			),
		)
	if (Number(recent?.value ?? 0) >= renderLimitPerHour()) {
		return { kind: 'limited' }
	}

	const rendered = await renderPdf(await printDocumentHtml(input))
	if (!rendered.ok) return { kind: 'failed' }
	const objectKey = `print/${input.organizationId}/${hash}.pdf`
	await uploadPrintFile(objectKey, rendered.bytes, 'application/pdf')
	await db
		.insert(PrintRender)
		.values({
			hash,
			organizationId: input.organizationId,
			objectKey,
			byteLength: rendered.bytes.byteLength,
		})
		.onConflictDoNothing()
	return { kind: 'pdf', bytes: rendered.bytes, objectKey }
}
