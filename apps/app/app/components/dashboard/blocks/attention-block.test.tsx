// @vitest-environment jsdom
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	attentionItem,
	type AttentionData,
} from '#app/utils/dashboards/attention.ts'
import { resetHomeLocationMemory } from '../use-home-location.ts'
import { AttentionBlock } from './attention-block.tsx'

const olaya = { id: 'loc_olaya', name: 'Olaya', timeZone: 'Asia/Riyadh' }

function data(overrides: Partial<AttentionData> = {}): AttentionData {
	return {
		items: [
			attentionItem('payments_not_connected', null, { href: '/settings/shop' }),
			attentionItem('channel_off', olaya, {
				href: '/settings/locations/loc_olaya',
				channels: ['delivery'],
			}),
		],
		dismissedKeys: [],
		regional: {
			paymentReview: true,
			callFollowUps: false,
			inventoryCounts: false,
		},
		locations: [olaya],
		...overrides,
	}
}

function renderBlock(attention: AttentionData) {
	const router = createMemoryRouter(
		[
			{
				path: '*',
				element: (
					<I18nProvider i18n={i18n}>
						<AttentionBlock
							orgSlug="acme"
							data={attention}
							locationStorageKey="home-location:user:org"
						/>
					</I18nProvider>
				),
			},
		],
		{ initialEntries: ['/acme'] },
	)
	return render(<RouterProvider router={router} />)
}

describe('AttentionBlock', () => {
	const fetchMock = vi.fn()

	beforeEach(() => {
		resetHomeLocationMemory()
		fetchMock.mockReset()
		vi.stubGlobal('fetch', fetchMock)
		i18n.load('en', {})
		i18n.activate('en')
	})

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it('keeps the other items when a regional source fails', async () => {
		fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
		renderBlock(data())
		const list = await screen.findByTestId('attention-items')
		await waitFor(() => expect(fetchMock).toHaveBeenCalled())
		expect(
			within(list).getByTestId('attention-item-payments_not_connected'),
		).toBeInTheDocument()
		expect(
			within(list).getByTestId('attention-item-channel_off'),
		).toHaveTextContent('Delivery switched off at Olaya')
	})

	it('adds regional counts, urgent first, without a dismiss button', async () => {
		fetchMock.mockImplementation(async (input: unknown) => {
			const url = String(input)
			if (url.endsWith('/orders-token')) {
				return new Response(
					JSON.stringify({
						jwt: 'orders.jwt',
						tenantApiUrl: 'http://tenant.test',
					}),
				)
			}
			return new Response(
				JSON.stringify({
					locations: [{ locationId: 'loc_olaya', paymentReview: 2 }],
				}),
			)
		})
		renderBlock(data())
		const review = await screen.findByTestId('attention-item-payment_review')
		expect(review).toHaveTextContent('2 orders at Olaya need a payment review')
		expect(
			within(review).queryByRole('button', { name: /Dismiss/ }),
		).not.toBeInTheDocument()
		const channel = screen.getByTestId('attention-item-channel_off')
		expect(
			within(channel).getByRole('button', { name: /Dismiss for a week/ }),
		).toBeInTheDocument()
	})

	it('says when nothing needs attention', async () => {
		renderBlock(
			data({
				items: [],
				regional: {
					paymentReview: false,
					callFollowUps: false,
					inventoryCounts: false,
				},
			}),
		)
		expect(await screen.findByTestId('attention-empty')).toHaveTextContent(
			'Nothing needs your attention.',
		)
	})
})
