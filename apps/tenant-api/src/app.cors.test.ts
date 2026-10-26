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
