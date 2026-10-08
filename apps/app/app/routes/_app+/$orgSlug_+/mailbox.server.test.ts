import { userHasOrganizationPermission } from '@repo/auth'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	ORG_PERMISSIONS,
	requireAnyUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'
import { loadCallsViewData } from '#app/utils/phone-agent/calls-view.server.ts'
import { loader } from './mailbox.server.ts'

vi.mock('@repo/auth', () => ({ userHasOrganizationPermission: vi.fn() }))
vi.mock('#app/utils/organization/loader.server.ts', () => ({
	requireUserOrganization: vi.fn(),
}))
vi.mock('#app/utils/organization/permissions.server.ts', () => ({
	ORG_PERMISSIONS: {
		READ_WEBSITE_ANY: 'read:website:any',
		READ_PHONE_CALL_ANY: 'read:phone_call:any',
	},
	requireAnyUserWithOrganizationPermission: vi.fn(),
}))
vi.mock('#app/utils/phone-agent/calls-view.server.ts', () => ({
	loadCallsViewData: vi.fn(),
}))

const CALLS_VIEW = {
	scopeNames: { loc_1: 'Downtown' },
	canUpdate: true,
	canDelete: false,
	tags: [],
}

function grant(...permissions: string[]) {
	vi.mocked(userHasOrganizationPermission).mockImplementation(
		async (ignoredUserId, ignoredOrgId, permission) =>
			permissions.includes(permission),
	)
}

async function load() {
	const request = new Request('http://localhost:3001/acme/mailbox')
	const result = await loader({
		request,
		params: { orgSlug: 'acme' },
		context: {},
	} as unknown as Parameters<typeof loader>[0])
	return (result as unknown as { data: unknown }).data
}

describe('mailbox loader', () => {
	beforeEach(() => {
		vi.mocked(requireUserOrganization)
			.mockReset()
			.mockResolvedValue({ id: 'org_1', dataRegion: 'us' } as never)
		vi.mocked(requireAnyUserWithOrganizationPermission)
			.mockReset()
			.mockResolvedValue('user_1')
		vi.mocked(loadCallsViewData).mockReset().mockResolvedValue(CALLS_VIEW)
	})

	it('needs website or phone call access', async () => {
		vi.mocked(requireAnyUserWithOrganizationPermission).mockRejectedValueOnce(
			new Response('Forbidden', { status: 403 }),
		)
		await expect(load()).rejects.toMatchObject({ status: 403 })
		expect(requireAnyUserWithOrganizationPermission).toHaveBeenCalledWith(
			expect.any(Request),
			'org_1',
			[ORG_PERMISSIONS.READ_WEBSITE_ANY, ORG_PERMISSIONS.READ_PHONE_CALL_ANY],
		)
		expect(loadCallsViewData).not.toHaveBeenCalled()
	})

	it('shows only forms and reviews without phone call access', async () => {
		grant(ORG_PERMISSIONS.READ_WEBSITE_ANY)
		expect(await load()).toEqual({ canReadWebsite: true, calls: null })
		expect(loadCallsViewData).not.toHaveBeenCalled()
	})

	it('shows only calls to people who can read calls but not the website', async () => {
		grant(ORG_PERMISSIONS.READ_PHONE_CALL_ANY)
		expect(await load()).toEqual({ canReadWebsite: false, calls: CALLS_VIEW })
		expect(loadCallsViewData).toHaveBeenCalledWith(expect.any(Request), 'org_1')
	})

	it('hides calls where the phone agent does not run', async () => {
		vi.mocked(requireUserOrganization).mockResolvedValue({
			id: 'org_1',
			dataRegion: 'ksa',
		} as never)
		grant(ORG_PERMISSIONS.READ_WEBSITE_ANY, ORG_PERMISSIONS.READ_PHONE_CALL_ANY)
		expect(await load()).toEqual({ canReadWebsite: true, calls: null })
		expect(loadCallsViewData).not.toHaveBeenCalled()
	})
})
