// @vitest-environment jsdom

import { Switch } from '@repo/ui/switch'
import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

beforeEach(() => {
	vi.stubGlobal(
		'matchMedia',
		vi.fn(() => ({
			matches: false,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
		})),
	)
})

function Controlled({ onChange }: { onChange: (value: boolean) => void }) {
	const [checked, setChecked] = useState(false)
	return (
		<Switch
			aria-label="Notify"
			checked={checked}
			onCheckedChange={(next) => {
				setChecked(next)
				onChange(next)
			}}
		/>
	)
}

describe('Switch', () => {
	it('toggles a controlled switch on click', () => {
		const onChange = vi.fn()
		render(<Controlled onChange={onChange} />)
		const control = screen.getByRole('switch')
		expect(control.getAttribute('aria-checked')).toBe('false')
		fireEvent.click(control)
		expect(onChange).toHaveBeenCalledWith(true)
		expect(control.getAttribute('aria-checked')).toBe('true')
	})

	it('toggles an uncontrolled switch from defaultChecked', () => {
		render(<Switch aria-label="Notify" defaultChecked />)
		const control = screen.getByRole('switch')
		expect(control.getAttribute('aria-checked')).toBe('true')
		fireEvent.click(control)
		expect(control.getAttribute('aria-checked')).toBe('false')
	})

	it('does not toggle when disabled', () => {
		const onChange = vi.fn()
		render(<Switch aria-label="Notify" disabled onCheckedChange={onChange} />)
		fireEvent.click(screen.getByRole('switch'))
		expect(onChange).not.toHaveBeenCalled()
	})

	it('refuses the click that ends a drag released short of the midpoint', () => {
		const onChange = vi.fn()
		render(<Switch aria-label="Notify" onCheckedChange={onChange} />)
		const control = screen.getByRole('switch')
		fireEvent.pointerDown(control, {
			clientX: 0,
			pointerType: 'mouse',
			button: 0,
		})
		// Moves past the dead zone but only a few pixels, short of the midpoint.
		fireEvent.pointerMove(control, { clientX: 4, pointerType: 'mouse' })
		fireEvent.pointerUp(control, { clientX: 4, pointerType: 'mouse' })
		fireEvent.click(control)
		expect(onChange).not.toHaveBeenCalled()
	})

	it('toggles when a drag is released past the midpoint', () => {
		const onChange = vi.fn()
		render(<Switch aria-label="Notify" onCheckedChange={onChange} />)
		const control = screen.getByRole('switch')
		fireEvent.pointerDown(control, {
			clientX: 0,
			pointerType: 'mouse',
			button: 0,
		})
		fireEvent.pointerMove(control, { clientX: 20, pointerType: 'mouse' })
		fireEvent.pointerUp(control, { clientX: 20, pointerType: 'mouse' })
		fireEvent.click(control)
		expect(onChange).toHaveBeenCalledTimes(1)
		expect(onChange.mock.calls[0]?.[0]).toBe(true)
	})

	it('does not flip an uncontrolled switch when the consumer cancels the change', () => {
		render(
			<Switch
				aria-label="Notify"
				onCheckedChange={(_next, details) => details.cancel()}
			/>,
		)
		const control = screen.getByRole('switch')
		fireEvent.click(control)
		expect(control.getAttribute('aria-checked')).toBe('false')
	})
})
