import {
	type DeliveryDetail,
	deliveryDetailSchema,
	INVOICE_PHOTO_CONTENT_TYPES,
	INVOICE_PHOTO_MAX_BYTES,
	invoicePhotoUploadSchema,
} from '@repo/inventory'

/**
 * The invoice photo, browser to the region's own storage. Three steps: ask the
 * region for a one-time upload target, PUT the bytes straight there (nothing
 * passes through App), then confirm. The picture is downscaled first so a
 * phone photo is not megabytes. One photo per delivery; a new one replaces
 * the old.
 */

/** Long edge of the uploaded picture, in pixels. */
export const INVOICE_PHOTO_MAX_EDGE = 1600

export type InvoicePhotoErrorCode = 'type' | 'size' | 'upload'

export class InvoicePhotoError extends Error {
	constructor(
		readonly code: InvoicePhotoErrorCode,
		message: string,
	) {
		super(message)
	}
}

type AllowedType = (typeof INVOICE_PHOTO_CONTENT_TYPES)[number]

export function isAllowedInvoicePhotoType(type: string): type is AllowedType {
	return (INVOICE_PHOTO_CONTENT_TYPES as readonly string[]).includes(type)
}

/**
 * The picture as the bytes to upload: a JPEG about 1600 px on its long edge
 * when the browser can draw it, else the file itself. Throws
 * `InvoicePhotoError` for a type that is not JPEG, PNG or WebP, or a result
 * over 5 MB.
 */
export async function prepareInvoicePhoto(
	file: File,
): Promise<{ blob: Blob; contentType: AllowedType }> {
	if (!isAllowedInvoicePhotoType(file.type)) {
		throw new InvoicePhotoError('type', 'Not a JPEG, PNG or WebP picture')
	}
	const scaled = await downscale(file)
	const blob = scaled ?? file
	const contentType = scaled ? 'image/jpeg' : file.type
	if (blob.size > INVOICE_PHOTO_MAX_BYTES || blob.size === 0) {
		throw new InvoicePhotoError('size', 'The picture is too large')
	}
	return { blob, contentType }
}

async function downscale(file: File): Promise<Blob | null> {
	if (
		typeof createImageBitmap !== 'function' ||
		typeof document === 'undefined'
	) {
		return null
	}
	try {
		const bitmap = await createImageBitmap(file)
		const scale = Math.min(
			1,
			INVOICE_PHOTO_MAX_EDGE / Math.max(bitmap.width, bitmap.height),
		)
		// A small picture is uploaded as it is: re-encoding only loses detail.
		if (scale === 1 && file.size <= INVOICE_PHOTO_MAX_BYTES) {
			bitmap.close()
			return null
		}
		const canvas = document.createElement('canvas')
		canvas.width = Math.max(1, Math.round(bitmap.width * scale))
		canvas.height = Math.max(1, Math.round(bitmap.height * scale))
		const context = canvas.getContext('2d')
		if (!context) {
			bitmap.close()
			return null
		}
		context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
		bitmap.close()
		return await new Promise<Blob | null>((resolve) =>
			canvas.toBlob((blob) => resolve(blob), 'image/jpeg', 0.85),
		)
	} catch {
		return null
	}
}

/**
 * Attach `file` to a delivery. `request` is the inventory client (token,
 * region URL and errors); the PUT is a plain `fetch` to the signed URL.
 * Resolves to the delivery as the region now has it.
 */
export async function uploadInvoicePhoto(
	request: (path: string, init?: RequestInit) => Promise<unknown>,
	deliveryId: string,
	file: File,
): Promise<DeliveryDetail> {
	const { blob, contentType } = await prepareInvoicePhoto(file)
	const base = `/deliveries/${encodeURIComponent(deliveryId)}/invoice-photo`
	const target = invoicePhotoUploadSchema.parse(
		await request(base, {
			method: 'POST',
			body: JSON.stringify({ contentType, sizeBytes: blob.size }),
		}),
	)
	let response: Response
	try {
		response = await fetch(target.uploadUrl, {
			method: target.method,
			headers: target.headers,
			body: blob,
		})
	} catch {
		throw new InvoicePhotoError('upload', 'The upload did not reach storage')
	}
	if (!response.ok) {
		throw new InvoicePhotoError('upload', 'Storage refused the upload')
	}
	return deliveryDetailSchema.parse(
		await request(`${base}/confirm`, {
			method: 'POST',
			body: JSON.stringify({ key: target.key }),
		}),
	)
}
