import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	InvoicePhotoError,
	isAllowedInvoicePhotoType,
	prepareInvoicePhoto,
	uploadInvoicePhoto,
} from './invoice-photo.ts'

function picture(type = 'image/jpeg', size = 1000) {
	return new File([new Uint8Array(size)], 'invoice', { type })
}

const DELIVERY = {
	id: 'd1',
	locationId: 'main',
	supplierId: 's1',
	supplierName: 'Al Watania',
	status: 'received',
	invoiceNumber: null,
	invoiceDate: null,
	businessDate: '2026-11-09',
	source: 'operator',
	receivedAt: 1,
	receivedBy: { kind: 'operator', id: 'u1' },
	lineCount: 1,
	paid: false,
	paidAt: null,
	version: 2,
	zatcaReference: null,
	lines: [],
	hasPhoto: true,
	photo: {
		url: 'https://files.example/p.jpg',
		expiresAt: 9,
		contentType: 'image/jpeg',
	},
}

afterEach(() => {
	vi.unstubAllGlobals()
})

describe('invoice photo', () => {
	it('accepts JPEG, PNG and WebP only', () => {
		expect(
			[
				'image/jpeg',
				'image/png',
				'image/webp',
				'image/gif',
				'application/pdf',
			].map(isAllowedInvoicePhotoType),
		).toEqual([true, true, true, false, false])
	})

	it('refuses another type and a picture over 5 MB, in a way the screen can word', async () => {
		await expect(
			prepareInvoicePhoto(picture('image/gif')),
		).rejects.toMatchObject({
			code: 'type',
		})
		await expect(
			prepareInvoicePhoto(picture('image/png', 6 * 1024 * 1024)),
		).rejects.toBeInstanceOf(InvoicePhotoError)
	})

	it('asks for an upload target, puts the bytes straight there, then confirms', async () => {
		const request = vi.fn(async (path: string) =>
			path.endsWith('/confirm')
				? DELIVERY
				: {
						key: 'inventory-invoices/o/d1/abc.jpg',
						method: 'PUT',
						uploadUrl: 'https://files.example/upload?sig=1',
						headers: { 'Content-Type': 'image/jpeg', 'Content-Length': '1000' },
						expiresAt: 5,
						maxBytes: 5_242_880,
					},
		)
		const put = vi.fn(async () => new Response(null, { status: 200 }))
		vi.stubGlobal('fetch', put)

		const delivery = await uploadInvoicePhoto(request, 'd1', picture())

		expect(request.mock.calls[0]).toEqual([
			'/deliveries/d1/invoice-photo',
			{
				method: 'POST',
				body: JSON.stringify({ contentType: 'image/jpeg', sizeBytes: 1000 }),
			},
		])
		expect(put).toHaveBeenCalledWith(
			'https://files.example/upload?sig=1',
			expect.objectContaining({
				method: 'PUT',
				headers: { 'Content-Type': 'image/jpeg', 'Content-Length': '1000' },
			}),
		)
		expect(request.mock.calls[1]).toEqual([
			'/deliveries/d1/invoice-photo/confirm',
			{
				method: 'POST',
				body: JSON.stringify({ key: 'inventory-invoices/o/d1/abc.jpg' }),
			},
		])
		expect(delivery.photo?.url).toBe('https://files.example/p.jpg')
	})

	it('does not confirm a photo storage refused', async () => {
		const request = vi.fn(async () => ({
			key: 'k',
			method: 'PUT',
			uploadUrl: 'https://files.example/upload',
			headers: {},
			expiresAt: 5,
			maxBytes: 5_242_880,
		}))
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(null, { status: 403 })),
		)
		await expect(
			uploadInvoicePhoto(request, 'd1', picture()),
		).rejects.toMatchObject({
			code: 'upload',
		})
		expect(request).toHaveBeenCalledTimes(1)
	})
})
