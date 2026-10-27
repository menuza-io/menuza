import { describe, expect, it } from 'vitest'

import {
	foldQrOrderingFeatures,
	parseQrToken,
	qrPosterUrl,
	qrTableUrl,
	readQrOrderingFeatures,
	serializeQrToken,
} from './qr-ordering.ts'
import { restaurantOrderRequestSchema } from './restaurant-orders.ts'

const mac = 'a'.repeat(64)

describe('QR ordering flags', () => {
	it('counts only literal true and needs the master for every child', () => {
		expect(
			foldQrOrderingFeatures({ enabled: true, dineIn: true, online: true }),
		).toEqual({ enabled: true, dineIn: true, online: true })
		expect(
			foldQrOrderingFeatures({
				'qr_ordering.enabled': 'true',
				'qr_ordering.dine_in': true,
			}),
		).toEqual({ enabled: false, dineIn: false, online: false })
		expect(
			foldQrOrderingFeatures({ enabled: true, dineIn: false, online: true }),
		).toEqual({ enabled: true, dineIn: false, online: false })
	})

	it('reads a malformed context block as off', () => {
		for (const raw of [undefined, null, 'yes', { enabled: true }, []]) {
			expect(readQrOrderingFeatures(raw)).toEqual({
				enabled: false,
				dineIn: false,
				online: false,
			})
		}
	})
})

describe('QR tokens and URLs', () => {
	it('round-trips a token and refuses anything malformed', () => {
		const token = serializeQrToken('tbl-1', 3, mac)
		expect(parseQrToken(token)).toEqual({ id: 'tbl-1', version: 3, mac })
		for (const raw of [
			'',
			'tbl-1.0.' + mac,
			'tbl-1.3.' + mac.slice(1),
			'tbl 1.3.' + mac,
			`tbl-1.3.${mac}.x`,
			'x'.repeat(200),
			42,
		]) {
			expect(parseQrToken(raw)).toBeNull()
		}
	})

	it('puts the table token in the fragment, never the query', () => {
		const url = new URL(
			qrTableUrl('https://acme.example.com', 'loc-1', 'tok.1.abc', {
				utm_source: 'print',
			}),
		)
		expect(url.pathname).toBe('/menu')
		expect(url.searchParams.get('location')).toBe('loc-1')
		expect(url.searchParams.get('utm_source')).toBe('print')
		expect(url.search).not.toContain('tok')
		expect(url.hash).toBe('#table=tok.1.abc')
		const poster = new URL(qrPosterUrl('https://acme.example.com', 'loc-1'))
		expect(poster.searchParams.get('src')).toBe('qr')
		expect(poster.hash).toBe('')
	})
})

describe('dine-in order requests', () => {
	const base = {
		idempotencyKey: '7b0c6a8e-2f39-4d1b-9a55-3c1b8f5d0e11',
		locationId: 'loc-1',
		fulfillment: 'dine_in',
		paymentMethod: 'handoff',
		contact: {},
		lines: [{ itemId: 'item-1', quantity: 1 }],
	}

	it('accepts a round with no contact', () => {
		expect(restaurantOrderRequestSchema.safeParse(base).success).toBe(true)
	})

	it('still requires name and phone for pickup', () => {
		const pickup = restaurantOrderRequestSchema.safeParse({
			...base,
			fulfillment: 'pickup',
		})
		expect(pickup.success).toBe(false)
	})

	it('refuses tips, prepay, drops, delivery and a poster source at the table', () => {
		for (const extra of [
			{ tipPercent: 5 },
			{ paymentMethod: 'online' },
			{ dropSlug: 'friday', pickup: { windowId: 'w', time: '12:00' } },
			{ delivery: { address: '1 Main Street', city: 'Town' } },
			{ source: 'qr_poster' },
		]) {
			expect(
				restaurantOrderRequestSchema.safeParse({ ...base, ...extra }).success,
			).toBe(false)
		}
	})
})
