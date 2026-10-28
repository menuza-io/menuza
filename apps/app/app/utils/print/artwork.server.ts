import crypto from 'node:crypto'
import {
	PRINT_DEFAULT_BLEED_MM,
	printArtworkFit,
	type PrintArtwork,
} from '@repo/common/print-shop'
import { printCatalog } from '@repo/common/print-shop-catalog'
import { readPrintFile, uploadPrintFile } from '#app/utils/storage.server.ts'
import { type PrintShopAccess } from './access.server.ts'
import {
	CanvaError,
	downloadCanvaFile,
	type CanvaApi,
} from './canva/client.server.ts'
import { withCanva } from './canva/connection.server.ts'
import { isCanvaMock } from './canva/env.server.ts'
import { readPdfPageSize } from './canva/pdf-size.ts'
import {
	approvedSnapshot,
	createArtworkDesign,
	currentSnapshot,
	toDesignView,
	updateArtworkDesign,
	type PrintDesignRow,
} from './designs.server.ts'
import { getPrintFile } from './print-files.server.ts'
import { printVertical } from './vertical.server.ts'

/**
 * Finished files ("artwork"): a design made elsewhere, printed as it is.
 * Canva is the provider today: page 1 is exported as a PDF (what prints)
 * and a PNG (the proof), both kept in the platform bucket, and the page
 * size must be the product's, with or without an even bleed. The other way
 * round, a template design can be sent to Canva as a new Canva design.
 */

export type PrintArtworkErrorCode =
	| 'canva_not_connected'
	| 'canva_unavailable'
	| 'canva_rate_limited'
	| 'canva_license'
	| 'canva_not_found'
	| 'artwork_product'
	| 'artwork_size'
	| 'artwork_too_large'
	| 'artwork_unreadable'
	| 'codes_private'
	| 'renderer_missing'
	| 'render_limited'
	| 'render_failed'

export class PrintArtworkError extends Error {
	constructor(readonly code: PrintArtworkErrorCode) {
		super(code)
		this.name = 'PrintArtworkError'
	}
}

/** Maps a Canva failure to what the operator is told. */
function fromCanva(error: unknown): never {
	if (error instanceof PrintArtworkError) throw error
	if (error instanceof CanvaError) {
		switch (error.code) {
			case 'unauthorized':
			case 'invalid_grant':
				throw new PrintArtworkError('canva_not_connected')
			case 'not_found':
				throw new PrintArtworkError('canva_not_found')
			case 'license_required':
				throw new PrintArtworkError('canva_license')
			case 'rate_limited':
				throw new PrintArtworkError('canva_rate_limited')
			case 'too_large':
				throw new PrintArtworkError('artwork_too_large')
			default:
				throw new PrintArtworkError('canva_unavailable')
		}
	}
	throw error
}

export async function artworkPreviewDataUri(
	artwork: Pick<PrintArtwork, 'previewKey'>,
): Promise<string | null> {
	if (!artwork.previewKey) return null
	const bytes = await readPrintFile(artwork.previewKey)
	return bytes
		? `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`
		: null
}

/** Page 1 as PDF: pro quality first, regular when Canva wants a license. */
async function exportPdf(api: CanvaApi, designId: string) {
	try {
		return await api.exportFirstPage(designId, { type: 'pdf', quality: 'pro' })
	} catch (error) {
		if (error instanceof CanvaError && error.code === 'license_required') {
			return api.exportFirstPage(designId, { type: 'pdf', quality: 'regular' })
		}
		throw error
	}
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function isPng(bytes: Uint8Array) {
	return PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)
}

async function fetchArtwork(
	access: PrintShopAccess,
	input: { designId: string; product: string; sizeKey: string },
): Promise<PrintArtwork> {
	const size = printCatalog.getSize(input.product, input.sizeKey)
	if (!size || !printCatalog.acceptsArtwork(input.product)) {
		throw new PrintArtworkError('artwork_product')
	}
	const { design, pdf, png } = await withCanva(access, async (api) => {
		const design = await api.getDesign(input.designId)
		const pdfUrl = await exportPdf(api, input.designId)
		const pngUrl = await api
			.exportFirstPage(input.designId, { type: 'png', width: 1200 })
			.catch(() => null)
		const pdf = await downloadCanvaFile(pdfUrl)
		const png = pngUrl
			? await downloadCanvaFile(pngUrl, { maxBytes: 8 * 1024 * 1024 }).catch(
					() => null,
				)
			: null
		return { design, pdf, png }
	}).catch(fromCanva)

	if (new TextDecoder().decode(pdf.bytes.slice(0, 5)) !== '%PDF-') {
		throw new PrintArtworkError('artwork_unreadable')
	}
	// The page as exported (page tree, inherited boxes, rotation). Without a
	// readable size the file is refused: a thumbnail's shape cannot tell A4
	// from A3, nor show a bleed.
	const page = readPdfPageSize(pdf.bytes)?.media
	if (!page) throw new PrintArtworkError('artwork_unreadable')
	const fit = printArtworkFit(size, page)
	if (!fit.fits) throw new PrintArtworkError('artwork_size')

	// Content-addressed: the same file is stored once per organization, and
	// designs with identical bytes share it. Print files are never deleted
	// (updates and archiving leave them), so a shared key cannot break a
	// design; any future cleanup must check every PrintDesign and order first.
	const fileHash = crypto.createHash('sha256').update(pdf.bytes).digest('hex')
	const folder = `print/${access.organization.id}/artwork/${fileHash.slice(0, 32)}`
	await uploadPrintFile(`${folder}/print.pdf`, pdf.bytes, 'application/pdf')
	// The proof is shown inline, so its bytes must really be a PNG.
	const previewKey = png && isPng(png.bytes) ? `${folder}/preview.png` : null
	if (previewKey && png)
		await uploadPrintFile(previewKey, png.bytes, 'image/png')
	return {
		provider: 'canva',
		externalId: design.id,
		title: design.title.slice(0, 255),
		fileKey: `${folder}/print.pdf`,
		previewKey,
		fileHash,
		pages: Math.max(1, design.pageCount ?? 1),
		widthMm: Math.round(page.widthMm * 10) / 10,
		heightMm: Math.round(page.heightMm * 10) / 10,
		bleedMm: fit.bleedMm,
		importedAt: new Date().toISOString(),
	}
}

/** A new print from one of the member's Canva designs. */
export async function importCanvaArtwork(
	access: PrintShopAccess,
	input: { designId: string; product: string; sizeKey: string; name: string },
) {
	const artwork = await fetchArtwork(access, input)
	return createArtworkDesign(access, {
		name: input.name,
		product: input.product,
		sizeKey: input.sizeKey,
		artwork,
	})
}

/** The latest version of the same Canva design (back to draft). */
export async function refreshCanvaArtwork(
	access: PrintShopAccess,
	row: PrintDesignRow,
) {
	const view = toDesignView(row)
	if (view.source !== 'artwork' || !view.artwork) {
		throw new PrintArtworkError('artwork_product')
	}
	const artwork = await fetchArtwork(access, {
		designId: view.artwork.externalId,
		product: view.product,
		sizeKey: view.sizeKey,
	})
	return updateArtworkDesign(row, { name: view.name, artwork })
}

/** A fresh link to edit the design in Canva (links expire). */
export async function canvaEditUrl(
	access: PrintShopAccess,
	row: PrintDesignRow,
): Promise<string> {
	const view = toDesignView(row)
	if (!view.artwork) throw new PrintArtworkError('artwork_product')
	const design = await withCanva(access, (api) =>
		api.getDesign(view.artwork!.externalId),
	).catch(fromCanva)
	if (!design.editUrl) throw new PrintArtworkError('canva_not_found')
	return design.editUrl
}

/**
 * Sends a template design to Canva as a new design (the print-shop PDF,
 * with bleed) and returns its edit link. Codes that are capabilities (the
 * vertical's `canView`) never leave the App, so such prints are refused.
 */
export async function sendDesignToCanva(
	request: Request,
	access: PrintShopAccess,
	row: PrintDesignRow,
): Promise<string> {
	const view = toDesignView(row)
	if (view.source === 'artwork') throw new PrintArtworkError('artwork_product')
	if (printVertical.qrTargets?.[view.content.qr.kind]?.canView) {
		throw new PrintArtworkError('codes_private')
	}
	const snapshot =
		approvedSnapshot(row) ?? (await currentSnapshot(request, access, row))
	const file = await getPrintFile({
		organizationId: access.organization.id,
		snapshot,
		format: 'pro',
		bleedMm: PRINT_DEFAULT_BLEED_MM,
	})
	let bytes: Uint8Array<ArrayBuffer>
	if (file.kind === 'pdf') bytes = file.bytes
	else if (file.kind === 'html' && isCanvaMock()) {
		// Local emulator without a PDF renderer: the page stands in.
		bytes = new Uint8Array(new TextEncoder().encode(file.html))
	} else if (file.kind === 'html') {
		throw new PrintArtworkError('renderer_missing')
	} else if (file.kind === 'limited') {
		throw new PrintArtworkError('render_limited')
	} else {
		throw new PrintArtworkError('render_failed')
	}
	// Never sent twice: a retried import could make a second Canva design.
	const imported = await withCanva(
		access,
		(api) => api.importPdf(bytes, view.name),
		{ idempotent: false },
	).catch(fromCanva)
	if (!imported.editUrl) throw new PrintArtworkError('canva_unavailable')
	return imported.editUrl
}
