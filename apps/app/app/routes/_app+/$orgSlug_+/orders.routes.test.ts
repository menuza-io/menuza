import { beforeEach, describe, expect, it, vi } from 'vitest'

const access = vi.hoisted(() => ({
	requireUserOrganization: vi.fn(),
	requireMenuRead: vi.fn(),
	userHasOrganizationPermission: vi.fn(),
	getOrderCustomerLinkAccess: vi.fn(),
}))

vi.mock('#app/utils/organization/loader.server.ts', () => ({
	requireUserOrganization: access.requireUserOrganization,
}))
vi.mock('#app/utils/menu/access.server.ts', () => ({
	requireMenuRead: access.requireMenuRead,
}))
vi.mock('#app/utils/orders/customer-link.server.ts', () => ({
	getOrderCustomerLinkAccess: access.getOrderCustomerLinkAccess,
}))
vi.mock('@repo/auth', () => ({
	userHasOrganizationPermission: access.userHasOrganizationPermission,
}))
vi.mock('#app/utils/organization/permissions.server.ts', () => ({
	ORG_PERMISSIONS: { UPDATE_MENU_ANY: 'update:menu:any' },
}))

import { loader as listLoader } from './orders.tsx'
import { loader as detailLoader } from './orders_.$orderId.tsx'

const args = (url: string, params: Record<string, string>) =>
	({ request: new Request(url), params, context: {} }) as never

describe('orders routes', () => {
	beforeEach(() => {
		access.requireUserOrganization.mockResolvedValue({ id: 'org1' })
		access.requireMenuRead.mockResolvedValue('u1')
		access.userHasOrganizationPermission.mockResolvedValue(true)
		access.getOrderCustomerLinkAccess.mockResolvedValue({
			linkCustomers: true,
			linkGuests: false,
		})
	})

	it('redirects the legacy ?order= link to the order page', async () => {
		const thrown = await listLoader(
			args('https://app.test/acme/orders?order=o%201', { orgSlug: 'acme' }),
		).catch((error: unknown) => error)
		expect(thrown).toBeInstanceOf(Response)
		expect((thrown as Response).headers.get('Location')).toBe(
			'/acme/orders/o%201',
		)
		expect(access.requireUserOrganization).not.toHaveBeenCalled()
	})

	it('the detail loader requires membership and menu read first', async () => {
		access.requireMenuRead.mockRejectedValue(
			new Response(null, { status: 403 }),
		)
		await expect(
			detailLoader(
				args('https://app.test/acme/orders/o1', {
					orgSlug: 'acme',
					orderId: 'o1',
				}),
			),
		).rejects.toBeInstanceOf(Response)
		expect(access.requireUserOrganization).toHaveBeenCalled()
	})

	it('the detail loader returns the order id and gates customer links', async () => {
		const result = (await detailLoader(
			args('https://app.test/acme/orders/o1', {
				orgSlug: 'acme',
				orderId: 'o1',
			}),
		)) as {
			data: { orderId: string; canWrite: boolean; canViewCustomers: boolean }
		}
		expect(result.data).toMatchObject({
			orderId: 'o1',
			canWrite: true,
			canViewCustomers: true,
		})
	})
})
