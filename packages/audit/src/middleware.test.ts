import { beforeEach, describe, expect, it, vi } from 'vitest'

const log = vi.hoisted(() => vi.fn())
vi.mock('./index.ts', () => ({ auditService: { log } }))

const { createAuditMiddleware } = await import('./middleware.ts')

const middleware = createAuditMiddleware({ getUserId: async () => 'user-1' })

describe('audit middleware', () => {
	beforeEach(() => {
		log.mockReset()
		log.mockResolvedValue(undefined)
	})

	it.each([
		'/acme/settings/billing',
		'/acme/settings/api-keys',
		'/acme/settings/members',
		'/acme/settings',
	])('logs access to %s', async (path) => {
		await middleware(new Request(`https://app.test${path}`))
		expect(log).toHaveBeenCalledTimes(1)
		expect(log.mock.calls[0]![0]).toMatchObject({
			userId: 'user-1',
			metadata: { path, method: 'GET' },
		})
	})

	it.each(['/acme/notes', '/acme/settingsx', '/settings', '/login'])(
		'does not log %s',
		async (path) => {
			await middleware(new Request(`https://app.test${path}`))
			expect(log).not.toHaveBeenCalled()
		},
	)

	it('does not log anonymous access', async () => {
		const anon = createAuditMiddleware({ getUserId: async () => null })
		await anon(new Request('https://app.test/acme/settings/billing'))
		expect(log).not.toHaveBeenCalled()
	})

	it('awaits the write and swallows its failure', async () => {
		let done = false
		log.mockImplementation(async () => {
			await new Promise((r) => setTimeout(r, 10))
			done = true
			throw new Error('db down')
		})
		vi.spyOn(console, 'error').mockImplementation(() => {})
		await expect(
			middleware(new Request('https://app.test/acme/settings/billing')),
		).resolves.toBeUndefined()
		expect(done).toBe(true)
	})
})
