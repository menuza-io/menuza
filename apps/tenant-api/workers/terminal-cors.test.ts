import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The Durable Object modules need the Workers runtime; the helper uses neither.
vi.mock('./tenant-org.ts', () => ({
	TenantOrg: class {},
	TENANT_ORG_HEADER: 'x-tenant-org-id',
}))
vi.mock('./tenant-registry.ts', () => ({ TenantRegistry: class {} }))

const { withTerminalCors } = await import('./index.ts')

const TILL = 'https://pos.example.com'

describe('refusals made at the edge', () => {
	let saved: Record<string, string | undefined>
	beforeEach(() => {
		saved = {
			NODE_ENV: process.env.NODE_ENV,
			POS_ORIGINS: process.env.POS_ORIGINS,
		}
		process.env.NODE_ENV = 'production'
		process.env.POS_ORIGINS = TILL
	})
	afterEach(() => {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key]
			else process.env[key] = value
		}
	})

	const refusal = () =>
		Response.json({ error: 'invalid_device' }, { status: 401 })
	const from = (path: string, origin: string) =>
		new Request(`https://us.node.example${path}`, {
			headers: { Origin: origin },
		})

	it('carry CORS for a Station till on its routes, so it can read the code', () => {
		for (const path of ['/pos/me', '/operator/reservations/book/day']) {
			const response = withTerminalCors(from(path, TILL), refusal())
			expect(response.status).toBe(401)
			expect(response.headers.get('Access-Control-Allow-Origin')).toBe(TILL)
		}
	})

	it('never for another origin or another route', () => {
		expect(
			withTerminalCors(
				from('/pos/me', 'https://evil.example'),
				refusal(),
			).headers.get('Access-Control-Allow-Origin'),
		).toBeNull()
		expect(
			withTerminalCors(
				from('/operator/reservations/guests', TILL),
				refusal(),
			).headers.get('Access-Control-Allow-Origin'),
		).toBeNull()
	})
})
