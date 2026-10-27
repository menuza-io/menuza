/**
 * @vitest-environment jsdom
 */
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRoutesStub } from 'react-router'
import { describe, expect, it } from 'vitest'
import { renderWithI18n as render } from '#tests/utils.tsx'
import PrintShopAdminRoute from './print-shop.tsx'

type Order = {
	id: string
	status: string
	totalCents: number
	taxCents: number
	wholesaleCents: number
	refundCents: number
	holdReason: string | null
	failureReason: string | null
	createdAt: string
	organization: string
	vendorReferences: Array<{ id: string; vendor: string; pending: boolean }>
	marginCents: number
}

function renderAdmin(options: {
	refundRemovesActions: boolean
	/** Holds the action until released, to look while it is in flight. */
	gate?: Promise<void>
}) {
	const order: Order = {
		id: 'po_1',
		status: 'shipped',
		totalCents: 5000,
		taxCents: 0,
		wholesaleCents: 3000,
		refundCents: 0,
		holdReason: null,
		failureReason: null,
		createdAt: '2026-10-01T12:00:00.000Z',
		organization: 'Studio',
		vendorReferences: [],
		marginCents: 2000,
	}
	const sent: string[] = []
	const App = createRoutesStub([
		{
			path: '/print-shop',
			Component: PrintShopAdminRoute,
			HydrateFallback: () => null,
			loader: () => ({
				settings: { markupBp: 3000, driftHoldBp: 1000, quoteTtlMinutes: 30 },
				sizes: [],
				catalog: [],
				orders: [{ ...order }],
			}),
			action: async ({ request }) => {
				const form = await request.formData()
				sent.push(String(form.get('_action')))
				if (sent.length > 1) await options.gate
				if (options.refundRemovesActions) order.status = 'refunded'
				return { ok: true, done: 'refunded' }
			},
		},
	])
	render(<App initialEntries={['/print-shop']} />)
	return { sent }
}

const confirmIn = (dialog: HTMLElement) =>
	within(dialog)
		.getAllByRole('button')
		.find((button) => button.getAttribute('type') === 'submit')!

describe('Print shop Admin order actions', () => {
	it('keeps a confirmed dialog closed when another action on the row is sent', async () => {
		const user = userEvent.setup()
		let release = () => {}
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		const { sent } = renderAdmin({ refundRemovesActions: false, gate })
		const triggers = await screen.findAllByRole('button', { name: /^Refund/ })
		expect(triggers.length).toBeGreaterThanOrEqual(2)

		await user.click(triggers[0]!)
		await user.click(confirmIn(await screen.findByRole('alertdialog')))
		await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())

		await user.click(screen.getAllByRole('button', { name: /^Refund/ })[1]!)
		const second = await screen.findByRole('alertdialog')
		await user.click(confirmIn(second))
		// While the second request is on the shared fetcher, only its own
		// dialog is open: the first one does not come back.
		await waitFor(() => expect(sent).toHaveLength(2))
		expect(screen.getAllByRole('alertdialog')).toEqual([second])
		release()
		await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
	})

	it('puts focus on the order when a refund removes its buttons', async () => {
		const user = userEvent.setup()
		renderAdmin({ refundRemovesActions: true })
		await user.click(
			(await screen.findAllByRole('button', { name: /^Refund/ }))[0]!,
		)
		await user.click(confirmIn(await screen.findByRole('alertdialog')))
		await waitFor(() =>
			expect(screen.queryAllByRole('button', { name: /^Refund/ })).toHaveLength(
				0,
			),
		)
		await waitFor(() =>
			expect(
				screen.getByRole('group', { name: /the .* order of Studio/ }),
			).toHaveFocus(),
		)
	})
})
