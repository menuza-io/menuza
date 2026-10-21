import { RESERVATIONS_PERMISSIONS as P } from '@repo/reservations'
import { describe, expect, it, vi } from 'vitest'

vi.mock('#app/utils/tenant-api.server.ts', () => ({
	resolveRegionalTenantApiUrls: () => ({ tenantApiUrl: 'http://tenant.test' }),
}))

const { mintReservationsToken } = await import('./token.server.ts')

const features = {
	enabled: true,
	online: true,
	waitlist: true,
	payments: false,
	experiences: false,
	voice: false,
}

const mint = (grants: string[]) =>
	mintReservationsToken({
		secret: 'test-operator-secret-with-enough-length',
		organizationId: 'org_1',
		userId: 'usr_1',
		scope: 'book',
		grants: grants as never,
		dataRegion: 'us',
		locationIds: null,
		features,
		impersonated: false,
		nowSeconds: 1_000_000,
	})

describe('reservations token lifetime', () => {
	it('gives a book token that can read guest PII 5 minutes, and a plain one 15', async () => {
		const guest = await mint([P.READ_RESERVATION, P.READ_RESERVATION_GUEST])
		expect(guest.ttlSeconds).toBe(300)
		expect(guest.expiresAt).toBe((1_000_000 + 300) * 1000)
		const plain = await mint([P.READ_RESERVATION])
		expect(plain.ttlSeconds).toBe(900)
	})
})
