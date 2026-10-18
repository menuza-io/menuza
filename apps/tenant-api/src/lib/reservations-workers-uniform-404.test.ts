import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
	assertReservationsOrgOnUsNode,
	reservationsPublicNotFound,
} from '../../workers/org-router.ts'
import { notFoundResponse } from './reservations-public-auth.ts'

const orgs = vi.hoisted(() => new Map<string, Record<string, unknown>>())
const resolveOrigin = vi.hoisted(() => vi.fn())

vi.mock('./origin.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('./origin.ts')>()),
	findActiveOrganizationById: vi.fn(async (id: string) => orgs.get(id) ?? null),
	resolveOrganizationForPublicOrigin: resolveOrigin,
}))
vi.mock('./secrets.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('./secrets.ts')>()),
	applyVarlockEnv: vi.fn(),
	assertTenantApiSecrets: vi.fn(),
}))
vi.mock('../../workers/tenant-org.ts', () => ({
	TENANT_ORG_HEADER: 'x-tenant-org',
	TenantOrg: class {},
}))
vi.mock('../../workers/tenant-registry.ts', () => ({
	TenantRegistry: class {},
}))

const ORG_US = 'clw9x0a12000008l00rsvwus1'
const ORG_KSA = 'clw9x0a12000008l00rsvwksa'
const ORG_NODB = 'clw9x0a12000008l00rsvwndb'

async function snapshot(res: Response) {
	return {
		status: res.status,
		body: await res.text(),
		cacheControl: res.headers.get('Cache-Control'),
		contentType: res.headers.get('Content-Type'),
	}
}

describe('reservations public routes on the Workers edge answer the uniform 404', () => {
	const forward = vi.fn(async () => new Response('forwarded'))
	const env = {
		TENANT_API_RUNTIME: 'workers',
		TENANT_REGISTRY: {
			idFromName: () => 'reg',
			get: () => ({ list: async () => [] }),
		},
		TENANT_ORG: {
			idFromName: (name: string) => name,
			get: () => ({ fetch: forward }),
		},
	} as never

	beforeEach(() => {
		forward.mockClear()
		orgs.clear()
		orgs.set(ORG_US, { id: ORG_US, dataRegion: 'us', hasProvisionedDb: true })
		orgs.set(ORG_KSA, {
			id: ORG_KSA,
			dataRegion: 'ksa',
			hasProvisionedDb: true,
		})
		orgs.set(ORG_NODB, {
			id: ORG_NODB,
			dataRegion: 'us',
			hasProvisionedDb: false,
		})
		resolveOrigin.mockReset()
		resolveOrigin.mockImplementation(async (origin?: string) => {
			if (origin === 'https://us.test') return { id: ORG_US }
			if (origin === 'https://ksa.test') return { id: ORG_KSA }
			if (origin === 'https://nodb.test') return { id: ORG_NODB }
			return null
		})
	})

	it('matches the Node runtime body, status and headers exactly', async () => {
		expect(await snapshot(reservationsPublicNotFound())).toEqual(
			await snapshot(notFoundResponse()),
		)
	})

	it('refuses wrong-region and unprovisioned organizations without a region hint', async () => {
		expect(await assertReservationsOrgOnUsNode(ORG_US)).toBeNull()
		for (const id of [ORG_KSA, ORG_NODB, 'clw9x0a12000008l00rsvwnone']) {
			const denied = await assertReservationsOrgOnUsNode(id)
			expect(await snapshot(denied!)).toEqual(
				await snapshot(notFoundResponse()),
			)
		}
	})

	it('answers 404 (not 400 or 409 region_mismatch) through the worker entry point', async () => {
		const { default: worker } = await import('../../workers/index.ts')
		const expected = await snapshot(notFoundResponse())
		const call = (origin: string | null, pathname = '/reservations/config') =>
			worker.fetch(
				new Request(`https://api.test${pathname}`, {
					headers: origin ? { Origin: origin } : {},
				}),
				env,
				{} as never,
			)
		for (const origin of [
			null,
			'https://unknown.test',
			'https://ksa.test',
			'https://nodb.test',
		]) {
			expect(await snapshot(await call(origin))).toEqual(expected)
		}
		expect(forward).not.toHaveBeenCalled()
		const ok = await call('https://us.test')
		expect(await ok.text()).toBe('forwarded')
		expect(forward).toHaveBeenCalledTimes(1)
	})

	it('keeps the careers behavior unchanged', async () => {
		const { default: worker } = await import('../../workers/index.ts')
		const res = await worker.fetch(
			new Request('https://api.test/careers/jobs', {
				headers: { Origin: 'https://unknown.test' },
			}),
			env,
			{} as never,
		)
		expect(res.status).toBe(400)
	})
})
