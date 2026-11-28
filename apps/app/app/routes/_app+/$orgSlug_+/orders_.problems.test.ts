import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loader } from './orders_.problems.tsx'

const mocks = vi.hoisted(() => ({
	organization: vi.fn(),
	flag: vi.fn(),
	read: vi.fn(),
	permission: vi.fn(),
	impersonating: vi.fn(),
}))
vi.mock('@repo/common/feature-flags', () => ({ getFeatureFlag: mocks.flag }))
vi.mock('@repo/auth', () => ({
	isImpersonating: mocks.impersonating,
	userHasOrganizationPermission: mocks.permission,
}))
vi.mock('#app/utils/organization/loader.server.ts', () => ({
	requireUserOrganization: mocks.organization,
}))
vi.mock('#app/utils/menu/access.server.ts', () => ({
	requireMenuRead: mocks.read,
}))
vi.mock('#app/utils/organization/permissions.server.ts', () => ({
	ORG_PERMISSIONS: {
		UPDATE_MENU_ANY: 'update:menu:any',
		UPDATE_ORDER_REFUND_ANY: 'update:order_refund:any',
	},
}))

function run() {
	return loader({
		request: new Request('https://app.example/cafe/orders/problems'),
		params: { orgSlug: 'cafe' },
		context: {} as never,
	} as unknown as Parameters<typeof loader>[0])
}

describe('Orders, Problems (#191)', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.organization.mockResolvedValue({ id: 'org_1' })
		mocks.flag.mockResolvedValue(true)
		mocks.read.mockResolvedValue('user_1')
		mocks.permission.mockResolvedValue(true)
		mocks.impersonating.mockResolvedValue(false)
	})

	it('is a 404 while ordering.problem_reports is off, before any permission check', async () => {
		mocks.flag.mockResolvedValue(null)
		await expect(run()).rejects.toMatchObject({ init: { status: 404 } })
		expect(mocks.read).not.toHaveBeenCalled()
		mocks.flag.mockResolvedValue('true')
		await expect(run()).rejects.toMatchObject({ init: { status: 404 } })
	})

	it('needs the orders read permission', async () => {
		mocks.read.mockRejectedValue(new Response('Forbidden', { status: 403 }))
		await expect(run()).rejects.toMatchObject({ status: 403 })
	})

	it('hands over the permissions: write and refund, and never refund while impersonating', async () => {
		const result = await run()
		expect(result.data).toEqual({
			orgSlug: 'cafe',
			canWrite: true,
			canRefund: true,
		})
		mocks.impersonating.mockResolvedValue(true)
		expect((await run()).data).toMatchObject({
			canWrite: true,
			canRefund: false,
		})
		mocks.impersonating.mockResolvedValue(false)
		mocks.permission.mockImplementation(
			async (_user: string, _org: string, permission: string) =>
				permission === 'update:menu:any',
		)
		expect((await run()).data).toMatchObject({
			canWrite: true,
			canRefund: false,
		})
	})
})
