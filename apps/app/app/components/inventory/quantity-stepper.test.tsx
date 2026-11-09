// @vitest-environment jsdom
import { QuantityStepper } from '@repo/ui/quantity-stepper'
import { render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'

function Harness({
	initial = 2,
	step,
	fractions,
	min,
	max,
}: {
	initial?: number | null
	step?: number
	fractions?: boolean
	min?: number
	max?: number
}) {
	const [value, setValue] = useState<number | null>(initial)
	return (
		<>
			<QuantityStepper
				value={value}
				onValueChange={setValue}
				step={step}
				fractions={fractions}
				min={min}
				max={max}
				decrementLabel="Less"
				incrementLabel="More"
				aria-label="Amount"
				data-testid="qty"
			/>
			<output data-testid="value">{value === null ? 'none' : value}</output>
		</>
	)
}

describe('QuantityStepper', () => {
	it('steps up and down by the step', async () => {
		render(<Harness step={0.5} />)
		await userEvent.click(screen.getByRole('button', { name: 'More' }))
		expect(screen.getByTestId('value')).toHaveTextContent('2.5')
		expect(screen.getByRole('textbox', { name: 'Amount' })).toHaveValue('2.5')
		await userEvent.click(screen.getByRole('button', { name: 'Less' }))
		await userEvent.click(screen.getByRole('button', { name: 'Less' }))
		expect(screen.getByTestId('value')).toHaveTextContent('1.5')
	})

	it('stops at the bounds', async () => {
		render(<Harness initial={1} min={0} max={2} />)
		await userEvent.click(screen.getByRole('button', { name: 'More' }))
		await userEvent.click(screen.getByRole('button', { name: 'More' }))
		expect(screen.getByTestId('value')).toHaveTextContent('2')
		expect(screen.getByRole('button', { name: 'More' })).toBeDisabled()
		await userEvent.click(screen.getByRole('button', { name: 'Less' }))
		await userEvent.click(screen.getByRole('button', { name: 'Less' }))
		expect(screen.getByTestId('value')).toHaveTextContent('0')
		expect(screen.getByRole('button', { name: 'Less' })).toBeDisabled()
	})

	it('reads typed amounts with Arabic digits and fractions', async () => {
		render(<Harness initial={null} />)
		const field = screen.getByRole('textbox', { name: 'Amount' })
		await userEvent.type(field, '٢٫٥')
		expect(screen.getByTestId('value')).toHaveTextContent('2.5')
		await userEvent.clear(field)
		await userEvent.type(field, '1½')
		expect(screen.getByTestId('value')).toHaveTextContent('1.5')
	})

	it('reports nothing for text that is not an amount, and marks it invalid', async () => {
		render(<Harness initial={null} />)
		const field = screen.getByRole('textbox', { name: 'Amount' })
		await userEvent.type(field, 'abc')
		expect(screen.getByTestId('value')).toHaveTextContent('none')
		expect(field).toHaveAttribute('aria-invalid', 'true')
	})

	it('settles typed text on blur and keeps a trailing dot while typing', async () => {
		render(<Harness initial={null} />)
		const field = screen.getByRole('textbox', { name: 'Amount' })
		await userEvent.type(field, '2.')
		expect(field).toHaveValue('2.')
		await userEvent.tab()
		expect(field).toHaveValue('2')
	})

	it('adds quick fractions to the whole part, and takes one back', async () => {
		render(<Harness initial={2} fractions />)
		await userEvent.click(screen.getByRole('button', { name: '½' }))
		expect(screen.getByTestId('value')).toHaveTextContent('2.5')
		await userEvent.click(screen.getByRole('button', { name: '¾' }))
		expect(screen.getByTestId('value')).toHaveTextContent('2.75')
		await userEvent.click(screen.getByRole('button', { name: '¾' }))
		expect(screen.getByTestId('value')).toHaveTextContent('2')
	})

	it('has no quick fractions unless asked for', () => {
		render(<Harness />)
		expect(screen.queryByRole('button', { name: '½' })).toBeNull()
	})

	it('keeps − on the left of the number in a right-to-left page', () => {
		render(
			<div dir="rtl">
				<Harness />
			</div>,
		)
		const less = screen.getByRole('button', { name: 'Less' })
		const field = screen.getByRole('textbox', { name: 'Amount' })
		const more = screen.getByRole('button', { name: 'More' })
		// The stepper forces left-to-right order; the DOM order is − number +.
		expect(less.closest('[data-slot=quantity-stepper]')).toHaveAttribute(
			'dir',
			'ltr',
		)
		const order = [less, field, more].map((node) =>
			Array.from(less.parentElement!.children).indexOf(node),
		)
		expect(order).toEqual([0, 1, 2])
	})
})
