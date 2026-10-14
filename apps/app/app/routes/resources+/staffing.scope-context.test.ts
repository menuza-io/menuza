import type * as DatabaseModule from '@repo/database'
import { RouterContextProvider } from 'react-router'
import { ENV } from 'varlock/env'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { drizzleTable, mockDb, resetMockDb } from '#tests/setup/drizzle-mock.ts'
import { loader } from './staffing.scope-context.ts'

const findOrg = vi.hoisted(() => vi.fn())
const featureState = vi.hoisted(() => vi.fn())
const orgScope = vi.hoisted(() => vi.fn())

vi.mock('#app/utils/staffing/scope.server.ts', () => ({
	loadOrganizationScope: orgScope,
}))

vi.mock('#app/utils/staffing/access.server.ts', () => ({
	getStaffingFeatureState: featureState,
}))

vi.mock('@repo/database', async (importOriginal) => {
	const actual = await importOriginal<typeof DatabaseModule>()
	return {
		...actual,
		db: {
			...mockDb,
			query: { Organization: { findFirst: findOrg } },
		},
		Organization: drizzleTable,
		and: (...args: unknown[]) => args,
		eq: (...args: unknown[]) => args,
	}
})

const ORG_ID = 'clw9x0a12000008l00cafeorg1'

function args(orgId = ORG_ID, authorized = true) {
	const url = new URL('http://localhost:3001/resources/staffing/scope-context')
	url.searchParams.set('orgId', orgId)
	return {
		request: new Request(url, {
			headers: authorized
				? { Authorization: `Bearer ${ENV.INTERNAL_COMMAND_TOKEN}` }
				: {},
		}),
		params: {},
		context: new RouterContextProvider(),
		url,
		pattern: '/resources/staffing/scope-context',
	}
}

describe('staffing workplace context', () => {
	beforeEach(() => {
		resetMockDb()
		findOrg.mockReset().mockResolvedValue({ id: ORG_ID, dataRegion: 'us' })
		featureState.mockReset().mockResolvedValue({
			enabled: false,
			timeclock: false,
			scheduling: false,
			labor: false,
			hiring: false,
		})
		orgScope.mockReset().mockResolvedValue({
			id: 'main',
			name: 'Acme',
			timeZone: 'America/Chicago',
		})
	})

	it('requires internal command authentication (403, not a redirect)', async () => {
		const response = await loader(args(ORG_ID, false))
		expect(response.status).toBe(403)
		expect(findOrg).not.toHaveBeenCalled()
		expect(mockDb.select).not.toHaveBeenCalled()
	})

	it('rejects malformed organization ids before touching the database', async () => {
		for (const bad of ['../x', 'a b', '', 'x'.repeat(5) + '!']) {
			expect((await loader(args(bad))).status).toBe(400)
		}
		expect(findOrg).not.toHaveBeenCalled()
	})

	it('answers 404 for an organization that is not active and provisioned', async () => {
		findOrg.mockResolvedValue(null)
		expect((await loader(args())).status).toBe(404)
		expect(mockDb.select).not.toHaveBeenCalled()
	})

	it('returns the one implicit scope: id, name and time zone, never anything about people', async () => {
		const response = await loader(args())
		expect(response.status).toBe(200)
		expect(response.headers.get('Cache-Control')).toBe('private, no-store')
		const body = (await response.json()) as {
			orgId: string
			scopes: Array<Record<string, unknown>>
		}
		expect(body.orgId).toBe(ORG_ID)
		expect(body.scopes).toEqual([
			{
				id: 'main',
				name: 'Acme',
				timeZone: 'America/Chicago',
				isActive: true,
			},
		])
		expect(Object.keys(body)).toEqual([
			'orgId',
			'features',
			'dataRegion',
			'scopes',
		])
	})

	it('reports every staffing flag as off by default', async () => {
		const body = (await (await loader(args())).json()) as {
			features: Record<string, boolean>
			dataRegion: string
		}
		expect(body.features).toEqual({
			enabled: false,
			timeclock: false,
			scheduling: false,
			hiring: false,
		})
		expect(body.dataRegion).toBe('us')
		expect(featureState).toHaveBeenCalledWith(ORG_ID)
	})

	it('reports the effective flags, with the master switch already applied', async () => {
		featureState.mockResolvedValue({
			enabled: true,
			timeclock: true,
			scheduling: false,
			labor: true,
			hiring: false,
		})
		const body = (await (await loader(args())).json()) as {
			features: Record<string, boolean>
		}
		// Only what the regional tick needs; labor stays in the App.
		expect(body.features).toEqual({
			enabled: true,
			timeclock: true,
			scheduling: false,
			hiring: false,
		})
	})
})
