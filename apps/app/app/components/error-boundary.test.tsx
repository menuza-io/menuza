// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { beforeEach, describe, expect, it } from 'vitest'
import { consoleError } from '#tests/setup/setup-test-env.ts'
import { NotFoundErrorBoundary } from './error-boundary.tsx'

// GeneralErrorBoundary logs every route error to the console on purpose.
beforeEach(() => {
	consoleError.mockImplementation(() => {})
})

function renderRootError(response: Response) {
	const router = createMemoryRouter(
		[
			{
				path: '*',
				loader: () => {
					throw response
				},
				element: null,
				HydrateFallback: () => null,
				ErrorBoundary: NotFoundErrorBoundary,
			},
		],
		{ initialEntries: ['/support'] },
	)
	return render(<RouterProvider router={router} />)
}

describe('NotFoundErrorBoundary (root ErrorBoundary)', () => {
	// An unknown first path segment is read as an organization slug, so a bad
	// in-app link ends here. The 404 page must offer a way back into App.
	it('renders the not-found page with a link home for a 404', async () => {
		renderRootError(new Response('Organization not found', { status: 404 }))

		expect(await screen.findByText('Page not found')).toBeTruthy()
		expect(
			screen.getByText('Take me home').closest('a')?.getAttribute('href'),
		).toBe('/')
	})

	it('keeps the default status text for other errors', async () => {
		renderRootError(new Response('Server exploded', { status: 500 }))

		expect(await screen.findByText(/500\s+Server exploded/)).toBeTruthy()
		expect(screen.queryByText('Page not found')).toBeNull()
	})
})
