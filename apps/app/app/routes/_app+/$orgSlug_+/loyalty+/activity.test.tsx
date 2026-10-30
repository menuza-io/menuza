// @vitest-environment jsdom
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { type LoyaltyOperatorParkedSource } from '@repo/loyalty'
import { render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { createRoutesStub, Outlet } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { LoyaltyClientContext } from '#app/components/loyalty/loyalty-client-provider.tsx'
import {
	LoyaltyApiError,
	type LoyaltyClient,
	type LoyaltyClientPool,
	type LoyaltyReviewQueue,
} from '#app/utils/loyalty/loyalty-client.ts'
import LoyaltyActivityRoute from './activity.tsx'

const PARKED: LoyaltyOperatorParkedSource = {
	sourceType: 'pos_order',
	sourceId: 'sale_1',
	memberId: 'mem_1',
	locationId: null,
	attempts: 5,
	lastError: 'loyalty_unavailable',
	parkedAt: 1_700_000_000_000,
}

const EMPTY: LoyaltyReviewQueue = { redemptions: [], purchases: [], parked: [] }

function entry(id: string, customerId: string | null) {
	return {
		id,
		at: 1_700_000_000_000,
		memberId: 'mem_1',
		customerId,
		type: 'earn',
		delta: 12,
		channel: 'web',
		locationId: null,
		purchaseId: null,
		redemptionId: null,
		reason: null,
		note: null,
		actorKind: 'system',
		actorId: null,
	} as const
}

function fakeClient(
	requeue: LoyaltyClient['requeue'],
	entries: ReturnType<typeof entry>[] = [],
) {
	return {
		listActivity: vi.fn(async () => ({ entries, nextCursor: null })),
		getReview: vi
			.fn<LoyaltyClient['getReview']>()
			.mockResolvedValueOnce({ ...EMPTY, parked: [PARKED] })
			.mockResolvedValue(EMPTY),
		requeue: vi.fn(requeue),
	}
}

function renderActivity(client: ReturnType<typeof fakeClient>) {
	i18n.load('en', {})
	i18n.activate('en')
	const pool = {
		orgSlug: 'acme',
		forScope: vi.fn(),
		invalidateAll: vi.fn(),
	} as unknown as LoyaltyClientPool
	function Layout() {
		return (
			<LoyaltyClientContext.Provider
				value={{ pool, client: client as unknown as LoyaltyClient }}
			>
				<Outlet />
			</LoyaltyClientContext.Provider>
		)
	}
	const Stub = createRoutesStub([
		{
			path: '/acme/loyalty',
			Component: Layout,
			HydrateFallback: () => null,
			children: [
				{
					path: 'activity',
					Component: LoyaltyActivityRoute,
					HydrateFallback: () => null,
					loader: () => ({ orgSlug: 'acme', canReview: true }),
				},
			],
		},
	])
	return render(
		<I18nProvider i18n={i18n}>
			<Stub initialEntries={['/acme/loyalty/activity']} />
		</I18nProvider>,
	)
}

describe('Loyalty review queue: sales the tick gave up on', () => {
	it('lists a parked sale and queues it again', async () => {
		const client = fakeClient(async () => ({ queued: true }))
		renderActivity(client)

		const row = await screen.findByTestId(
			'loyalty-review-parked-pos_order-sale_1',
		)
		expect(row).toHaveTextContent('Register sale')
		expect(row).toHaveTextContent('5 attempts failed')
		expect(row).toHaveTextContent('loyalty_unavailable')
		expect(screen.queryByTestId('loyalty-review-empty')).toBeNull()

		await userEvent.click(
			screen.getByTestId('loyalty-review-retry-pos_order-sale_1'),
		)

		expect(client.requeue).toHaveBeenCalledWith({
			type: 'pos_order',
			id: 'sale_1',
		})
		await waitFor(() =>
			expect(screen.getByTestId('loyalty-review-notice')).toHaveTextContent(
				'Queued again. If it still fails, it comes back here.',
			),
		)
		expect(await screen.findByTestId('loyalty-review-empty')).toBeVisible()
		expect(
			screen.queryByTestId('loyalty-review-parked-pos_order-sale_1'),
		).toBeNull()
		expect(client.getReview).toHaveBeenCalledTimes(2)
		// The row and its button are gone: focus moves to the queue's heading.
		expect(
			screen.getByRole('heading', { name: 'Waiting for review' }),
		).toHaveFocus()
	})

	it('says so when nothing was left to update on the sale', async () => {
		const client = fakeClient(async () => ({ queued: false }))
		renderActivity(client)

		await userEvent.click(
			await screen.findByTestId('loyalty-review-retry-pos_order-sale_1'),
		)

		await waitFor(() =>
			expect(screen.getByTestId('loyalty-review-notice')).toHaveTextContent(
				'Nothing was left to update on that sale, so it was cleared.',
			),
		)
	})

	it('keeps the row and explains a refusal', async () => {
		const client = fakeClient(() =>
			Promise.reject(
				new LoyaltyApiError('Forbidden', 403, 'location_forbidden'),
			),
		)
		renderActivity(client)

		await userEvent.click(
			await screen.findByTestId('loyalty-review-retry-pos_order-sale_1'),
		)

		expect(await screen.findByTestId('loyalty-review-error')).toBeVisible()
		expect(
			screen.getByTestId('loyalty-review-parked-pos_order-sale_1'),
		).toBeVisible()
		expect(screen.getByTestId('loyalty-review-notice')).toHaveTextContent('')
		expect(client.getReview).toHaveBeenCalledTimes(1)
	})
})

describe('Loyalty activity: who a movement belongs to', () => {
	it('links a row to the customer page, and shows plain text once erased', async () => {
		const client = fakeClient(
			async () => ({ queued: true }),
			[entry('led_1', 'cus_1'), entry('led_2', null)],
		)
		renderActivity(client)

		const link = await screen.findByTestId('loyalty-activity-customer-link')
		expect(link).toHaveAttribute('href', '/acme/customers/c_cus_1')
		expect(
			screen.getAllByTestId('loyalty-activity-customer-link'),
		).toHaveLength(1)
		expect(
			screen.getByTestId('loyalty-activity-customer-erased'),
		).toHaveTextContent('Customer erased')
	})
})
