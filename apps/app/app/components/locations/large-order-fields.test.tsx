// @vitest-environment jsdom
import { screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { type LargeOrderFormFields } from '#app/utils/orders/ordering-settings.ts'
import { renderStaff } from '#tests/staff-render.tsx'
import { LargeOrderFields } from './checkout-rules-cards.tsx'

function Harness({
	initial,
	currency = 'SAR',
	spy,
}: {
	initial: LargeOrderFormFields
	currency?: string | null
	spy?: (patch: Partial<LargeOrderFormFields>) => void
}) {
	const [values, setValues] = useState(initial)
	return (
		<LargeOrderFields
			values={values}
			currency={currency}
			onChange={(patch) => {
				setValues((prev) => ({ ...prev, ...patch }))
				spy?.(patch)
			}}
		/>
	)
}

const EMPTY = {
	largeOrderItems: '',
	largeOrderAmount: '',
	largeOrderMinutes: '',
}

describe('LargeOrderFields (#355)', () => {
	it('shows both thresholds and the minutes, with the currency named', () => {
		renderStaff(
			<Harness
				initial={{
					largeOrderItems: '12',
					largeOrderAmount: '300',
					largeOrderMinutes: '15',
				}}
			/>,
		)
		expect(screen.getByLabelText(/More than \(items\)/)).toHaveValue('12')
		expect(screen.getByLabelText(/Or over \(SAR\)/)).toHaveValue('300')
		expect(screen.getByLabelText('Add (minutes)')).toHaveValue('15')
		expect(screen.getByTestId('large-orders-fields')).toHaveTextContent(
			'Leave one empty to use only the other',
		)
	})

	it('marks both thresholds optional and the minutes required', () => {
		renderStaff(<Harness initial={EMPTY} />)
		expect(screen.getAllByText('(optional)')).toHaveLength(2)
	})

	it('reports what was typed in each field', async () => {
		const spy = vi.fn()
		renderStaff(<Harness initial={EMPTY} spy={spy} />)
		const user = userEvent.setup()
		await user.type(screen.getByLabelText(/More than \(items\)/), '8')
		await user.type(screen.getByLabelText(/Or over/), '250')
		await user.type(screen.getByLabelText('Add (minutes)'), '10')
		expect(spy).toHaveBeenCalledWith({ largeOrderItems: '8' })
		expect(spy).toHaveBeenCalledWith({ largeOrderAmount: '2' })
		expect(spy).toHaveBeenCalledWith({ largeOrderAmount: '250' })
		expect(spy).toHaveBeenCalledWith({ largeOrderMinutes: '10' })
	})

	it('still labels the amount while a new location has no currency yet', () => {
		renderStaff(<Harness initial={EMPTY} currency={null} />)
		expect(screen.getByLabelText(/Or over \(amount\)/)).toBeInTheDocument()
	})
})
