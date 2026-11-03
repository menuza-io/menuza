// @vitest-environment jsdom

import {
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarProvider,
} from '@repo/ui/sidebar'
import { WeightLabel } from '@repo/ui/weight-label'
import { render, screen } from '@testing-library/react'
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

describe('SidebarMenu fluid hover', () => {
	it('renders one highlight per menu and drops the per-row hover fill', () => {
		const { container } = render(
			<SidebarProvider>
				<SidebarMenu>
					<SidebarMenuItem>
						<SidebarMenuButton>First</SidebarMenuButton>
					</SidebarMenuItem>
					<SidebarMenuItem>
						<SidebarMenuButton>Second</SidebarMenuButton>
					</SidebarMenuItem>
				</SidebarMenu>
			</SidebarProvider>,
		)
		expect(screen.getByText('First').className).toContain(
			'hover:bg-transparent',
		)
		// Nothing is hovered yet, so no highlight is mounted.
		expect(
			container.querySelectorAll('[data-slot="fluid-hover-highlight"]'),
		).toHaveLength(0)
	})
})

describe('WeightLabel', () => {
	it('reserves the heavy width with an invisible copy', () => {
		const { container } = render(<WeightLabel active={false}>Home</WeightLabel>)
		const spans = container.querySelectorAll('span > span')
		expect(spans).toHaveLength(2)
		expect(spans[1]?.getAttribute('aria-hidden')).toBe('true')
		expect((spans[0] as HTMLElement).style.getPropertyValue('--weight')).toBe(
			"'wght' 400",
		)
		expect((spans[1] as HTMLElement).style.getPropertyValue('--weight')).toBe(
			"'wght' 550",
		)
	})

	it('goes semibold when active', () => {
		const { container } = render(<WeightLabel active>Home</WeightLabel>)
		const visible = container.querySelector('span > span') as HTMLElement
		expect(visible.style.getPropertyValue('--weight')).toBe("'wght' 550")
	})
})
