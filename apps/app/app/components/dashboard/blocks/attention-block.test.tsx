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
			offlineTablets: false,
		},
		locations: [olaya],
		openHours: {},
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

	it('shows a Station tablet that went silent during opening hours, and not one that is off for the night (#190)', async () => {
		const now = Date.now()
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
					devices: [
						{
							id: 'd1',
							label: 'Kitchen',
							locationId: 'loc_olaya',
							lastSeenAt: now - 12 * 60_000,
							revokedAt: null,
						},
						{
							id: 'd2',
							label: 'Spare tablet',
							locationId: 'loc_olaya',
							lastSeenAt: now - 12 * 60_000,
							revokedAt: null,
						},
					],
				}),
			)
		})
		renderBlock(
			data({
				regional: {
					paymentReview: false,
					callFollowUps: false,
					inventoryCounts: false,
					offlineTablets: true,
				},
				openHours: {
					loc_olaya: [{ startMs: now - 3_600_000, endMs: now + 3_600_000 }],
				},
			}),
		)
		const item = await screen.findByTestId('attention-item-station_offline')
		expect(item).toHaveTextContent(
			'1 Station tablet at Olaya has been offline for a while',
		)
		expect(
			within(item).queryByRole('button', { name: /Dismiss/ }),
		).not.toBeInTheDocument()
	})

	it('shows no offline tablet outside opening hours', async () => {
		const now = Date.now()
		fetchMock.mockImplementation(async (input: unknown) =>
			String(input).endsWith('/orders-token')
				? new Response(
						JSON.stringify({
							jwt: 'orders.jwt',
							tenantApiUrl: 'http://tenant.test',
						}),
					)
				: new Response(
						JSON.stringify({
							devices: [
								{
									id: 'd1',
									label: 'Kitchen',
									locationId: 'loc_olaya',
									lastSeenAt: now - 12 * 60_000,
									revokedAt: null,
								},
							],
						}),
					),
		)
		renderBlock(
			data({
				regional: {
					paymentReview: false,
					callFollowUps: false,
					inventoryCounts: false,
					offlineTablets: true,
				},
				openHours: {
					loc_olaya: [
						{ startMs: now + 5 * 3_600_000, endMs: now + 9 * 3_600_000 },
					],
				},
			}),
		)
		await waitFor(() => expect(fetchMock).toHaveBeenCalled())
		await new Promise((resolve) => setTimeout(resolve, 20))
		expect(
			screen.queryByTestId('attention-item-station_offline'),
		).not.toBeInTheDocument()
	})

	it('says when nothing needs attention', async () => {
		renderBlock(
			data({
				items: [],
				regional: {
					paymentReview: false,
					callFollowUps: false,
					inventoryCounts: false,
					offlineTablets: false,
				},
			}),
		)
		expect(await screen.findByTestId('attention-empty')).toHaveTextContent(
			'Nothing needs your attention.',
		)
	})
})
