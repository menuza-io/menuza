import { INVOICE_PHOTO_CONTENT_TYPES } from '@repo/inventory'

/** The long edge an invoice photo is shrunk to before it is queued (a page of text stays readable). */
export const PHOTO_LONG_EDGE = 1600

export type InvoicePhoto = {
	blob: Blob
	contentType: (typeof INVOICE_PHOTO_CONTENT_TYPES)[number]
}

export class PhotoError extends Error {
	constructor(readonly reason: 'too_large' | 'unreadable') {
		super(reason)
		this.name = 'PhotoError'
	}
}

/** The size that fits `longEdge` on its longest side, never enlarging. */
export function fitSize(
	width: number,
	height: number,
	longEdge = PHOTO_LONG_EDGE,
): { width: number; height: number } {
	const scale = Math.min(1, longEdge / Math.max(width, height, 1))
	return {
		width: Math.max(1, Math.round(width * scale)),
		height: Math.max(1, Math.round(height * scale)),
	}
}

const isAllowedType = (type: string): type is InvoicePhoto['contentType'] =>
	(INVOICE_PHOTO_CONTENT_TYPES as readonly string[]).includes(type)

/**
 * Shrinks a camera photo to JPEG (about 1600 px, quality lowered until it fits
 * the region's limit) so it can wait on the tablet and upload on a poor
 * connection. A browser that cannot decode the picture sends it as it is when
 * it is already a small JPEG, PNG or WebP.
 */
export async function prepareInvoicePhoto(
	file: Blob,
	maxBytes: number,
): Promise<InvoicePhoto> {
	if (
		typeof createImageBitmap === 'function' &&
		typeof document !== 'undefined'
	) {
		try {
			const bitmap = await createImageBitmap(file)
			const size = fitSize(bitmap.width, bitmap.height)
			const canvas = document.createElement('canvas')
			canvas.width = size.width
			canvas.height = size.height
			const context = canvas.getContext('2d')
			if (context) {
				context.drawImage(bitmap, 0, 0, size.width, size.height)
				bitmap.close?.()
				for (const quality of [0.85, 0.7, 0.55, 0.4]) {
					const blob = await new Promise<Blob | null>((resolve) =>
						canvas.toBlob(resolve, 'image/jpeg', quality),
					)
					if (blob && blob.size <= maxBytes)
						return { blob, contentType: 'image/jpeg' }
				}
				throw new PhotoError('too_large')
			}
		} catch (failure) {
			if (failure instanceof PhotoError) throw failure
			/* fall through: send the file as it is when it already fits */
		}
	}
	if (isAllowedType(file.type) && file.size <= maxBytes)
		return { blob: file, contentType: file.type }
	throw new PhotoError(isAllowedType(file.type) ? 'too_large' : 'unreadable')
}
