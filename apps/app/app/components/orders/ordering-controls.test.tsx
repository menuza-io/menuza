// @vitest-environment jsdom
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { OrderingControls } from './ordering-controls.tsx'

describe('OrderingControls (#95)', () => {
	it('shows "Also pause delivery apps" checked by default when location has delivery connections and passes it on pause', async () => {
		i18n.load('en', {})
		i18n.activate('en')

		const submitted: Array<Record<string, string>> = []
		const router = createMemoryRouter(
			[
				{
					path: '/:orgSlug/orders',
					element: (
						<OrderingControls
							orgSlug="bistro"
							canWrite={true}
							locations={[
								{
									id: 'loc_1',
									name: 'Downtown',
									timezone: 'America/New_York',
									pausedAt: null,
									pausedUntil: null,
									busyExtraPrepMinutes: 0,
									busyUntil: null,
									prepTime: 15,
									variablePrepMinutes: null,
									variablePrepUntil: null,
									hasDeliveryConnections: true,
								},
							]}
						/>
					),
				},
				{
					path: '/:orgSlug/orders/ordering-controls',
					action: async ({ request }) => {
						const formData = await request.formData()
						submitted.push(
							Object.fromEntries(formData.entries()) as Record<string, string>,
						)
						return Response.json({ ok: true, error: null })
					},
				},
			],
			{ initialEntries: ['/bistro/orders'] },
		)

		render(
			<I18nProvider i18n={i18n}>
				<RouterProvider router={router} />
			</I18nProvider>,
		)

		const checkbox = screen.getByRole('checkbox', {
			name: /Also pause delivery apps/i,
		})
		expect(checkbox).toBeChecked()

		// Uncheck it and pause for 30m -> sends alsoPauseDelivery: 'false'
		fireEvent.click(checkbox)
		expect(checkbox).not.toBeChecked()

		fireEvent.click(screen.getByTestId('pause-ordering-menu'))
		fireEvent.click(await screen.findByTestId('pause-30m'))

		await waitFor(() => {
			expect(submitted).toHaveLength(1)
		})
		expect(submitted[0]).toEqual({
			locationId: 'loc_1',
			intent: 'pause',
			duration: '30m',
			alsoPauseDelivery: 'false',
		})
	})

	it('displays platform_pause_failed notice with Retry button and submits retry-delivery-pause', async () => {
		i18n.load('en', {})
		i18n.activate('en')

		const actionSpy = vi.fn(async ({ request }: { request: Request }) => {
			const formData = await request.formData()
			if (formData.get('intent') === 'retry-delivery-pause') {
				return Response.json({
					ok: true,
					error: null,
					deliveryPauseError: null,
					failedDeliveryStores: [],
				})
			}
			return Response.json({ ok: true, error: null })
		})

		const router = createMemoryRouter(
			[
				{
					path: '/:orgSlug/orders',
					element: (
						<OrderingControls
							orgSlug="bistro"
							canWrite={true}
							locations={[
								{
									id: 'loc_1',
									name: 'Downtown',
									timezone: 'America/New_York',
									pausedAt: '2026-11-24T18:00:00.000Z',
									pausedUntil: '2026-11-24T18:30:00.000Z',
									busyExtraPrepMinutes: 0,
									busyUntil: null,
									prepTime: 15,
									variablePrepMinutes: null,
									variablePrepUntil: null,
									hasDeliveryConnections: true,
									deliveryPauseFailures: [
										{
											integrationId: 'int_dd',
											providerName: 'doordash',
											displayName: 'DoorDash',
											error: 'The provider is temporarily unavailable.',
										},
									],
								},
							]}
						/>
					),
				},
				{
					path: '/:orgSlug/orders/ordering-controls',
					action: actionSpy,
				},
			],
			{ initialEntries: ['/bistro/orders'] },
		)

		render(
			<I18nProvider i18n={i18n}>
				<RouterProvider router={router} />
			</I18nProvider>,
		)

		expect(
			screen.getByText(
				/Could not update DoorDash: The provider is temporarily unavailable\./i,
			),
		).toBeInTheDocument()

		fireEvent.click(screen.getByTestId('retry-delivery-pause-int_dd'))

		await waitFor(() => {
			expect(actionSpy).toHaveBeenCalledTimes(1)
		})
		const req = actionSpy.mock.calls[0]?.[0]?.request
		expect(req).toBeDefined()
		await waitFor(() => {
			expect(
				screen.queryByTestId('delivery-pause-error-int_dd'),
			).not.toBeInTheDocument()
		})
	})
})
