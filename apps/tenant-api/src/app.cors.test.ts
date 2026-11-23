import { describe, expect, it } from 'vitest'
import { createTenantApiApp } from './app.ts'

describe('CORS', () => {
	it('lets a POS origin read the Date header on its routes, for clock skew', async () => {
		const app = createTenantApiApp()
		for (const path of ['/pos/me', '/operator/reservations/book/day']) {
			const response = await app.request(path, {
				headers: { Origin: 'http://localhost:3010' },
			})
			expect(response.headers.get('Access-Control-Allow-Origin')).toBe(
				'http://localhost:3010',
			)
			expect(response.headers.get('Access-Control-Expose-Headers')).toBe('Date')
		}
	})

	it('does not expose it to an unknown origin', async () => {
		const app = createTenantApiApp()
		const response = await app.request('/pos/me', {
			headers: { Origin: 'https://evil.example' },
		})
		expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull()
		expect(response.headers.get('Access-Control-Expose-Headers')).toBeNull()
	})
})

describe('body limits', () => {
	it('allows >1 MiB bodies on document/import routes while capping ordinary public routes at 1 MiB', async () => {
		const app = createTenantApiApp()
		const body = 'x'.repeat(1_200_000)

		const blocked = await app.request('/operator/inventory/items', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body,
		})
		expect(blocked.status).toBe(413)

		for (const path of [
			'/operator/inventory/deliveries/invoice/read',
			'/operator/inventory/suppliers/s1/price-list/parse',
			'/operator/inventory/setup/imports',
		]) {
			const res = await app.request(path, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body,
			})
			expect(res.status).not.toBe(413)
		}
	})
})
