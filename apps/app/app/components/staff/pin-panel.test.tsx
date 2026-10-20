// @vitest-environment jsdom

import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderStaff } from '#tests/staff-render.tsx'
import { PinPanel } from './pin-panel.tsx'

afterEach(() => {
	vi.unstubAllGlobals()
})

describe('PinPanel', () => {
	it('shows the PIN once with a plain warning that it cannot be looked up again', () => {
		renderStaff(<PinPanel pin="4821" scopeName="Downtown" onDone={() => {}} />)
		expect(screen.getByRole('status', { name: 'New PIN' }).textContent).toBe(
			'4821',
		)
		expect(screen.getByText(/New PIN for Downtown/)).toBeTruthy()
		expect(
			screen.getByText(/cannot be looked up later/, { exact: false }),
		).toBeTruthy()
	})

	it('puts focus on Copy so a stray Enter cannot dismiss the one-time PIN', () => {
		renderStaff(<PinPanel pin="4821" scopeName="Downtown" onDone={() => {}} />)
		expect(screen.getByRole('button', { name: 'Copy PIN' })).toHaveFocus()
	})

	it('copies the PIN and says so', async () => {
		const writeText = vi.fn().mockResolvedValue(undefined)
		vi.stubGlobal('navigator', { clipboard: { writeText } })
		renderStaff(<PinPanel pin="4821" scopeName="Downtown" onDone={() => {}} />)
		fireEvent.click(screen.getByRole('button', { name: 'Copy PIN' }))
		await waitFor(() => expect(writeText).toHaveBeenCalledWith('4821'))
		expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy()
	})

	it('tells the manager to copy by hand when the clipboard is blocked', async () => {
		vi.stubGlobal('navigator', {
			clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
		})
		renderStaff(<PinPanel pin="4821" scopeName="Downtown" onDone={() => {}} />)
		fireEvent.click(screen.getByRole('button', { name: 'Copy PIN' }))
		expect(
			await screen.findByText(/Select the PIN and copy it yourself/),
		).toBeTruthy()
	})

	it('hands control back on Done', () => {
		const onDone = vi.fn()
		renderStaff(<PinPanel pin="4821" scopeName="Downtown" onDone={onDone} />)
		fireEvent.click(screen.getByRole('button', { name: 'Done' }))
		expect(onDone).toHaveBeenCalledTimes(1)
	})
})
