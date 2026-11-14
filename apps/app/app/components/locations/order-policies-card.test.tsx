// @vitest-environment jsdom
import { screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { renderStaff } from '#tests/staff-render.tsx'
import {
	OrderPoliciesCard,
	type OrderPolicyValues,
} from './order-policies-card.tsx'

const VALUES: OrderPolicyValues = {
	guestCancelMinutes: '5',
	guestCancelScheduledLeadMinutes: '',
	orderAcceptanceMode: 'manual',
	orderAcceptanceTimeoutMinutes: '5',
	orderAcceptanceMinTotal: '',
	orderAcceptanceScheduledOnly: false,
}

function show(error?: Parameters<typeof OrderPoliciesCard>[0]['error']) {
	renderStaff(
		<OrderPoliciesCard
			flags={{ guestCancel: true, acceptance: true }}
			currency="USD"
			values={VALUES}
			onChange={vi.fn()}
			error={error}
		/>,
	)
}

describe('OrderPoliciesCard accessibility', () => {
	it('gives every select and field an accessible name and its hint', () => {
		show()
		expect(
			screen.getByRole('combobox', { name: 'Guests can cancel within' }),
		).toHaveAttribute('aria-describedby', 'guest-cancel-minutes-hint')
		expect(
			screen.getByRole('combobox', { name: 'Order acceptance' }),
		).toBeInTheDocument()
		expect(
			screen.getByRole('combobox', { name: 'Reject automatically after' }),
		).toBeInTheDocument()
		expect(
			screen.getByRole('textbox', { name: /Only for orders over/ }),
		).toHaveAttribute('aria-describedby', 'acceptance-min-total-hint')
	})

	it('reads the minimum total as text so Arabic digits are not dropped', () => {
		show()
		const total = screen.getByRole('textbox', { name: /Only for orders over/ })
		expect(total).toHaveAttribute('type', 'text')
		expect(total).toHaveAttribute('inputmode', 'decimal')
		expect(total).toHaveAttribute('dir', 'ltr')
		const lead = screen.getByRole('textbox', { name: /Scheduled orders/ })
		expect(lead).toHaveAttribute('type', 'text')
	})

	it('words a refused field and marks only that control invalid', () => {
		show({ field: 'orderAcceptanceMinTotal', code: 'invalid_amount' })
		const total = screen.getByRole('textbox', { name: /Only for orders over/ })
		expect(total).toHaveAttribute('aria-invalid', 'true')
		expect(total.getAttribute('aria-describedby')).toContain(
			'acceptance-min-total-error',
		)
		expect(
			screen.getByText('Enter an amount, for example 25 or 25.50.'),
		).toBeInTheDocument()
		expect(
			screen.getByRole('combobox', { name: 'Guests can cancel within' }),
		).not.toHaveAttribute('aria-invalid')
	})

	it('says minutes with a plural, not a fixed English pair', () => {
		show()
		expect(
			screen.getByRole('combobox', { name: 'Reject automatically after' }),
		).toHaveTextContent('5 minutes')
	})
})
