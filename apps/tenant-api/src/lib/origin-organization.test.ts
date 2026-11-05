import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	findActiveOrganizationById,
	resetLookupLogThrottleForTests,
} from './origin.ts'

const { select } = vi.hoisted(() => ({ select: vi.fn() }))

vi.mock('@repo/database', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@repo/database')>()
	return { ...actual, db: { select } }
})

const organization = {
	id: 'clw9x0a12000008l00mailbox1',
	slug: 'mailbox-test',
	customDomain: null,
	hasProvisionedDb: true,
	dataRegion: 'us',
}
const commandToken = 'test-internal-command-token'

beforeEach(() => {
	resetLookupLogThrottleForTests()
	vi.stubEnv('APP_URL', 'https://app.example.com')
	vi.stubEnv('INTERNAL_COMMAND_TOKEN', commandToken)
	select.mockClear()
	vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(organization)))
})

afterEach(() => {
	vi.unstubAllGlobals()
	vi.unstubAllEnvs()
	vi.restoreAllMocks()
})

describe('active organization lookup', () => {
	it('uses authenticated App metadata without needing a local control-plane row', async () => {
		expect(await findActiveOrganizationById(organization.id)).toEqual(
			organization,
		)
		expect(fetch).toHaveBeenCalledWith(
			`https://app.example.com/resources/tenant-organization?orgId=${organization.id}`,
			expect.objectContaining({
				headers: {
					Accept: 'application/json',
					Authorization: `Bearer ${commandToken}`,
				},
				redirect: 'error',
				signal: expect.any(AbortSignal),
			}),
		)
		expect(select).not.toHaveBeenCalled()
	})

	it('uses the current App region instead of stale node-local metadata', async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			Response.json({ ...organization, dataRegion: 'ksa' }),
		)
		expect(await findActiveOrganizationById(organization.id)).toEqual({
			...organization,
			dataRegion: 'ksa',
		})
		expect(select).not.toHaveBeenCalled()
	})

	it.each([401, 404, 503])(
		'fails closed on an App %s response without falling back to stale rows',
		async (status) => {
			vi.mocked(fetch).mockResolvedValueOnce(
				Response.json({ error: 'Unavailable' }, { status }),
			)
			expect(await findActiveOrganizationById(organization.id)).toBeNull()
			expect(select).not.toHaveBeenCalled()
		},
	)

	it('fails closed when the App request fails', async () => {
		vi.mocked(fetch).mockRejectedValueOnce(new Error('Connection failed'))
		expect(await findActiveOrganizationById(organization.id)).toBeNull()
		expect(select).not.toHaveBeenCalled()
	})

	it.each([
		{ ...organization, id: 'clw9x0a12000008l00another1' },
		{ ...organization, dataRegion: 'unknown' },
		{ ...organization, hasProvisionedDb: 'true' },
		null,
	])('rejects invalid or mismatched metadata', async (payload) => {
		vi.mocked(fetch).mockResolvedValueOnce(Response.json(payload))
		expect(await findActiveOrganizationById(organization.id)).toBeNull()
	})

	it('rejects malformed IDs before making any lookup', async () => {
		expect(await findActiveOrganizationById('../another-org')).toBeNull()
		expect(fetch).not.toHaveBeenCalled()
		expect(select).not.toHaveBeenCalled()
	})

	it('requires a configured command token for App metadata', async () => {
		vi.stubEnv('INTERNAL_COMMAND_TOKEN', '')
		expect(await findActiveOrganizationById(organization.id)).toBeNull()
		expect(fetch).not.toHaveBeenCalled()
	})

	it('supports a shared control-plane database when no App URL is configured', async () => {
		vi.stubEnv('APP_URL', '')
		vi.stubEnv('BASE_URL', '')
		select.mockReturnValue({
			from: () => ({
				where: () => ({ limit: async () => [organization] }),
			}),
		})
		expect(await findActiveOrganizationById(organization.id)).toEqual(
			organization,
		)
		expect(fetch).not.toHaveBeenCalled()
		expect(select).toHaveBeenCalledOnce()
	})
})

describe('organization lookup failure logs', () => {
	const logged = () =>
		JSON.stringify([
			...vi.mocked(console.warn).mock.calls,
			...vi.mocked(console.error).mock.calls,
		])

	beforeEach(() => {
		vi.spyOn(console, 'warn').mockImplementation(() => {})
		vi.spyOn(console, 'error').mockImplementation(() => {})
	})

	it('reports a token mismatch as an error with the status, without secrets', async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			Response.json({ error: 'Unauthorized' }, { status: 401 }),
		)
		expect(await findActiveOrganizationById(organization.id)).toBeNull()
		expect(console.error).toHaveBeenCalledWith('tenant org lookup failed', {
			reason: 'app_rejected_internal_command_token',
			status: 401,
			appHost: 'app.example.com',
		})
		expect(logged()).not.toContain(commandToken)
		expect(logged()).not.toContain(organization.id)
	})

	it('does not log the token length or the URL when the token is too short', async () => {
		vi.stubEnv('INTERNAL_COMMAND_TOKEN', 'tiny-secret')
		expect(await findActiveOrganizationById(organization.id)).toBeNull()
		expect(fetch).not.toHaveBeenCalled()
		expect(console.error).toHaveBeenCalledWith('tenant org lookup failed', {
			reason: 'internal_command_token_missing_or_short',
			appHost: 'app.example.com',
		})
		expect(logged()).not.toContain('tiny-secret')
		expect(logged()).not.toMatch(/length/i)
	})

	it('logs an error name and cause code, never the message with the URL', async () => {
		const failure = Object.assign(
			new TypeError(
				`fetch failed: https://app.example.com/resources/tenant-organization?orgId=${organization.id}`,
			),
			{ cause: { code: 'ECONNREFUSED' } },
		)
		vi.mocked(fetch).mockRejectedValueOnce(failure)
		expect(await findActiveOrganizationById(organization.id)).toBeNull()
		expect(console.warn).toHaveBeenCalledWith('tenant org lookup failed', {
			reason: 'app_lookup_threw',
			appHost: 'app.example.com',
			errorName: 'TypeError',
			errorCode: 'ECONNREFUSED',
		})
		expect(logged()).not.toContain(organization.id)
		expect(logged()).not.toContain('fetch failed')
	})

	it('logs a repeated failure once a minute', async () => {
		vi.useFakeTimers()
		try {
			vi.mocked(fetch).mockResolvedValue(
				Response.json({ error: 'nope' }, { status: 500 }),
			)
			await findActiveOrganizationById(organization.id)
			await findActiveOrganizationById(organization.id)
			expect(console.warn).toHaveBeenCalledTimes(1)
			vi.advanceTimersByTime(61_000)
			await findActiveOrganizationById(organization.id)
			expect(console.warn).toHaveBeenCalledTimes(2)
		} finally {
			vi.useRealTimers()
		}
	})
})
