import { db, eq, Organization } from '@repo/database'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setupTestOrgWithUser } from '#tests/test-utils.ts'

const commerce = vi.hoisted(() => ({
	retrieveConnectAccountStatus: vi.fn(),
	retrieveCheckoutSubEntityStatus: vi.fn(),
	mapConnectAccountUpdate: vi.fn(),
	inviteCheckoutSubEntity: vi.fn(),
	createConnectExpressAccount: vi.fn(),
}))
const notify = vi.hoisted(() => vi.fn(async () => undefined))

vi.mock('@repo/payments', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	createShopCommerce: () => commerce,
}))
vi.mock('#app/utils/reservations/access.server.ts', () => ({
	notifyReservationsContextChanged: notify,
}))

const {
	ensureConnectAccount,
	handleConnectAccountUpdated,
	inviteCheckoutSubEntityOnboarding,
	syncCheckoutSubEntityStatus,
	syncConnectAccountStatus,
	updateShopProduct,
} = await import('./shop.server.ts')

const status = (chargesEnabled: boolean) => ({
	chargesEnabled,
	payoutsEnabled: chargesEnabled,
})

describe('shop writes notify the regional reservations context', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('notifies when Connect charges flip and not when unchanged', async () => {
		const { organization } = await setupTestOrgWithUser()
		await db
			.update(Organization)
			.set({ stripeConnectAccountId: 'acct_1' })
			.where(eq(Organization.id, organization.id))

		commerce.retrieveConnectAccountStatus.mockResolvedValue(status(true))
		await syncConnectAccountStatus(organization.id)
		expect(notify).toHaveBeenCalledWith(organization.id, 'payments')

		notify.mockClear()
		await syncConnectAccountStatus(organization.id)
		expect(notify).not.toHaveBeenCalled()
	})

	it('notifies when Checkout.com charges flip and not when unchanged', async () => {
		const { organization } = await setupTestOrgWithUser()
		await db
			.update(Organization)
			.set({ checkoutSubEntityId: 'ent_1' })
			.where(eq(Organization.id, organization.id))

		commerce.retrieveCheckoutSubEntityStatus.mockResolvedValue(status(true))
		await syncCheckoutSubEntityStatus(organization.id)
		expect(notify).toHaveBeenCalledWith(organization.id, 'payments')

		notify.mockClear()
		await syncCheckoutSubEntityStatus(organization.id)
		expect(notify).not.toHaveBeenCalled()
	})

	it('notifies from the Connect account.updated webhook only on change', async () => {
		const { organization } = await setupTestOrgWithUser()
		await db
			.update(Organization)
			.set({ stripeConnectAccountId: 'acct_hook' })
			.where(eq(Organization.id, organization.id))
		commerce.mapConnectAccountUpdate.mockReturnValue({
			organizationId: organization.id,
			accountId: 'acct_hook',
			chargesEnabled: true,
			payoutsEnabled: true,
		})

		await handleConnectAccountUpdated({})
		expect(notify).toHaveBeenCalledWith(organization.id, 'payments')

		notify.mockClear()
		await handleConnectAccountUpdated({})
		expect(notify).not.toHaveBeenCalled()
	})

	it('notifies when a Connect account is created', async () => {
		const { organization } = await setupTestOrgWithUser()
		commerce.createConnectExpressAccount.mockResolvedValue({ id: 'acct_new' })
		await ensureConnectAccount({
			id: organization.id,
			name: organization.name,
			dataRegion: 'us',
			stripeConnectAccountId: null,
		})
		expect(notify).toHaveBeenCalledWith(organization.id, 'payments')
	})

	it('notifies when a Checkout.com sub-entity is invited', async () => {
		const { organization } = await setupTestOrgWithUser()
		commerce.inviteCheckoutSubEntity.mockResolvedValue({ id: 'ent_new' })
		await inviteCheckoutSubEntityOnboarding(
			{
				id: organization.id,
				dataRegion: 'us',
				checkoutSubEntityId: null,
			},
			'owner@example.com',
		)
		expect(notify).toHaveBeenCalledWith(organization.id, 'payments')
	})

	it('notifies when the shop processor or enabled flag changes only', async () => {
		const { organization } = await setupTestOrgWithUser()
		const base = {
			productName: 'Shop',
			priceCents: 1000,
			enabled: false,
		}
		await updateShopProduct(organization.id, {
			...base,
			enabled: true,
			paymentProvider: 'connect',
		})
		expect(notify).toHaveBeenCalledWith(organization.id, 'payments')

		notify.mockClear()
		await updateShopProduct(organization.id, {
			...base,
			enabled: true,
			paymentProvider: 'connect',
			productName: 'Renamed',
		})
		expect(notify).not.toHaveBeenCalled()
	})
})
