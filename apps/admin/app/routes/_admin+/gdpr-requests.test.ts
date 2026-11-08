import { randomUUID } from 'node:crypto'
import { auditService } from '@repo/audit'
import {
	authSessionStorage,
	getSessionExpirationDate,
	sessionKey,
} from '@repo/auth'
import {
	DataSubjectRequest,
	db,
	eq,
	Organization,
	Role,
	Session,
	User,
	UserOrganization,
	_RoleToUser,
} from '@repo/database'
import { RouterContextProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bindAppService } from '#app/utils/app-service.server.ts'
import { action } from './gdpr-requests.tsx'

type AppCall = { url: string; auth: string | null; body: unknown }
const app = vi.hoisted(() => ({
	calls: [] as AppCall[],
	answer: (() =>
		Response.json({ processed: 1, failed: 0, held: 0, errors: [] })) as () =>
		Response | Promise<Response>,
}))

beforeEach(() => {
	app.calls = []
	app.answer = () =>
		Response.json({ processed: 1, failed: 0, held: 0, errors: [] })
	vi.spyOn(auditService, 'log').mockResolvedValue(undefined)
	vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
		app.calls.push({
			url: String(input),
			auth: new Headers(init?.headers).get('Authorization'),
			body: JSON.parse(String(init?.body ?? 'null')),
		})
		return app.answer()
	})
})

afterEach(() => {
	bindAppService(null)
})

async function createUser() {
	const id = randomUUID()
	const [user] = await db
		.insert(User)
		.values({ username: id, email: `${id}@example.com` })
		.returning()
	if (!user) throw new Error('Test user missing')
	return user
}

async function adminCookie() {
	const admin = await createUser()
	await db
		.insert(Role)
		.values({ name: 'admin', description: 'admin role' })
		.onConflictDoNothing()
	const role = await db.query.Role.findFirst({ where: eq(Role.name, 'admin') })
	await db.insert(_RoleToUser).values({ A: role!.id, B: admin.id })
	const [session] = await db
		.insert(Session)
		.values({ userId: admin.id, expirationDate: getSessionExpirationDate() })
		.returning()
	const authSession = await authSessionStorage.getSession()
	authSession.set(sessionKey, session!.id)
	return authSessionStorage.commitSession(authSession)
}

async function memberOf(
	userId: string,
	options: { dataRegion?: 'us' | 'ksa'; active?: boolean } = {},
) {
	const id = randomUUID()
	const [organization] = await db
		.insert(Organization)
		.values({
			name: `Business ${id.slice(0, 6)}`,
			slug: `org-${id}`,
			dataRegion: options.dataRegion ?? 'us',
			hasProvisionedDb: true,
		})
		.returning()
	await db.insert(UserOrganization).values({
		userId,
		organizationId: organization!.id,
		organizationRoleId: 'org_role_member',
		active: options.active ?? true,
	})
	return organization!.id
}

async function scheduleErasure(userId: string) {
	const [dsr] = await db
		.insert(DataSubjectRequest)
		.values({
			userId,
			type: 'erasure',
			status: 'scheduled',
			scheduledFor: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
		})
		.returning()
	return dsr!
}

async function expedite(requestId: string) {
	const url = 'http://localhost:3004/gdpr-requests'
	return (await action({
		request: new Request(url, {
			method: 'POST',
			headers: { Cookie: await adminCookie() },
			body: new URLSearchParams({ intent: 'expedite', requestId }),
		}),
		params: {},
		context: new RouterContextProvider(),
		url: new URL(url),
		pattern: '/gdpr-requests',
	} as unknown as Parameters<typeof action>[0])) as Response
}

async function readRequest(id: string) {
	const [row] = await db
		.select()
		.from(DataSubjectRequest)
		.where(eq(DataSubjectRequest.id, id))
	return row
}

describe('expedited GDPR erasure', () => {
	it('makes the request due and has the App run it, without deleting the account itself', async () => {
		const user = await createUser()
		await memberOf(user.id)
		const dsr = await scheduleErasure(user.id)

		const response = await expedite(dsr.id)

		expect(response.status).toBe(200)
		expect(app.calls).toHaveLength(1)
		expect(app.calls[0]).toMatchObject({
			body: { requestId: dsr.id },
			auth: expect.stringMatching(/^Bearer .+/),
		})
		expect(app.calls[0]!.url).toMatch(/\/resources\/jobs\/gdpr-erasure$/)
		const stored = await readRequest(dsr.id)
		expect(stored?.status).toBe('scheduled')
		expect(stored!.scheduledFor!.getTime()).toBeLessThanOrEqual(Date.now())
		// The App deletes the account (stubbed here), Admin does not.
		expect(
			await db.select().from(User).where(eq(User.id, user.id)),
		).toHaveLength(1)
	})

	it('reaches the App over its service binding, without following redirects', async () => {
		const user = await createUser()
		const dsr = await scheduleErasure(user.id)
		const binding = {
			fetch: vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
				Response.json({ processed: 1, failed: 0, held: 0, errors: [] }),
			),
		}
		bindAppService(binding)

		const response = await expedite(dsr.id)

		expect(response.status).toBe(200)
		// Not the public URL: on Workers that request would never arrive.
		expect(app.calls).toHaveLength(0)
		expect(binding.fetch).toHaveBeenCalledTimes(1)
		const [url, init] = binding.fetch.mock.calls[0]!
		expect(String(url)).toMatch(/\/resources\/jobs\/gdpr-erasure$/)
		expect(init).toMatchObject({ method: 'POST', redirect: 'manual' })
	})

	it('treats a redirect from the App as a failure', async () => {
		const user = await createUser()
		const dsr = await scheduleErasure(user.id)
		app.answer = () =>
			new Response(null, {
				status: 302,
				headers: { Location: 'https://elsewhere.example/' },
			})

		const response = await expedite(dsr.id)

		expect(response.status).toBe(502)
		expect(app.calls).toHaveLength(1)
	})

	it('reports a hold when the App keeps the request for the sole-admin rule', async () => {
		const user = await createUser()
		const dsr = await scheduleErasure(user.id)
		app.answer = () =>
			Response.json({ processed: 0, failed: 0, held: 1, errors: [] })

		const response = await expedite(dsr.id)

		expect(response.status).toBe(409)
		expect(
			await db.select().from(User).where(eq(User.id, user.id)),
		).toHaveLength(1)
	})

	it('leaves the request due for the job when the App cannot be reached', async () => {
		const user = await createUser()
		const dsr = await scheduleErasure(user.id)
		app.answer = () => {
			throw new TypeError('fetch failed')
		}

		const response = await expedite(dsr.id)

		expect(response.status).toBe(502)
		expect(
			await db.select().from(User).where(eq(User.id, user.id)),
		).toHaveLength(1)
		const stored = await readRequest(dsr.id)
		expect(stored?.status).toBe('scheduled')
		expect(stored!.scheduledFor!.getTime()).toBeLessThanOrEqual(Date.now())
	})

	it('refuses a request that is not a scheduled erasure', async () => {
		const user = await createUser()
		const dsr = await scheduleErasure(user.id)
		await db
			.update(DataSubjectRequest)
			.set({ status: 'cancelled' })
			.where(eq(DataSubjectRequest.id, dsr.id))

		expect((await expedite(dsr.id)).status).toBe(400)
		expect(app.calls).toHaveLength(0)
	})
})
