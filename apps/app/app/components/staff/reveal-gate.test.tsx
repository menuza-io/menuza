// @vitest-environment jsdom

import { fireEvent, screen } from '@testing-library/react'
import { useEffect } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { renderStaff } from '#tests/staff-render.tsx'
import { RevealGate } from './reveal-gate.tsx'

function Probe({ onMount }: { onMount: () => void }) {
	useEffect(onMount, [onMount])
	return <p>secret details</p>
}

describe('RevealGate', () => {
	it('does not mount its children, so nothing is fetched, until Show', () => {
		const onMount = vi.fn()
		renderStaff(
			<RevealGate title="Pay" description="Rates">
				<Probe onMount={onMount} />
			</RevealGate>,
		)
		expect(onMount).not.toHaveBeenCalled()
		expect(screen.queryByText('secret details')).toBeNull()
		const show = screen.getByRole('button', { name: 'Show' })
		expect(show.getAttribute('aria-expanded')).toBe('false')

		fireEvent.click(show)
		expect(onMount).toHaveBeenCalledTimes(1)
		expect(screen.getByText('secret details')).toBeTruthy()
		expect(
			screen
				.getByRole('button', { name: 'Hide' })
				.getAttribute('aria-expanded'),
		).toBe('true')
	})

	it('unmounts again on Hide', () => {
		renderStaff(
			<RevealGate title="Pay" description="Rates">
				<p>secret details</p>
			</RevealGate>,
		)
		fireEvent.click(screen.getByRole('button', { name: 'Show' }))
		fireEvent.click(screen.getByRole('button', { name: 'Hide' }))
		expect(screen.queryByText('secret details')).toBeNull()
	})
})
