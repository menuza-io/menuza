import { db, eq, Organization, SubscriptionChangeRequest } from '@repo/database'
import type * as paymentsModule from '@repo/payments'
import { RouterContextProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __setMockLaunchStatus } from '#app/utils/env.server.ts'
import {
	addOrganizationMember,
	createAuthenticatedRequest,
	createTestSession,
	createTestUser,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'

const provider = vi.hoisted(() => ({
	calls: [] as string[],
}))

vi.mock('@repo/payments', async (importOriginal) => {
	const actual = await importOriginal<typeof paymentsModule>()
	return {
		...actual,
		createStripeProvider: () => ({
			getClient: () => ({
				subscriptions: { list: async () => ({ data: [] }) },
			}),
			getPlansAndPrices: async () => ({
				plans: {
					base: { id: 'prod_base', name: 'Base' },
					plus: { id: 'prod_plus', name: 'Plus' },
				},
				prices: { base: {}, plus: {} },
			}),
			retrieveSubscription: async () => ({
				id: 'sub_1',
				status: 'active',
				customerId: 'cus_1',
				productId: 'prod_plus',
				priceId: 'price',
				items: [],
				currentPeriodEnd: new Date('2026-12-14T00:00:00Z'),
			}),
			cancelSubscription: async () => {
				provider.calls.push('cancel')
			},
			updateSubscription: async () => {
				provider.calls.push('update')
			},
		}),
	}
})

const { action, loader } = await import('./billing_.cancel.tsx')

async function setup() {
	const { organization, cookie } = await setupTestOrgWithUser('admin')
	await db
		.update(Organization)
		.set({
			stripeCustomerId: 'cus_1',
			stripeSubscriptionId: 'sub_1',
			stripeProductId: 'prod_plus',
			planName: 'Plus',
			subscriptionStatus: 'active',
		})
		.where(eq(Organization.id, organization.id))
	return { organization, cookie }
}

function args(slug: string, cookie: string, init: RequestInit = {}) {
	const url = new URL(`http://localhost:3001/${slug}/settings/billing/cancel`)
	return {
		request: createAuthenticatedRequest(url.toString(), init, cookie),
		params: { orgSlug: slug },
		context: new RouterContextProvider(),
		url,
		pattern: '/:orgSlug/settings/billing/cancel',
	} as never
}

describe('cancel or downgrade page (#379)', () => {
	beforeEach(() => {
		__setMockLaunchStatus('LAUNCHED')
		provider.calls.length = 0
	})
	afterEach(() => {
		__setMockLaunchStatus(null)
	})

	it('shows the cutoff date, the export links and the smaller plan before anything is sent', async () => {
		const { organization, cookie } = await setup()
		const result = (await loader(args(organization.slug, cookie))) as any
		expect(result.context.cutoff).toBe('2026-12-14T00:00:00.000Z')
		expect(result.context.downgradeTo).toBe('Base')
		expect(result.downloads.map((d: { key: string }) => d.key)).toEqual([
			'menu',
			'customers',
			'reports',
			'website',
		])
		expect(provider.calls).toEqual([])
	})

	it('records a request, redirects back to billing and cancels nothing', async () => {
		const { organization, cookie } = await setup()
		const response = (await action(
			args(organization.slug, cookie, {
				method: 'POST',
				body: new URLSearchParams({
					intent: 'request',
					kind: 'cancel_organization',
					reason: 'switching',
					subReason: 'other_platform',
					note: '',
					confirm: 'true',
				}),
			}),
		)) as Response
		expect(response.status).toBe(302)
		expect(response.headers.get('Location')).toBe(
			`/${organization.slug}/settings/billing`,
		)
		const rows = await db
			.select()
			.from(SubscriptionChangeRequest)
			.where(eq(SubscriptionChangeRequest.organizationId, organization.id))
		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatchObject({
			reason: 'switching',
			subReason: 'other_platform',
			status: 'requested',
		})
		expect(provider.calls).toEqual([])
		const [org] = await db
			.select({ status: Organization.subscriptionStatus })
			.from(Organization)
			.where(eq(Organization.id, organization.id))
		expect(org?.status).toBe('active')
	})

	it('answers 400 without the confirmation and writes nothing', async () => {
		const { organization, cookie } = await setup()
		const response = (await action(
			args(organization.slug, cookie, {
				method: 'POST',
				body: new URLSearchParams({
					intent: 'request',
					kind: 'cancel_organization',
					reason: 'switching',
				}),
			}),
		)) as any
		expect(response.init?.status ?? response.status).toBe(400)
		expect(
			await db
				.select()
				.from(SubscriptionChangeRequest)
				.where(eq(SubscriptionChangeRequest.organizationId, organization.id)),
		).toHaveLength(0)
	})

	it('is for members who can change the subscription only', async () => {
		const { organization } = await setup()
		const viewer = await createTestUser()
		await addOrganizationMember(viewer.id, organization.id, 'org_role_viewer')
		const { cookie } = await createTestSession(viewer.id)
		await expect(loader(args(organization.slug, cookie))).rejects.toMatchObject(
			{
				status: 403,
			},
		)
		await expect(
			action(
				args(organization.slug, cookie, {
					method: 'POST',
					body: new URLSearchParams({ intent: 'request' }),
				}),
			),
		).rejects.toMatchObject({ status: 403 })
	})

	it('withdraws an open request without changing anything', async () => {
		const { organization, cookie } = await setup()
		await action(
			args(organization.slug, cookie, {
				method: 'POST',
				body: new URLSearchParams({
					intent: 'request',
					kind: 'cancel_organization',
					reason: 'other',
					confirm: 'true',
				}),
			}),
		).catch(() => null)
		const [row] = await db
			.select()
			.from(SubscriptionChangeRequest)
			.where(eq(SubscriptionChangeRequest.organizationId, organization.id))
		await action(
			args(organization.slug, cookie, {
				method: 'POST',
				body: new URLSearchParams({ intent: 'withdraw', requestId: row!.id }),
			}),
		).catch(() => null)
		const [after] = await db
			.select({ status: SubscriptionChangeRequest.status })
			.from(SubscriptionChangeRequest)
			.where(eq(SubscriptionChangeRequest.id, row!.id))
		expect(after?.status).toBe('withdrawn')
		expect(provider.calls).toEqual([])
	})
})
