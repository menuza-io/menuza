import { AuditAction, type auditService } from '@repo/audit'
import { db, OrganizationLocation } from '@repo/database'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	createAuthenticatedRequest,
	createTestOrganization,
	createTestUser,
	getResponseStatus,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'
import { action } from './orders_.daily-limits-top-up.ts'

// The region is the external boundary; permissions and the database are real.
const mocks = vi.hoisted(() => ({ client: vi.fn(), audit: vi.fn() }))
vi.mock('#app/utils/tenant-api.server.ts', () => ({
	getOperatorTenantClient: mocks.client,
}))
// The audit writer does nothing under test; the call is what is checked.
vi.mock('@repo/audit', async (importOriginal) => {
	const actual = await importOriginal<{ AuditAction: typeof AuditAction }>()
	return {
		...actual,
		auditService: { log: mocks.audit } satisfies Partial<typeof auditService>,
	}
})

const ROW = {
	key: 'item:item_1',
	kind: 'item',
	id: 'item_1',
	name: 'Special',
	limit: 20,
	showRemaining: false,
	toppedUpUnits: 5,
	soldUnits: 20,
	heldUnits: 0,
	remaining: 5,
}

let regionCalls: Array<{ url: string; init: RequestInit }>
let regionAnswer: { status: number; body: unknown }

async function setup(role: 'admin' | 'viewer' = 'admin') {
	const { organization, cookie, user } = await setupTestOrgWithUser(role)
	const [location] = await db
		.insert(OrganizationLocation)
		.values({
			organizationId: organization.id,
			name: 'Main Street',
			slug: `main-${Math.random().toString(36).slice(2, 8)}`,
		})
		.returning()
	return { organization, location: location!, cookie, user }
}

function post(orgSlug: string, cookie: string, values: Record<string, string>) {
	const request = createAuthenticatedRequest(
		`https://app.test/${orgSlug}/orders/daily-limits-top-up`,
		{ method: 'POST', body: new URLSearchParams(values) },
		cookie,
	)
	return action({ request, params: { orgSlug }, context: {} } as never)
}

async function statusOf(run: () => Promise<unknown>) {
	try {
		return getResponseStatus(await run())
	} catch (error) {
		if (error instanceof Response) return error.status
		throw error
	}
}

async function bodyOf(result: unknown) {
	const response = result as { data?: unknown; init?: unknown }
	return (response.data ?? response) as Record<string, unknown>
}

beforeEach(() => {
	regionCalls = []
	regionAnswer = { status: 200, body: { ok: true, row: ROW } }
	mocks.client.mockReset()
	mocks.audit.mockReset()
	mocks.client.mockResolvedValue({
		jwt: 'region-token',
		tenantApiUrl: 'https://region.test',
	})
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string, init: RequestInit) => {
			regionCalls.push({ url: String(url), init })
			return new Response(JSON.stringify(regionAnswer.body), {
				status: regionAnswer.status,
				headers: { 'content-type': 'application/json' },
			})
		}),
	)
})

afterEach(() => {
	vi.unstubAllGlobals()
})

describe('daily dish limit top-up action (#409)', () => {
	it('adds units through the region with a write token, and returns the new row', async () => {
		const { organization, location, cookie } = await setup()
		const result = await post(organization.slug, cookie, {
			locationId: location.id,
			key: 'item:item_1',
			addUnits: '5',
		})
		expect(getResponseStatus(result)).toBe(200)
		expect(await bodyOf(result)).toMatchObject({ ok: true, row: ROW })

		expect(mocks.client).toHaveBeenCalledWith(
			expect.anything(),
			organization.slug,
			{ scope: 'orders:write' },
		)
		expect(regionCalls).toHaveLength(1)
		expect(regionCalls[0]!.url).toBe(
			'https://region.test/operator/orders/daily-limits/top-up',
		)
		expect(regionCalls[0]!.init.method).toBe('POST')
		expect(new Headers(regionCalls[0]!.init.headers).get('authorization')).toBe(
			'Bearer region-token',
		)
		expect(JSON.parse(String(regionCalls[0]!.init.body))).toEqual({
			locationId: location.id,
			key: 'item:item_1',
			addUnits: 5,
		})
	})

	it('sets the amount left, including 0', async () => {
		const { organization, location, cookie } = await setup()
		await post(organization.slug, cookie, {
			locationId: location.id,
			key: 'option:opt_1',
			amountLeft: '0',
		})
		expect(JSON.parse(String(regionCalls[0]!.init.body))).toEqual({
			locationId: location.id,
			key: 'option:opt_1',
			amountLeft: 0,
		})
	})

	it('writes an audit entry with ids and numbers only', async () => {
		const { organization, location, cookie, user } = await setup()
		await post(organization.slug, cookie, {
			locationId: location.id,
			key: 'item:item_1',
			addUnits: '10',
		})
		expect(mocks.audit).toHaveBeenCalledTimes(1)
		const entry = mocks.audit.mock.calls[0]![0]
		expect(entry).toMatchObject({
			action: AuditAction.DAILY_DISH_LIMIT_TOPPED_UP,
			userId: user.id,
			organizationId: organization.id,
			resourceType: 'organization_location',
			resourceId: location.id,
		})
		expect(entry.metadata).toEqual({
			locationId: location.id,
			key: 'item:item_1',
			addUnits: 10,
			remaining: 5,
		})
	})

	it.each([
		['neither number', {}],
		['both numbers', { addUnits: '5', amountLeft: '3' }],
		['an add of 0', { addUnits: '0' }],
		['a fraction', { addUnits: '2.5' }],
		['a key that is not a limit key', { key: 'menu:x', addUnits: '5' }],
	])('refuses %s without calling the region', async (_name, extra) => {
		const { organization, location, cookie } = await setup()
		const result = await post(organization.slug, cookie, {
			locationId: location.id,
			key: 'item:item_1',
			...extra,
		})
		expect(getResponseStatus(result)).toBe(400)
		expect(await bodyOf(result)).toMatchObject({
			ok: false,
			error: 'invalid_request',
		})
		expect(regionCalls).toHaveLength(0)
		expect(mocks.audit).not.toHaveBeenCalled()
	})

	it('refuses a member who cannot change the menu, and calls nothing', async () => {
		const { organization, location, cookie } = await setup('viewer')
		const status = await statusOf(() =>
			post(organization.slug, cookie, {
				locationId: location.id,
				key: 'item:item_1',
				addUnits: '5',
			}),
		)
		expect(status).toBe(403)
		expect(regionCalls).toHaveLength(0)
		expect(mocks.client).not.toHaveBeenCalled()
	})

	it('refuses someone who is not signed in', async () => {
		const { organization, location } = await setup()
		const request = new Request(
			`https://app.test/${organization.slug}/orders/daily-limits-top-up`,
			{
				method: 'POST',
				body: new URLSearchParams({
					locationId: location.id,
					key: 'item:item_1',
					addUnits: '5',
				}),
			},
		)
		const status = await statusOf(() =>
			action({
				request,
				params: { orgSlug: organization.slug },
				context: {},
			} as never),
		)
		expect([401, 302, 303]).toContain(status)
		expect(regionCalls).toHaveLength(0)
	})

	it("refuses another organization's location with a 404 and calls nothing", async () => {
		const { organization, cookie } = await setup()
		const stranger = await createTestUser()
		const otherOrg = await createTestOrganization(stranger.id, 'admin')
		const [foreign] = await db
			.insert(OrganizationLocation)
			.values({
				organizationId: otherOrg.id,
				name: 'Theirs',
				slug: `theirs-${Math.random().toString(36).slice(2, 8)}`,
			})
			.returning()
		const result = await post(organization.slug, cookie, {
			locationId: foreign!.id,
			key: 'item:item_1',
			addUnits: '5',
		})
		expect(getResponseStatus(result)).toBe(404)
		expect(await bodyOf(result)).toMatchObject({
			ok: false,
			error: 'location_not_found',
		})
		expect(regionCalls).toHaveLength(0)
	})

	it("passes the region's refusal through and writes no audit entry", async () => {
		const { organization, location, cookie } = await setup()
		regionAnswer = {
			status: 404,
			body: { error: 'daily_limit_not_found', message: 'nope' },
		}
		const result = await post(organization.slug, cookie, {
			locationId: location.id,
			key: 'item:item_1',
			addUnits: '5',
		})
		expect(getResponseStatus(result)).toBe(404)
		expect(await bodyOf(result)).toMatchObject({
			ok: false,
			error: 'daily_limit_not_found',
		})
		expect(mocks.audit).not.toHaveBeenCalled()
	})

	it('reports a region failure it cannot explain as a failed top-up', async () => {
		const { organization, location, cookie } = await setup()
		regionAnswer = { status: 500, body: {} }
		const result = await post(organization.slug, cookie, {
			locationId: location.id,
			key: 'item:item_1',
			addUnits: '5',
		})
		expect(getResponseStatus(result)).toBe(500)
		expect(await bodyOf(result)).toMatchObject({
			ok: false,
			error: 'top_up_failed',
		})
	})

	it('still succeeds when the region answers without a readable row', async () => {
		const { organization, location, cookie } = await setup()
		regionAnswer = { status: 200, body: { ok: true } }
		const result = await post(organization.slug, cookie, {
			locationId: location.id,
			key: 'item:item_1',
			addUnits: '5',
		})
		expect(getResponseStatus(result)).toBe(200)
		expect(await bodyOf(result)).toMatchObject({ ok: true, row: null })
	})
})
