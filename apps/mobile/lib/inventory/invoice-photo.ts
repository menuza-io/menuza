import { invoicePhotoUploadSchema } from '@repo/inventory'
import { type RegionClient, RegionError } from './region-client'

/**
 * Attaching an invoice photo to a delivery (#516): ask the region for a signed
 * upload address, send the picture straight to storage, then tell the region it
 * is there. The phone never relays the photo through the US App. Injected
 * `readFile` and `put` keep the three steps testable without a camera.
 */
export type PhotoFile = { uri: string; contentType: string; sizeBytes: number }

export const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const

export async function uploadInvoicePhoto(input: {
	client: RegionClient
	deliveryId: string
	photo: PhotoFile
	/** PUTs the file body to the signed address; resolves with the HTTP status. */
	put: (
		url: string,
		headers: Record<string, string>,
		photo: PhotoFile,
	) => Promise<number>
}): Promise<void> {
	const { client, deliveryId, photo } = input
	if (!(PHOTO_TYPES as readonly string[]).includes(photo.contentType)) {
		throw new RegionError(400, 'unsupported_media_type')
	}
	const base = `/deliveries/${encodeURIComponent(deliveryId)}/invoice-photo`
	const upload = invoicePhotoUploadSchema.parse(
		await client.request(base, {
			method: 'POST',
			write: true,
			body: { contentType: photo.contentType, sizeBytes: photo.sizeBytes },
		}),
	)
	if (photo.sizeBytes > upload.maxBytes) {
		throw new RegionError(413, 'payload_too_large')
	}
	const status = await input.put(upload.uploadUrl, upload.headers, photo)
	if (status < 200 || status >= 300) {
		throw new RegionError(status, 'upload_failed')
	}
	await client.request(`${base}/confirm`, {
		method: 'POST',
		write: true,
		body: { key: upload.key },
	})
}
