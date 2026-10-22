// @vitest-environment jsdom

import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from '@repo/ui/dropdown-menu'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => cleanup())

function renderMenu(onClick: () => void) {
	render(
		<DropdownMenu>
			<DropdownMenuTrigger>Page menu</DropdownMenuTrigger>
			<DropdownMenuContent>
				<DropdownMenuItem onClick={onClick}>Add new page</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>,
	)
}

describe('DropdownMenuItem', () => {
	it('runs onClick when the item is clicked', async () => {
		const user = userEvent.setup()
		const onClick = vi.fn()
		renderMenu(onClick)

		await user.click(screen.getByRole('button', { name: 'Page menu' }))
		await user.click(
			await screen.findByRole('menuitem', { name: 'Add new page' }),
		)

		expect(onClick).toHaveBeenCalledTimes(1)
	})

	it('runs onClick when the item is chosen with Enter', async () => {
		const user = userEvent.setup()
		const onClick = vi.fn()
		renderMenu(onClick)

		await user.click(screen.getByRole('button', { name: 'Page menu' }))
		const item = await screen.findByRole('menuitem', { name: 'Add new page' })
		item.focus()
		await user.keyboard('{Enter}')

		expect(onClick).toHaveBeenCalledTimes(1)
	})

	it('rejects onSelect, which Base UI never calls on choose', () => {
		// @ts-expect-error onSelect is the DOM text-selection event, not "choose"
		void (<DropdownMenuItem onSelect={() => {}}>Add new page</DropdownMenuItem>)
	})
})
