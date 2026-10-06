import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { findActiveOrganizationById } from './origin.ts'

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
