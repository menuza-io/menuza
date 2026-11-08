import { randomUUID } from 'node:crypto'
import {
	authSessionStorage,
	getSessionExpirationDate,
	sessionKey,
} from '@repo/auth'
import { db, eq, Role, Session, User, _RoleToUser } from '@repo/database'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindAppService } from '#app/utils/app-service.server.ts'
import { action } from './print-shop.server.ts'

afterEach(() => {
	bindAppService(null)
})

async function adminCookie() {
	const id = randomUUID()
	const [admin] = await db
		.insert(User)
		.values({ username: id, email: `${id}@example.com` })
		.returning()
	await db
		.insert(Role)
		.values({ name: 'admin', description: 'admin role' })
		.onConflictDoNothing()
	const role = await db.query.Role.findFirst({ where: eq(Role.name, 'admin') })
	await db.insert(_RoleToUser).values({ A: role!.id, B: admin!.id })
	const [session] = await db
		.insert(Session)
		.values({ userId: admin!.id, expirationDate: getSessionExpirationDate() })
		.returning()
	const authSession = await authSessionStorage.getSession()
	authSession.set(sessionKey, session!.id)
	return authSessionStorage.commitSession(authSession)
}

async function refund(orderId: string) {
	const url = 'http://localhost:3005/print-shop'
	return action({
		request: new Request(url, {
			method: 'POST',
			headers: { Cookie: await adminCookie() },
			body: new URLSearchParams({ _action: 'refund', orderId }),
		}),
		params: {},
		context: {},
	} as unknown as Parameters<typeof action>[0])
}

describe('print shop commands to the App', () => {
	it('go over the APP service binding, never following a redirect', async () => {
		const binding = {
			fetch: vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
				Response.json({ ok: true }),
			),
		}
		const fetchSpy = vi.spyOn(globalThis, 'fetch')
		bindAppService(binding)

		await expect(refund('po_1')).resolves.toEqual({
			ok: true,
			done: 'refunded',
		})

		expect(fetchSpy).not.toHaveBeenCalled()
		const [url, init] = binding.fetch.mock.calls[0]!
		expect(String(url)).toMatch(/\/resources\/print\/admin-command$/)
		expect(init).toMatchObject({ method: 'POST', redirect: 'manual' })
		expect(JSON.parse(String(init?.body))).toMatchObject({
			action: 'refund',
			orderId: 'po_1',
		})
	})

	it('report a redirect as an error instead of following it', async () => {
		bindAppService({
			fetch: vi.fn(
				async () =>
					new Response(null, {
						status: 302,
						headers: { Location: 'https://elsewhere.example/' },
					}),
			),
		})

		await expect(refund('po_1')).resolves.toMatchObject({
			ok: false,
			code: 'app_error',
		})
	})

	it('report an App that does not answer', async () => {
		bindAppService({
			fetch: vi.fn(async () => {
				throw new TypeError('fetch failed')
			}),
		})

		await expect(refund('po_1')).resolves.toMatchObject({
			ok: false,
			code: 'app_unreachable',
		})
	})
})
