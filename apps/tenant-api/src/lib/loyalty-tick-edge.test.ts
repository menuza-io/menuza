import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type TenantApiWorkerEnv } from '../../workers/bindings.ts'

const findOrg = vi.hoisted(() => vi.fn())

// The Durable Object classes extend `DurableObject` from `cloudflare:workers`,
// which only exists inside workerd. The edge handler only needs their names.
vi.mock('../../workers/tenant-org.ts', () => ({
	TENANT_ORG_HEADER: 'X-Epic-Tenant-Org-Id',
	TenantOrg: class {},
}))
vi.mock('../../workers/tenant-registry.ts', () => ({
	TenantRegistry: class {},
}))
vi.mock('../app.ts', () => ({
	createTenantApiApp: () => ({
		fetch: async () => new Response('edge-app', { status: 200 }),
	}),
}))
vi.mock('../restaurant/staffing-order-source.ts', () => ({
	registerRestaurantOrderSource: () => {},
}))
vi.mock('./origin.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('./origin.ts')>()),
	findActiveOrganizationById: findOrg,
}))

const { default: worker } = await import('../../workers/index.ts')

const TOKEN = 'i'.repeat(32)
const ORG_A = 'clw9x0a12000008l00ltyorga'
const ORG_B = 'clw9x0a12000008l00ltyorgb'
const ORG_C = 'clw9x0a12000008l00ltyorgc'

type Forwarded = { orgId: string; header: string | null; request: Request }

function makeEnv(overrides: Partial<TenantApiWorkerEnv> = {}) {
	const forwarded: Forwarded[] = []
	const orgFetch = vi.fn(
		async (_orgId: string, _request: Request): Promise<Response> =>
			Response.json({ result: null }),
	)
	const list = vi.fn(async () => [ORG_A, ORG_B, ORG_C])
	const env = {
		TENANT_API_RUNTIME: 'workers',
		DATA_REGION: 'us',
		JWT_SECRET: 'j'.repeat(32),
		AUTH_HMAC_SECRET: 'h'.repeat(32),
		INTERNAL_COMMAND_TOKEN: TOKEN,
		TENANT_OPERATOR_TOKEN: 'o'.repeat(32),
		TENANT_REGISTRY: {
			idFromName: (name: string) => name,
			get: () => ({ list }),
		},
		TENANT_ORG: {
			idFromName: (name: string) => name,
			get: (orgId: string) => ({
				fetch: async (request: Request) => {
					forwarded.push({
						orgId,
						header: request.headers.get('X-Epic-Tenant-Org-Id'),
						request,
					})
					return orgFetch(orgId, request.clone())
				},
			}),
		},
		...overrides,
	} as unknown as TenantApiWorkerEnv
	return { env, forwarded, orgFetch, list }
}

function loyaltyResult() {
	return {
		holdsReleased: 2,
		approvalsExpired: 1,
		outboxProcessed: 1,
		outboxFailed: 0,
		outboxParked: 0,
		outboxParkedTotal: 2,
		uploadsMissing: 1,
		uploadsMissingTotal: 1,
		needsFollowUp: false,
		nextDueAt: null,
	}
}

function post(
	path: string,
	body: unknown,
	headers: Record<string, string> = { Authorization: `Bearer ${TOKEN}` },
) {
	return new Request(`https://api.test${path}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', ...headers },
		body: typeof body === 'string' ? body : JSON.stringify(body),
	})
}

const ctx = {} as ExecutionContext

describe('loyalty tick on the Workers edge', () => {
	beforeEach(() => {
		vi.stubEnv('INTERNAL_COMMAND_TOKEN', TOKEN)
		vi.stubEnv('TENANT_OPERATOR_TOKEN', 'o'.repeat(32))
		vi.stubEnv('JWT_SECRET', 'j'.repeat(32))
		vi.stubEnv('AUTH_HMAC_SECRET', 'h'.repeat(32))
		findOrg.mockReset()
		findOrg.mockImplementation(async (id: string) => ({
			id,
			dataRegion: 'us',
		}))
	})

	afterEach(() => {
		vi.unstubAllEnvs()
	})

	describe('a tick that names an organization', () => {
		it('forwards to that organization Durable Object with the org header', async () => {
			const { env, forwarded, orgFetch, list } = makeEnv()
			orgFetch.mockResolvedValue(Response.json({ ok: true }))
			const res = await worker.fetch(
				post('/api/loyalty/tick', { orgId: ORG_B }),
				env,
				ctx,
			)
			expect(res.status).toBe(200)
			expect(await res.json()).toEqual({ ok: true })
			expect(forwarded).toHaveLength(1)
			expect(forwarded[0]).toMatchObject({ orgId: ORG_B, header: ORG_B })
			expect(list).not.toHaveBeenCalled()
		})

		it('keeps the caller bearer token and body intact when forwarding', async () => {
			const { env, forwarded, orgFetch } = makeEnv()
			await worker.fetch(post('/api/loyalty/tick', { orgId: ORG_A }), env, ctx)
			const [{ request }] = forwarded
			expect(request.headers.get('Authorization')).toBe(`Bearer ${TOKEN}`)
			const seen = orgFetch.mock.calls[0]![1]
			expect(await seen.json()).toEqual({ orgId: ORG_A })
		})

		it('does not check the token at the edge (the Durable Object does)', async () => {
			const { env, forwarded } = makeEnv()
			const res = await worker.fetch(
				post('/api/loyalty/tick', { orgId: ORG_A }, {}),
				env,
				ctx,
			)
			expect(res.status).toBe(200)
			expect(forwarded).toHaveLength(1)
		})

		it('refuses an organization that lives in another region with 409', async () => {
			findOrg.mockResolvedValue({ id: ORG_A, dataRegion: 'ksa' })
			const { env, forwarded } = makeEnv()
			const res = await worker.fetch(
				post('/api/loyalty/tick', { orgId: ORG_A }),
				env,
				ctx,
			)
			expect(res.status).toBe(409)
			expect(await res.json()).toMatchObject({
				error: 'region_mismatch',
				orgRegion: 'ksa',
				nodeRegion: 'us',
			})
			expect(forwarded).toHaveLength(0)
		})

		it('checks the region of the organization it was asked about', async () => {
			const { env } = makeEnv()
			await worker.fetch(post('/api/loyalty/tick', { orgId: ORG_B }), env, ctx)
			expect(findOrg).toHaveBeenCalledTimes(1)
			expect(findOrg).toHaveBeenCalledWith(ORG_B)
		})

		it('forwards an organization the control plane does not know on Workers', async () => {
			findOrg.mockResolvedValue(null)
			const { env, forwarded } = makeEnv()
			const res = await worker.fetch(
				post('/api/loyalty/tick', { orgId: ORG_A }),
				env,
				ctx,
			)
			expect(res.status).toBe(200)
			expect(forwarded).toHaveLength(1)
		})

		it('answers 404 for an unknown organization off the Workers runtime', async () => {
			findOrg.mockResolvedValue(null)
			const { env, forwarded } = makeEnv({ TENANT_API_RUNTIME: 'node' })
			const res = await worker.fetch(
				post('/api/loyalty/tick', { orgId: ORG_A }),
				env,
				ctx,
			)
			expect(res.status).toBe(404)
			expect(forwarded).toHaveLength(0)
		})

		it('does not use fan-out for a malformed orgId: it is a 400, not run everyone', async () => {
			const { env, forwarded, list } = makeEnv()
			const res = await worker.fetch(
				post('/api/loyalty/tick', { orgId: '../../etc' }),
				env,
				ctx,
			)
			expect(res.status).toBe(400)
			expect(forwarded).toHaveLength(0)
			expect(list).not.toHaveBeenCalled()
		})

		it('ignores an orgId in the query string', async () => {
			const { env, forwarded } = makeEnv()
			const res = await worker.fetch(
				post(`/api/loyalty/tick?orgId=${ORG_A}`, {}),
				env,
				ctx,
			)
			expect(res.status).toBe(200)
			// The stub objects answer with no result, so each counts as an error.
			expect(await res.json()).toMatchObject({ orgs: 0, errors: 3 })
			// The walk starts at a different organization each hour.
			expect(forwarded.map((f) => f.orgId).sort()).toEqual([
				ORG_A,
				ORG_B,
				ORG_C,
			])
		})
	})

	describe('a tick with no organization (the hourly fan-out)', () => {
		it('asks every registered organization to run its own tick and folds the answers', async () => {
			const { env, forwarded, orgFetch, list } = makeEnv()
			orgFetch.mockImplementation(async () =>
				Response.json({ success: true, result: loyaltyResult() }),
			)
			const res = await worker.fetch(post('/api/loyalty/tick', {}), env, ctx)
			expect(res.status).toBe(200)
			expect(await res.json()).toEqual({
				success: true,
				orgs: 3,
				errors: 0,
				orgsDeferred: 0,
				holdsReleased: 6,
				approvalsExpired: 3,
				outboxProcessed: 3,
				outboxFailed: 0,
				outboxParked: 0,
				outboxParkedTotal: 6,
				uploadsMissing: 3,
				uploadsMissingTotal: 3,
			})
			expect(list).toHaveBeenCalledTimes(1)
			expect(forwarded.map((f) => f.orgId).sort()).toEqual([
				ORG_A,
				ORG_B,
				ORG_C,
			])
			for (const f of forwarded) expect(f.header).toBe(f.orgId)
		})

		it('forwards a POST to the loyalty tick path with the internal token and its own orgId', async () => {
			const { env, forwarded, orgFetch } = makeEnv()
			await worker.fetch(post('/api/loyalty/tick', {}), env, ctx)
			for (const f of forwarded) {
				expect(f.request.method).toBe('POST')
				expect(new URL(f.request.url).pathname).toBe('/api/loyalty/tick')
				expect(f.request.headers.get('Authorization')).toBe(`Bearer ${TOKEN}`)
			}
			const bodies = await Promise.all(
				orgFetch.mock.calls.map(([, r]) => r.json()),
			)
			expect(bodies.map((b: { orgId: string }) => b.orgId).sort()).toEqual([
				ORG_A,
				ORG_B,
				ORG_C,
			])
		})

		it('does not run the region check per organization when fanning out', async () => {
			const { env } = makeEnv()
			await worker.fetch(post('/api/loyalty/tick', {}), env, ctx)
			expect(findOrg).not.toHaveBeenCalled()
		})

		it('accepts an empty body and a body that is not JSON as "run everyone"', async () => {
			for (const body of ['', 'not json']) {
				const { env, forwarded } = makeEnv()
				const res = await worker.fetch(
					post('/api/loyalty/tick', body),
					env,
					ctx,
				)
				expect(res.status).toBe(200)
				expect(forwarded).toHaveLength(3)
			}
		})

		it('rejects a body that names an organization as null with 400', async () => {
			const { env, forwarded, list } = makeEnv()
			const res = await worker.fetch(
				post('/api/loyalty/tick', { orgId: null }),
				env,
				ctx,
			)
			expect(res.status).toBe(400)
			expect(await res.json()).toEqual({ error: 'Invalid payload' })
			expect(forwarded).toHaveLength(0)
			expect(list).not.toHaveBeenCalled()
		})

		it('rejects a body that is not an object with 400', async () => {
			const { env, list } = makeEnv()
			const res = await worker.fetch(
				post('/api/loyalty/tick', [1, 2]),
				env,
				ctx,
			)
			expect(res.status).toBe(400)
			expect(list).not.toHaveBeenCalled()
		})

		it('answers 401 without the internal token and touches no organization', async () => {
			for (const headers of [
				{},
				{ Authorization: 'Bearer wrong-token-wrong-token' },
				{ Authorization: `Basic ${TOKEN}` },
			] as Record<string, string>[]) {
				const { env, forwarded, list } = makeEnv()
				const res = await worker.fetch(
					post('/api/loyalty/tick', {}, headers),
					env,
					ctx,
				)
				expect(res.status).toBe(401)
				expect(forwarded).toHaveLength(0)
				expect(list).not.toHaveBeenCalled()
			}
		})

		it('refuses to serve at all when the internal token is too short', async () => {
			// The per-request secret assertion runs before routing, so the tick
			// handler's own 503 for a short token is a second line of defence that a
			// request can never reach.
			vi.stubEnv('INTERNAL_COMMAND_TOKEN', 'short')
			const { env, list, forwarded } = makeEnv({
				INTERNAL_COMMAND_TOKEN: 'short',
			})
			await expect(
				worker.fetch(post('/api/loyalty/tick', {}), env, ctx),
			).rejects.toThrow(/INTERNAL_COMMAND_TOKEN/)
			expect(list).not.toHaveBeenCalled()
			expect(forwarded).toHaveLength(0)
		})

		it('counts an organization that answers non-2xx as an error, logs it, and goes on', async () => {
			const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
			const { env, orgFetch } = makeEnv()
			orgFetch.mockImplementation(async (orgId) =>
				orgId === ORG_B
					? new Response('nope', { status: 500 })
					: Response.json({ result: loyaltyResult() }),
			)
			const res = await worker.fetch(post('/api/loyalty/tick', {}), env, ctx)
			expect(res.status).toBe(200)
			expect(await res.json()).toMatchObject({
				success: false,
				errors: 1,
				orgs: 2,
				holdsReleased: 4,
			})
			expect(spy).toHaveBeenCalledWith(
				'Tick fan-out (loyalty) failed for organization',
				ORG_B,
				500,
			)
			spy.mockRestore()
		})

		it('counts an organization whose Durable Object throws, and logs it', async () => {
			const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
			const { env, orgFetch } = makeEnv()
			orgFetch.mockImplementation(async (orgId) => {
				if (orgId === ORG_C) throw new Error('do unreachable')
				return Response.json({ result: loyaltyResult() })
			})
			const res = await worker.fetch(post('/api/loyalty/tick', {}), env, ctx)
			expect(await res.json()).toMatchObject({
				success: false,
				errors: 1,
				holdsReleased: 4,
			})
			expect(spy).toHaveBeenCalledWith(
				'Tick fan-out (loyalty) failed for organization',
				ORG_C,
				expect.any(Error),
			)
			spy.mockRestore()
		})

		it('counts an organization that answers 200 with an unreadable body as an error, and logs it', async () => {
			const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
			const { env, orgFetch } = makeEnv()
			orgFetch.mockImplementation(async (orgId) =>
				orgId === ORG_A
					? new Response('<html>', { status: 200 })
					: Response.json({ result: loyaltyResult() }),
			)
			const res = await worker.fetch(post('/api/loyalty/tick', {}), env, ctx)
			expect(await res.json()).toMatchObject({
				errors: 1,
				holdsReleased: 4,
			})
			expect(spy).toHaveBeenCalledWith(
				'Tick fan-out (loyalty) failed for organization',
				ORG_A,
				'no result',
			)
			spy.mockRestore()
		})

		it('reports success with zero counts when no organization is registered', async () => {
			const { env, list } = makeEnv()
			list.mockResolvedValue([])
			const res = await worker.fetch(post('/api/loyalty/tick', {}), env, ctx)
			expect(await res.json()).toMatchObject({
				success: true,
				orgs: 0,
				errors: 0,
				holdsReleased: 0,
			})
		})
	})

	describe('routing does not leak across modules or methods', () => {
		it('sends the reservations tick to the reservations path', async () => {
			const { env, forwarded } = makeEnv()
			await worker.fetch(post('/api/reservations/tick', {}), env, ctx)
			expect(forwarded).toHaveLength(3)
			for (const f of forwarded) {
				expect(new URL(f.request.url).pathname).toBe('/api/reservations/tick')
			}
		})

		it('a GET to the loyalty tick path is not treated as a tick', async () => {
			const { env, forwarded, list } = makeEnv()
			const res = await worker.fetch(
				new Request('https://api.test/api/loyalty/tick', {
					headers: { Authorization: `Bearer ${TOKEN}` },
				}),
				env,
				ctx,
			)
			expect(res.status).toBe(400)
			expect(forwarded).toHaveLength(0)
			expect(list).not.toHaveBeenCalled()
		})
	})
})
