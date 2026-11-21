// @vitest-environment jsdom
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { AttributionPanel } from './attribution-panel.tsx'

i18n.loadAndActivate({ locale: 'en', messages: {} })

const view = {
	currency: 'usd',
	clicked: { orders: 3, revenueMinor: 4500 },
	reached: { orders: 8, revenueMinor: 12000 },
}

function show() {
	render(
		<I18nProvider i18n={i18n}>
			<AttributionPanel view={view} />
		</I18nProvider>,
	)
}

describe('AttributionPanel (#115)', () => {
	it('starts on Clicked', () => {
		show()
		expect(screen.getByTestId('attribution-panel')).toHaveAttribute(
			'data-mode',
			'clicked',
		)
		expect(screen.getByTestId('attribution-panel-orders')).toHaveTextContent(
			'3',
		)
		expect(screen.getByTestId('attribution-panel-revenue')).toHaveTextContent(
			'$45.00',
		)
		expect(screen.getByText('Orders after a click')).toBeInTheDocument()
		expect(screen.getByText('Revenue after a click')).toBeInTheDocument()
	})

	it('Reached changes the figures and the labels, and is never below Clicked', async () => {
		show()
		await userEvent.click(screen.getByTestId('attribution-panel-reached'))
		expect(screen.getByTestId('attribution-panel')).toHaveAttribute(
			'data-mode',
			'reached',
		)
		const orders = Number(
			screen.getByTestId('attribution-panel-orders').textContent,
		)
		expect(orders).toBe(8)
		expect(orders).toBeGreaterThanOrEqual(view.clicked.orders)
		expect(screen.getByTestId('attribution-panel-revenue')).toHaveTextContent(
			'$120.00',
		)
		expect(screen.getByText('Orders from guests reached')).toBeInTheDocument()
		expect(screen.getByText('Revenue from guests reached')).toBeInTheDocument()
		expect(screen.queryByText('Orders after a click')).not.toBeInTheDocument()

		await userEvent.click(screen.getByTestId('attribution-panel-clicked'))
		expect(screen.getByTestId('attribution-panel-orders')).toHaveTextContent(
			'3',
		)
	})
})
