// @vitest-environment jsdom
import { screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type LoyaltyCatalogOption } from '#app/utils/loyalty/catalog.ts'
import { renderStaff } from '#tests/staff-render.tsx'
import { CatalogPicker } from './catalog-picker.tsx'

const OPTIONS: LoyaltyCatalogOption[] = [
	{ id: 'item_latte', name: 'Latte', detail: null },
	{ id: 'item_mocha', name: 'Mocha', detail: 'Hot drinks' },
	{ id: 'item_scone', name: 'Scone', detail: null },
]

const originalScrollIntoView = Element.prototype.scrollIntoView

beforeEach(() => {
	// cmdk measures and scrolls its list; jsdom has neither API.
	vi.stubGlobal(
		'ResizeObserver',
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	)
	Element.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
	vi.unstubAllGlobals()
	Element.prototype.scrollIntoView = originalScrollIntoView
})

function Harness({
	initial = [],
	multiple = true,
	max,
	onClose,
}: {
	initial?: string[]
	multiple?: boolean
	max?: number
	onClose?: () => void
}) {
	const [value, setValue] = useState<string[]>(initial)
	return (
		<>
			<CatalogPicker
				id="picker"
				testId="picker"
				label="Items that earn"
				options={OPTIONS}
				value={value}
				onChange={setValue}
				onClose={onClose}
				multiple={multiple}
				max={max}
				savedLabels={{ item_gone: 'Old cake' }}
				placeholder="Choose items"
				emptyMessage="The menu has no items yet."
			/>
			<output data-testid="value">{value.join(',')}</output>
		</>
	)
}

function trigger() {
	return screen.getByRole('button', { name: /^Items that earn/ })
}

describe('CatalogPicker', () => {
	it('chooses several items by name and removes one from the chips', async () => {
		renderStaff(<Harness />)
		expect(trigger().textContent).toContain('Choose items')

		await userEvent.click(trigger())
		await userEvent.click(await screen.findByRole('option', { name: /^Latte/ }))
		await userEvent.click(screen.getByRole('option', { name: /^Mocha/ }))
		expect(screen.getByTestId('value').textContent).toBe(
			'item_latte,item_mocha',
		)
		expect(trigger().textContent).toContain('2 chosen')

		const chips = screen.getByTestId('picker-chosen')
		await userEvent.click(
			within(chips).getByRole('button', { name: 'Remove Latte' }),
		)
		expect(screen.getByTestId('value').textContent).toBe('item_mocha')
	})

	it('searches by name and by the second line', async () => {
		renderStaff(<Harness />)
		await userEvent.click(trigger())
		const search = await screen.findByRole('combobox', {
			name: 'Search by name',
		})
		await userEvent.type(search, 'sco')
		expect(screen.getByRole('option', { name: /^Scone/ })).toBeTruthy()
		expect(screen.queryByRole('option', { name: /^Latte/ })).toBeNull()

		await userEvent.clear(search)
		await userEvent.type(search, 'hot drinks')
		expect(screen.getByRole('option', { name: /^Mocha/ })).toBeTruthy()
		expect(screen.queryByRole('option', { name: /^Scone/ })).toBeNull()
	})

	it('stops adding at the maximum', async () => {
		renderStaff(<Harness max={1} />)
		await userEvent.click(trigger())
		await userEvent.click(await screen.findByRole('option', { name: /^Latte/ }))
		const mocha = screen.getByRole('option', { name: /^Mocha/ })
		expect(mocha.getAttribute('aria-disabled')).toBe('true')
		expect(
			screen.getByText(
				'That is the most you can choose. Remove one to add another.',
			),
		).toBeTruthy()
		await userEvent.click(mocha)
		expect(screen.getByTestId('value').textContent).toBe('item_latte')
	})

	it('keeps an id the menu no longer has under its saved name', async () => {
		renderStaff(<Harness initial={['item_gone']} />)
		const chip = within(screen.getByTestId('picker-chosen')).getByRole(
			'button',
			{ name: 'Remove Old cake' },
		)
		expect(chip.textContent).toContain('(not on the menu)')
		await userEvent.click(chip)
		expect(screen.getByTestId('value').textContent).toBe('')
	})

	it('ties the "no longer on the menu" note to a single picker', () => {
		renderStaff(<Harness multiple={false} initial={['item_gone']} />)
		expect(trigger()).toHaveAccessibleDescription(
			'This is no longer on the menu. Choose another.',
		)
	})

	it('says on the remove button that a chosen item left the menu', () => {
		renderStaff(<Harness initial={['item_gone', 'item_latte']} />)
		const chips = within(screen.getByTestId('picker-chosen'))
		expect(
			chips.getByRole('button', { name: 'Remove Old cake' }),
		).toHaveAccessibleDescription('(not on the menu)')
		expect(
			chips.getByRole('button', { name: 'Remove Latte' }),
		).not.toHaveAttribute('aria-describedby')
	})

	it('marks which options are chosen in a multiple picker', async () => {
		renderStaff(<Harness initial={['item_latte']} />)
		await userEvent.click(trigger())
		expect(await screen.findByRole('option', { name: /^Latte/ })).toBeChecked()
		expect(screen.getByRole('option', { name: /^Mocha/ })).not.toBeChecked()
	})

	it('picks one item, closes the list and reports the close', async () => {
		const onClose = vi.fn()
		renderStaff(<Harness multiple={false} onClose={onClose} />)
		await userEvent.click(trigger())
		await userEvent.click(await screen.findByRole('option', { name: /^Scone/ }))
		expect(screen.getByTestId('value').textContent).toBe('item_scone')
		expect(onClose).toHaveBeenCalled()
		expect(trigger().textContent).toContain('Scone')
		expect(screen.queryByTestId('picker-chosen')).toBeNull()
	})
})
