// @vitest-environment jsdom

import { Tabs, TabsList, TabsTrigger } from '@repo/ui/tabs'
import { ToggleGroup, ToggleGroupItem } from '@repo/ui/toggle-group'
import { WorkspaceTabBar } from '@repo/ui/workspace'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { renderToString } from 'react-dom/server'
import { createMemoryRouter, MemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { usePhoneAgentSettingsTab } from './phone-agent/settings-nav.tsx'

afterEach(() => {
	vi.restoreAllMocks()
})

const SECTIONS = [
	{ label: 'Pages', href: '/acme/website/pages', isActive: true },
	{ label: 'Forms', href: '/acme/website/forms', isActive: false },
]

/** jsdom has no layout: give every item a 40x20 box, 50px apart. */
function stubLayout() {
	vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(40)
	vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(20)
	vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
		function (this: HTMLElement) {
			const siblings = this.parentElement
				? [...this.parentElement.children]
				: []
			const left =
				this.dataset.slot === 'toggle-group-item'
					? siblings.indexOf(this) * 50
					: 0
			return DOMRect.fromRect({ x: left, y: 0, width: 40, height: 20 })
		},
	)
}

function Filter() {
	const [value, setValue] = useState('all')
	return (
		<ToggleGroup
			aria-label="Show"
			variant="segmented"
			value={[value]}
			onValueChange={(next) => {
				if (next[0]) setValue(next[0])
			}}
		>
			<ToggleGroupItem value="all">All</ToggleGroupItem>
			<ToggleGroupItem value="late">Late</ToggleGroupItem>
		</ToggleGroup>
	)
}

function indicatorIn(html: string) {
	return new DOMParser()
		.parseFromString(html, 'text/html')
		.querySelector('[data-slot="sliding-indicator"]')
}

describe('sliding selection indicator', () => {
	it('keeps route sections as links that mark the current page', () => {
		render(
			<MemoryRouter>
				<WorkspaceTabBar label="Website sections" tabs={SECTIONS} />
			</MemoryRouter>,
		)
		expect(
			screen.getByRole('navigation', { name: 'Website sections' }),
		).toBeTruthy()
		expect(screen.queryByRole('tab')).toBeNull()
		expect(
			screen.getByRole('link', { name: 'Pages' }).getAttribute('aria-current'),
		).toBe('page')
		expect(
			screen.getByRole('link', { name: 'Forms' }).getAttribute('aria-current'),
		).toBeNull()
	})

	it('keeps a segmented filter as pressed buttons and slides the pill to the choice', async () => {
		stubLayout()
		const { container } = render(<Filter />)
		expect(screen.queryByRole('tab')).toBeNull()
		expect(
			screen.getByRole('button', { name: 'All', pressed: true }),
		).toBeTruthy()
		const indicator = container.querySelector<HTMLElement>(
			'[data-slot="sliding-indicator"]',
		)
		expect(indicator?.hidden).toBe(false)
		expect(indicator?.style.getPropertyValue('--active-tab-left')).toBe('0px')

		fireEvent.click(screen.getByRole('button', { name: 'Late' }))
		expect(
			screen.getByRole('button', { name: 'Late', pressed: true }),
		).toBeTruthy()
		await waitFor(() =>
			expect(indicator?.style.getPropertyValue('--active-tab-left')).toBe(
				'50px',
			),
		)
	})

	// The selected item paints its own pill or underline while the indicator
	// is hidden, so server HTML must ship the indicator hidden.
	it('ships the indicator hidden in server HTML', () => {
		expect(
			indicatorIn(
				renderToString(
					<MemoryRouter>
						<WorkspaceTabBar tabs={SECTIONS} />
					</MemoryRouter>,
				),
			)?.hasAttribute('hidden'),
		).toBe(true)
		expect(
			indicatorIn(renderToString(<Filter />))?.hasAttribute('hidden'),
		).toBe(true)
		const tabsIndicator = indicatorIn(
			renderToString(
				<Tabs value="a">
					<TabsList aria-label="Views" variant="line">
						<TabsTrigger value="a">A</TabsTrigger>
						<TabsTrigger value="b">B</TabsTrigger>
					</TabsList>
				</Tabs>,
			),
		)
		expect(tabsIndicator?.hasAttribute('hidden')).toBe(true)
		// The shared line classes place the underline by this attribute.
		expect(tabsIndicator?.getAttribute('data-orientation')).toBe('horizontal')
	})

	it('TabsList retains height classes for horizontal orientation', () => {
		const defaultList = renderToString(
			<Tabs value="a">
				<TabsList aria-label="Views">
					<TabsTrigger value="a">A</TabsTrigger>
				</TabsList>
			</Tabs>,
		)
		expect(defaultList).toContain('h-8')

		const lineList = renderToString(
			<Tabs value="a">
				<TabsList aria-label="Views" variant="line">
					<TabsTrigger value="a">A</TabsTrigger>
				</TabsList>
			</Tabs>,
		)
		expect(lineList).toContain('data-[variant=line]:h-9')
	})

	it('resolves phone agent settings tab from route handle, or returns null when missing', () => {
		function TestRoute() {
			const tab = usePhoneAgentSettingsTab()
			return <div data-testid="tab-value">{tab ?? 'none'}</div>
		}

		const routerWithoutHandle = createMemoryRouter([
			{ path: '/', element: <TestRoute /> },
		])
		const { unmount } = render(<RouterProvider router={routerWithoutHandle} />)
		expect(screen.getByTestId('tab-value').textContent).toBe('none')
		unmount()

		const routerWithHandle = createMemoryRouter([
			{
				path: '/',
				element: <TestRoute />,
				handle: { phoneAgentSettingsTab: 'agent' },
			},
		])
		render(<RouterProvider router={routerWithHandle} />)
		expect(screen.getByTestId('tab-value').textContent).toBe('agent')
	})
})
