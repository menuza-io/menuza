import { db, eq, isNotNull, Organization } from '@repo/database'
import { shopProcessorToDbValue } from '@repo/payments'
import { notifyReservationsContextChanged } from '#app/utils/reservations/access.server.ts'
import {
	ensureConnectAccount,
	inviteCheckoutSubEntityOnboarding,
	syncCheckoutSubEntityStatus,
	syncConnectAccountStatus,
} from '#app/utils/shop.server.ts'
import { getPaymentsEmulator } from './emulator.server.ts'
import { getPaymentsMockStatus } from './gate.server.ts'

export type MockOnboardProvider = 'stripe' | 'checkout'

export type MockOnboardResult =
	| { ok: true; provider: MockOnboardProvider; organizationId: string }
	| { ok: false; status: 404 | 409; error: string }

/** A stand-in contact: the mock sends no email and keeps no personal data. */
const MOCK_INVITEE_EMAIL = 'mock-onboarding@payments-mock.invalid'

const organizationColumns = {
	id: Organization.id,
	name: Organization.name,
	slug: Organization.slug,
	dataRegion: Organization.dataRegion,
	active: Organization.active,
	stripeConnectAccountId: Organization.stripeConnectAccountId,
	checkoutSubEntityId: Organization.checkoutSubEntityId,
} as const

/**
 * Enable one provider for an organization in one call: create and complete the
 * account (or sub-entity) in the emulator, then run the same status sync the
 * real onboarding return runs. Region rules still apply: Stripe is US only,
 * Checkout.com is open to every region. Never touches org columns directly
 * except `shopPaymentProvider`.
 */
export async function mockOnboardOrganization(options: {
	orgSlug: string
	provider: MockOnboardProvider
}): Promise<MockOnboardResult> {
	const status = getPaymentsMockStatus()
	if (!status.enabled || !status[options.provider]) {
		return { ok: false, status: 404, error: 'mock_disabled' }
	}
	const [organization] = await db
		.select(organizationColumns)
		.from(Organization)
		.where(eq(Organization.slug, options.orgSlug.trim().toLowerCase()))
		.limit(1)
	if (!organization?.active) {
		return { ok: false, status: 404, error: 'organization_not_found' }
	}
	const emulator = getPaymentsEmulator()

	if (options.provider === 'stripe') {
		if ((organization.dataRegion || 'us') !== 'us') {
			return { ok: false, status: 409, error: 'stripe_us_only' }
		}
		let accountId = organization.stripeConnectAccountId
		// A reset wipes the emulator but not the organization's columns.
		if (
			accountId &&
			!(await emulator.pages.stripe.describeAccount(accountId))
		) {
			await db
				.update(Organization)
				.set({
					stripeConnectAccountId: null,
					stripeConnectChargesEnabled: false,
					stripeConnectPayoutsEnabled: false,
					updatedAt: new Date(),
				})
				.where(eq(Organization.id, organization.id))
			accountId = null
			await notifyReservationsContextChanged(organization.id, 'payments')
		}
		accountId = await ensureConnectAccount({
			...organization,
			stripeConnectAccountId: accountId,
		})
		await emulator.testing.completeOnboarding(accountId, 'complete')
		await syncConnectAccountStatus(organization.id)
		await db
			.update(Organization)
			.set({
				shopPaymentProvider: shopProcessorToDbValue('connect'),
				updatedAt: new Date(),
			})
			.where(eq(Organization.id, organization.id))
		await notifyReservationsContextChanged(organization.id, 'payments')
		return { ok: true, provider: 'stripe', organizationId: organization.id }
	}

	let entityId = organization.checkoutSubEntityId
	if (entityId && !(await emulator.object('checkout', entityId))) {
		await db
			.update(Organization)
			.set({
				checkoutSubEntityId: null,
				checkoutChargesEnabled: false,
				checkoutPayoutsEnabled: false,
				updatedAt: new Date(),
			})
			.where(eq(Organization.id, organization.id))
		entityId = null
		await notifyReservationsContextChanged(organization.id, 'payments')
	}
	const entity = await inviteCheckoutSubEntityOnboarding(
		{
			id: organization.id,
			dataRegion: organization.dataRegion,
			checkoutSubEntityId: entityId,
		},
		MOCK_INVITEE_EMAIL,
	)
	await emulator.testing.activateEntity(entity.id)
	await syncCheckoutSubEntityStatus(organization.id)
	return { ok: true, provider: 'checkout', organizationId: organization.id }
}

/**
 * Forget onboarding state that points into the wiped emulator. Only the
 * providers that are mocked: a real sandbox account is never cleared.
 */
export async function clearMockOnboardingColumns() {
	const status = getPaymentsMockStatus()
	if (status.stripe) {
		const cleared = await db
			.update(Organization)
			.set({
				stripeConnectAccountId: null,
				stripeConnectChargesEnabled: false,
				stripeConnectPayoutsEnabled: false,
				updatedAt: new Date(),
			})
			.where(isNotNull(Organization.stripeConnectAccountId))
			.returning({ id: Organization.id })
		for (const { id } of cleared) {
			await notifyReservationsContextChanged(id, 'payments')
		}
	}
	if (status.checkout) {
		const cleared = await db
			.update(Organization)
			.set({
				checkoutSubEntityId: null,
				checkoutChargesEnabled: false,
				checkoutPayoutsEnabled: false,
				updatedAt: new Date(),
			})
			.where(isNotNull(Organization.checkoutSubEntityId))
			.returning({ id: Organization.id })
		for (const { id } of cleared) {
			await notifyReservationsContextChanged(id, 'payments')
		}
	}
}
