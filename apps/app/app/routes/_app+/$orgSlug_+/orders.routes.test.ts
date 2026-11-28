import { beforeEach, describe, expect, it, vi } from 'vitest'

const access = vi.hoisted(() => ({
	requireUserOrganization: vi.fn(),
	requireMenuRead: vi.fn(),
	userHasOrganizationPermission: vi.fn(),
	getOrderCustomerLinkAccess: vi.fn(),
	isImpersonating: vi.fn(),
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
vi.mock('#app/utils/loyalty/access.server.ts', () => ({
	isLoyaltyFeatureEnabled: vi.fn().mockResolvedValue(false),
}))
vi.mock('#app/utils/location/ordering-controls.server.ts', () => ({
	loadOrderingControls: vi.fn().mockResolvedValue([]),
}))
vi.mock('@repo/auth', () => ({
	userHasOrganizationPermission: access.userHasOrganizationPermission,
	isImpersonating: access.isImpersonating,
}))
vi.mock('#app/utils/organization/permissions.server.ts', () => ({
	ORG_PERMISSIONS: {
		UPDATE_MENU_ANY: 'update:menu:any',
		UPDATE_ORDER_REFUND_ANY: 'update:order_refund:any',
	},
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
		access.isImpersonating.mockResolvedValue(false)
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
		expect(result.data).toEqual({
			// Names for the order's step timeline (#243): from the members list.
			memberNames: expect.any(Object),
			orgSlug: 'acme',
			orderId: 'o1',
			canWrite: true,
			canRefund: true,
			canViewCustomers: true,
			// Cloud printers (#117) are off unless the organization has the flag.
			printersEnabled: false,
			// Pay links (#163) and order edits (#162) are off unless enabled.
			payLinksEnabled: false,
			orderEditsEnabled: false,
			isUsNode: true,
			// Guest order problem reports (#191) are off unless enabled.
			problemReportsEnabled: false,
		})
	})

	it('refunds follow order write access, whatever the loyalty flags say', async () => {
		access.userHasOrganizationPermission.mockResolvedValue(false)
		const result = (await detailLoader(
			args('https://app.test/acme/orders/o1', {
				orgSlug: 'acme',
				orderId: 'o1',
			}),
		)) as { data: { canWrite: boolean } }
		expect(result.data.canWrite).toBe(false)
		expect(access.userHasOrganizationPermission).toHaveBeenCalledWith(
			'u1',
			'org1',
			'update:menu:any',
		)
	})

	it('offers provider refunds only with the order refund permission and never while impersonating', async () => {
		const detail = async () =>
			(
				(await detailLoader(
					args('https://app.test/acme/orders/o1', {
						orgSlug: 'acme',
						orderId: 'o1',
					}),
				)) as { data: { canRefund: boolean } }
			).data.canRefund
		expect(await detail()).toBe(true)
		expect(access.userHasOrganizationPermission).toHaveBeenCalledWith(
			'u1',
			'org1',
			'update:order_refund:any',
		)
		access.isImpersonating.mockResolvedValue(true)
		expect(await detail()).toBe(false)
		access.isImpersonating.mockResolvedValue(false)
		access.userHasOrganizationPermission.mockImplementation(
			async (_user: string, _org: string, permission: string) =>
				permission !== 'update:order_refund:any',
		)
		expect(await detail()).toBe(false)
	})
})
