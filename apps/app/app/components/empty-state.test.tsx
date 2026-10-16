// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { EmptyState } from './empty-state.tsx'

vi.mock('@repo/ui/icon', () => ({ Icon: () => null }))

function renderEmptyState() {
	const router = createMemoryRouter([
		{
			path: '/',
			element: (
				<EmptyState
					title="No organization found"
					action={{ label: 'Add organization', href: '/organizations/create' }}
				/>
			),
		},
	])
	return render(<RouterProvider router={router} />)
}

describe('EmptyState', () => {
	it('renders the action as one pill that is the link, not a link inside a button', () => {
		const { container } = renderEmptyState()

		// Base UI gives a non-native Button role="button"; the element itself
		// is the anchor, so the whole pill navigates and is one tab stop.
		const pill = screen.getByRole('button', { name: 'Add organization' })
		expect(pill.tagName).toBe('A')
		expect(pill.getAttribute('href')).toBe('/organizations/create')
		expect(container.querySelectorAll('a, button')).toHaveLength(1)
	})
})
