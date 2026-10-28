/** @vitest-environment jsdom */
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { render, screen } from '@testing-library/react'
import { createRoutesStub } from 'react-router'
import { describe, expect, it } from 'vitest'
import { loadCatalog } from '#app/modules/lingui/lingui.ts'
import PrintOrderRoute from './print.orders.$orderId.tsx'

async function renderHeldOrder(holdReason: string) {
	await loadCatalog('en')
	const App = createRoutesStub([
		{
			path: '/order',
			Component: PrintOrderRoute,
			HydrateFallback: () => null,
			loader: () => ({
				orgSlug: 'studio',
				canPay: true,
				canCancel: true,
				justPaid: false,
				paymentCancelled: false,
				order: {
					id: 'po_1',
					status: 'held',
					holdReason,
					currency: 'usd',
					itemsCents: 4000,
					shippingCents: 1000,
					taxCents: 0,
					totalCents: 5000,
					refundCents: 0,
					quoteExpiresAt: '2026-10-01T12:00:00.000Z',
					createdAt: '2026-10-01T12:00:00.000Z',
					address: [],
				},
				items: [],
				shipments: [],
			}),
		},
	])
	render(
		<I18nProvider i18n={i18n}>
			<App initialEntries={['/order']} />
		</I18nProvider>,
	)
	await screen.findByText('Your order is on hold')
}

describe('held print orders', () => {
	it.each(['vendor_after_shipping', 'vendor_returned', 'vendor_unknown'])(
		'reserves %s resolution for Admin',
		async (holdReason) => {
			await renderHeldOrder(holdReason)
			expect(screen.queryByRole('button', { name: 'Cancel order' })).toBeNull()
			expect(
				screen.queryByText(/You can still cancel for a full refund/),
			).toBeNull()
			expect(
				screen.getByText(/Only Admin can resolve this hold/),
			).toBeInTheDocument()
		},
	)

	it('still offers cancellation and a full refund for a rendering hold', async () => {
		await renderHeldOrder('render_unavailable')
		expect(
			screen.getByRole('button', { name: 'Cancel order' }),
		).toBeInTheDocument()
		expect(
			screen.getByText(/You can still cancel for a full refund/),
		).toBeInTheDocument()
	})
})
