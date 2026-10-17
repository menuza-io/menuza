import { describe, expect, it, vi } from 'vitest'
import {
	normalizeReservationView,
	resendReservationConfirmation,
} from './book-api.ts'
import { type ReservationsScopedClient } from './reservations-client.ts'

function clientReturning(response: unknown) {
	const request = vi.fn(async () => response)
	return {
		client: { scope: 'book', request } as unknown as ReservationsScopedClient,
		request,
	}
}

const BASE = {
	id: 'rsv_1',
	confirmationCode: 'ABC123',
	partySize: 2,
	businessDate: '2026-04-20',
	localStartMin: 1140,
}

describe('resendReservationConfirmation', () => {
	it('posts an empty body for a plain resend', async () => {
		const { client, request } = clientReturning({
			ok: true,
			queued: 1,
			rotated: false,
			reservation: { ...BASE, version: 2 },
		})
		const result = await resendReservationConfirmation(client, 'rsv_1')
		expect(request).toHaveBeenCalledWith(
			'/operator/reservations/book/reservations/rsv_1/resend',
			{ method: 'POST', body: {} },
		)
		expect(result.queued).toBe(1)
		expect(result.rotated).toBe(false)
		expect(result.reservation?.id).toBe('rsv_1')
	})

	it('sends rotate: true when asked to rotate the manage link', async () => {
		const { client, request } = clientReturning({
			ok: true,
			queued: 2,
			rotated: true,
			reservation: { ...BASE, version: 3 },
		})
		const result = await resendReservationConfirmation(client, 'rsv/1', {
			rotate: true,
		})
		expect(request).toHaveBeenCalledWith(
			'/operator/reservations/book/reservations/rsv%2F1/resend',
			{ method: 'POST', body: { rotate: true } },
		)
		expect(result.rotated).toBe(true)
	})

	it('tolerates a response without the reservation', async () => {
		const { client } = clientReturning({ ok: true, queued: 1, rotated: false })
		expect(
			(await resendReservationConfirmation(client, 'rsv_1')).reservation,
		).toBeNull()
	})
})

describe('normalizeReservationView client', () => {
	it('keeps the recorded X-Client value', () => {
		expect(normalizeReservationView({ ...BASE, client: 'ios' }).client).toBe(
			'ios',
		)
	})

	it('is null when the API sends none', () => {
		expect(normalizeReservationView(BASE).client).toBeNull()
		expect(
			normalizeReservationView({ ...BASE, client: '  ' }).client,
		).toBeNull()
	})
})
