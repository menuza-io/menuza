import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	APP_LOOKUP_NEGATIVE_TTL_MS,
	APP_LOOKUP_POSITIVE_TTL_MS,
	clearAppLookupCacheForTest,
	resolvePublishedOrganization,
} from './origin.ts'

vi.mock('@repo/database', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@repo/database')>()
	// No node-local control plane: the lookup falls through to the App.
	return { ...actual, db: { select: vi.fn() } }
})

const organization = {
	id: 'clw9x0a12000008l00lookup1',
	slug: 'lookup-test',
	customDomain: null,
	dataRegion: 'us',
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] })
	vi.stubEnv('APP_URL', 'https://app.example.com')
	vi.stubEnv('TENANT_API_RUNTIME', 'workers')
	clearAppLookupCacheForTest()
})

afterEach(() => {
	vi.useRealTimers()
	vi.unstubAllGlobals()
	vi.unstubAllEnvs()
})

describe('resolving an origin through the App', () => {
	it('asks the App once per slug within the cache window, with a timeout', async () => {
		const fetchMock = vi.fn(async () => Response.json(organization))
		vi.stubGlobal('fetch', fetchMock)
		const first = await resolvePublishedOrganization({ slug: 'lookup-test' })
		const second = await resolvePublishedOrganization({ slug: 'lookup-test' })
		expect(first).toMatchObject({ id: organization.id })
		expect(second).toEqual(first)
		expect(fetchMock).toHaveBeenCalledTimes(1)
		const init = (
			fetchMock.mock.calls[0] as unknown as [string, RequestInit]
		)[1]
		expect(init.signal).toBeInstanceOf(AbortSignal)
		vi.setSystemTime(Date.now() + APP_LOOKUP_POSITIVE_TTL_MS + 1)
		await resolvePublishedOrganization({ slug: 'lookup-test' })
		expect(fetchMock).toHaveBeenCalledTimes(2)
	})

	it('caches an unknown origin briefly so a flood of them is one lookup', async () => {
		const fetchMock = vi.fn(async () => new Response('nope', { status: 404 }))
		vi.stubGlobal('fetch', fetchMock)
		expect(
			await resolvePublishedOrganization({ host: 'nobody.test' }),
		).toBeNull()
		expect(
			await resolvePublishedOrganization({ host: 'nobody.test' }),
		).toBeNull()
		expect(fetchMock).toHaveBeenCalledTimes(1)
		vi.setSystemTime(Date.now() + APP_LOOKUP_NEGATIVE_TTL_MS + 1)
		await resolvePublishedOrganization({ host: 'nobody.test' })
		expect(fetchMock).toHaveBeenCalledTimes(2)
	})

	it('never caches an outage or a server error', async () => {
		const fetchMock = vi
			.fn()
			.mockRejectedValueOnce(new Error('timeout'))
			.mockResolvedValueOnce(new Response('boom', { status: 503 }))
			.mockResolvedValueOnce(Response.json(organization))
		vi.stubGlobal('fetch', fetchMock)
		vi.spyOn(console, 'warn').mockImplementation(() => {})
		expect(
			await resolvePublishedOrganization({ slug: 'lookup-test' }),
		).toBeNull()
		expect(
			await resolvePublishedOrganization({ slug: 'lookup-test' }),
		).toBeNull()
		expect(
			await resolvePublishedOrganization({ slug: 'lookup-test' }),
		).toMatchObject({ id: organization.id })
		expect(fetchMock).toHaveBeenCalledTimes(3)
	})
})
