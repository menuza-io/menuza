// @vitest-environment jsdom

import { screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { renderStaff } from '#tests/staff-render.tsx'
import { PhoneOrderingSection } from './phone-ordering-section.tsx'

function show(
	data: unknown,
	value: Record<string, unknown> = {},
	options: { disabled?: boolean } = {},
) {
	const onChange = vi.fn()
	renderStaff(
		<PhoneOrderingSection
			value={value}
			onChange={onChange}
			disabled={options.disabled ?? false}
			data={data}
			fieldErrors={{}}
		/>,
	)
	return { onChange }
}

const toggle = () =>
	screen.queryByRole('switch', { name: 'Book tables by phone' })

describe('table booking toggle', () => {
	it('shows only while phone booking is available (reservations.voice on, US) (VAL-VOICE-011)', () => {
		show({ categories: [], reservationsAvailable: true })
		expect(toggle()).toBeTruthy()
		expect(screen.getByText('Table booking')).toBeTruthy()
	})

	it('is not rendered when the flag is off or the organization is not US (VAL-VOICE-012)', () => {
		show({ categories: [], reservationsAvailable: false })
		expect(toggle()).toBeNull()
		expect(screen.queryByText('Table booking')).toBeNull()
	})

	it('is not rendered for data from an older server', () => {
		show({ categories: [] })
		expect(toggle()).toBeNull()
		expect(screen.getByText('Phone ordering')).toBeTruthy()
	})

	it('starts off and saves the choice in the restaurant settings', () => {
		const { onChange } = show({ categories: [], reservationsAvailable: true })
		expect(toggle()!.getAttribute('aria-checked')).toBe('false')
		fireEvent.click(toggle()!)
		expect(onChange).toHaveBeenCalledWith(
			expect.objectContaining({ reservationBooking: true }),
		)
	})

	it('shows the saved choice and honors read-only', () => {
		show(
			{ categories: [], reservationsAvailable: true },
			{ reservationBooking: true },
			{ disabled: true },
		)
		expect(toggle()!.getAttribute('aria-checked')).toBe('true')
		expect(toggle()!.hasAttribute('data-disabled')).toBe(true)
	})
})
