// @vitest-environment jsdom
import { defaultTipSettings } from '@repo/common/location-types'
import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
	emptyFeeForm,
	tipFormFromSettings,
	type FeeFormValues,
	type TipFormValues,
} from '#app/utils/orders/checkout-settings.ts'
import { renderStaff } from '#tests/staff-render.tsx'
import { ServiceFeeCard, TipChoicesCard } from './checkout-settings-cards.tsx'

function tips() {
	return tipFormFromSettings(defaultTipSettings('USD'), 'USD')
}

function showTips(
	values: TipFormValues = tips(),
	extra: Partial<Parameters<typeof TipChoicesCard>[0]> = {},
) {
	const onChange = vi.fn()
	renderStaff(
		<TipChoicesCard currency="USD" values={values} onChange={onChange} {...extra} />,
	)
	return onChange
}

function showFee(
	values: FeeFormValues = { ...emptyFeeForm('USD'), enabled: true },
	extra: Partial<Parameters<typeof ServiceFeeCard>[0]> = {},
) {
	const onChange = vi.fn()
	renderStaff(
		<ServiceFeeCard currency="USD" values={values} onChange={onChange} {...extra} />,
	)
	return onChange
}

describe('TipChoicesCard', () => {
	it('shows each order type with its choices, default and custom switch', () => {
		showTips()
		for (const type of ['pickup', 'delivery', 'qrTab']) {
			expect(screen.getByTestId(`tip-choices-${type}`)).toBeInTheDocument()
		}
		expect(screen.getByLabelText('Percent of the subtotal', { selector: '#tip-pickup-value-1' })).toHaveValue('15')
		expect(
			screen.getAllByRole('switch', { name: 'Let guests enter their own amount' }),
		).toHaveLength(3)
	})

	it('adds a choice and stops at four', () => {
		const full = tips()
		const onChange = showTips(full)
		const addButtons = screen.getAllByRole('button', { name: 'Add a choice' })
		// Four choices already: adding is disabled.
		expect(addButtons[0]).toBeDisabled()
		const fewer = tips()
		fewer.pickup.choices = fewer.pickup.choices.slice(0, 2)
		fewer.pickup.defaultIndex = ''
		onChange.mockClear()
		renderStaff(<TipChoicesCard currency="USD" values={fewer} onChange={onChange} />)
		fireEvent.click(screen.getAllByRole('button', { name: 'Add a choice' }).at(-3)!)
		expect(onChange).toHaveBeenCalled()
		const next = onChange.mock.calls[0]![0] as TipFormValues
		expect(next.pickup.choices).toHaveLength(3)
		expect(next.pickup.choices[2]).toEqual({ kind: 'percent', value: '' })
	})

	it('keeps the default on its choice when an earlier one is removed', () => {
		const onChange = showTips()
		// Pickup: default is the second choice (15). Remove the first.
		fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0]!)
		const next = onChange.mock.calls[0]![0] as TipFormValues
		expect(next.pickup.choices.map((c) => c.value)).toEqual(['15', '18', '20'])
		expect(next.pickup.defaultIndex).toBe('0')
	})

	it('clears the default when its own choice is removed', () => {
		const onChange = showTips()
		fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[1]!)
		const next = onChange.mock.calls[0]![0] as TipFormValues
		expect(next.pickup.defaultIndex).toBe('')
	})

	it('words a refused field and marks the right row', () => {
		showTips(tips(), {
			issue: { section: 'tips', field: 'delivery.choice.2', code: 'invalid_percent' },
		})
		const field = document.getElementById('tip-delivery-value-2')!
		expect(field).toHaveAttribute('aria-describedby', expect.stringContaining('tip-delivery-value-2-error'))
		expect(screen.getByText('Enter a whole percentage from 1 to 30.')).toBeInTheDocument()
	})
})

describe('ServiceFeeCard', () => {
	it('shows only the switch while the fee is off', () => {
		showFee({ ...emptyFeeForm('USD'), enabled: false })
		expect(screen.getByRole('switch', { name: 'Charge a service fee' })).toBeInTheDocument()
		expect(screen.queryByTestId('service-fee-fields')).not.toBeInTheDocument()
	})

	it('gives every field an accessible name while on', () => {
		showFee()
		expect(screen.getByLabelText(/Percentage of the subtotal/)).toBeInTheDocument()
		expect(screen.getByLabelText(/Fixed amount \(USD\)/)).toBeInTheDocument()
		expect(screen.getByLabelText(/Most per order \(USD\)/)).toBeInTheDocument()
		expect(screen.getByLabelText(/Name guests see/)).toBeInTheDocument()
		expect(screen.getByLabelText(/Explanation/)).toBeInTheDocument()
		expect(screen.getByRole('switch', { name: 'Charge tax on the fee' })).toBeInTheDocument()
		for (const name of ['Pickup', 'Delivery', 'Table tab']) {
			expect(screen.getByRole('checkbox', { name })).toBeInTheDocument()
		}
	})

	it('reports an edit with the rest of the values kept', () => {
		const onChange = showFee()
		fireEvent.change(screen.getByLabelText(/Percentage of the subtotal/), {
			target: { value: '2.5' },
		})
		expect(onChange).toHaveBeenCalledWith(
			expect.objectContaining({ percent: '2.5', enabled: true }),
		)
	})

	it('words a refused field', () => {
		showFee(undefined, {
			issue: { section: 'fee', field: 'cap', code: 'invalid_amount' },
		})
		expect(screen.getByText('Enter an amount, for example 2 or 2.50.')).toBeInTheDocument()
	})
})
