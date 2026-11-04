// @vitest-environment jsdom

import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from '@repo/ui/dropdown-menu'
import {
	FluidHoverScope,
	useFluidHoverItemRef,
} from '@repo/ui/fluid-hover-scope'
import { fireEvent, render, screen } from '@testing-library/react'
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
	vi.stubGlobal(
		'ResizeObserver',
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	)
})

function Row({ children }: { children: string }) {
	const item = useFluidHoverItemRef<HTMLButtonElement>()
	return (
		<button ref={item.ref} data-in-scope={item.inScope}>
			{children}
		</button>
	)
}

describe('FluidHoverScope', () => {
	it('tells rows inside a scope to drop their own fill', () => {
		render(
			<FluidHoverScope>
				<Row>Inside</Row>
			</FluidHoverScope>,
		)
		expect(screen.getByText('Inside').dataset.inScope).toBe('true')
	})

	it('leaves a row outside any scope alone', () => {
		render(<Row>Outside</Row>)
		expect(screen.getByText('Outside').dataset.inScope).toBe('false')
	})

	it('clears the highlight when focus moves to a row outside the scope', () => {
		render(
			<FluidHoverScope>
				<Row>One</Row>
				<button>Plain</button>
			</FluidHoverScope>,
		)
		fireEvent.focus(screen.getByText('One'))
		expect(
			screen.getByText('One').hasAttribute('data-fluid-hover-active'),
		).toBe(true)
		fireEvent.focus(screen.getByText('Plain'))
		expect(
			screen.getByText('One').hasAttribute('data-fluid-hover-active'),
		).toBe(false)
	})

	it('runs a caller mouse handler without losing hover tracking', () => {
		const onMouseLeave = vi.fn()
		const { container } = render(
			<FluidHoverScope onMouseLeave={onMouseLeave}>
				<Row>One</Row>
			</FluidHoverScope>,
		)
		const scope = container.querySelector('[data-slot="fluid-hover-scope"]')
		if (!scope) throw new Error('scope not found')
		fireEvent.mouseLeave(scope)
		expect(onMouseLeave).toHaveBeenCalledTimes(1)
	})

	it('registers the new element when a row is replaced by another node', () => {
		const { rerender } = render(
			<FluidHoverScope>
				<Row key="a">One</Row>
			</FluidHoverScope>,
		)
		// A list that re-creates a row (cmdk does when filtering) mounts a new node.
		rerender(
			<FluidHoverScope>
				<Row key="b">One</Row>
			</FluidHoverScope>,
		)
		fireEvent.focus(screen.getByText('One'))
		expect(
			screen.getByText('One').hasAttribute('data-fluid-hover-active'),
		).toBe(true)
	})

	it('lights the row that takes keyboard focus', () => {
		render(
			<FluidHoverScope>
				<Row>One</Row>
				<Row>Two</Row>
			</FluidHoverScope>,
		)
		fireEvent.focus(screen.getByText('Two'))
		expect(
			screen.getByText('Two').hasAttribute('data-fluid-hover-active'),
		).toBe(true)
		expect(
			screen.getByText('One').hasAttribute('data-fluid-hover-active'),
		).toBe(false)
	})
})

describe('DropdownMenu fluid hover', () => {
	it('puts menu items in the scope and keeps destructive items self-painted', () => {
		render(
			<DropdownMenu open>
				<DropdownMenuTrigger>Open</DropdownMenuTrigger>
				<DropdownMenuContent>
					<DropdownMenuItem>Rename</DropdownMenuItem>
					<DropdownMenuItem variant="destructive">Delete</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>,
		)
		expect(screen.getByText('Rename').className).toContain(
			'focus:bg-transparent',
		)
		expect(screen.getByText('Delete').className).not.toContain(
			'focus:bg-transparent',
		)
		expect(
			document.querySelector('[data-slot="fluid-hover-scope"]'),
		).not.toBeNull()
	})
})
