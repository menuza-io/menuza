// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MarketingLayout } from './marketing-layout.tsx'

vi.mock('#app/components/ai/ai-panel-context.tsx', () => ({
	useAIPanel: () => ({ isOpen: false, isExpanded: false }),
}))
vi.mock('#app/components/app-sidebar.tsx', () => ({
	AppSidebar: () => null,
}))
vi.mock('#app/components/site-header.tsx', () => ({
	SiteHeader: () => null,
}))
vi.mock('./progress-bar', () => ({ EpicProgress: () => null }))

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

afterEach(() => {
	vi.unstubAllGlobals()
})

function renderLayout(pathname: string) {
	const router = createMemoryRouter(
		[
			{
				path: '*',
				element: (
					<MarketingLayout>
						<div>Page content</div>
					</MarketingLayout>
				),
			},
		],
		{ initialEntries: [pathname] },
	)
	render(<RouterProvider router={router} />)
	const main = screen.getByRole('main')
	return {
		main,
		wrapper: main.closest('[data-slot="sidebar-wrapper"]'),
	}
}

describe('conversation layout sizing', () => {
	it.each(['/acme/chat', '/acme/chat/', '/acme/mailbox', '/acme/mailbox/'])(
		'locks the actual conversation route %s to the viewport',
		(pathname) => {
			const { main, wrapper } = renderLayout(pathname)
			expect(wrapper).toHaveClass('h-dvh', 'max-h-dvh')
			expect(main).toHaveClass('min-h-0', 'overflow-hidden')
		},
	)

	it.each([
		'/acme/settings/chat',
		'/acme/settings/chat/',
		'/acme/settings/mailbox',
		'/acme/settings/mailbox/',
		'/acme/chat/history',
		'/chat',
		'/acme/website',
	])('leaves the non-conversation route %s scrollable', (pathname) => {
		const { main, wrapper } = renderLayout(pathname)
		expect(wrapper).not.toHaveClass('h-dvh')
		expect(wrapper).not.toHaveClass('max-h-dvh')
		expect(main).not.toHaveClass('overflow-hidden')
	})
})
