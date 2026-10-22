// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { type ComponentType } from 'react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { beforeEach, describe, expect, it } from 'vitest'
import { consoleError } from '#tests/setup/setup-test-env.ts'
import {
	AppShellErrorScope,
	GeneralErrorBoundary,
	NotFoundErrorBoundary,
} from './error-boundary.tsx'

// GeneralErrorBoundary logs every route error to the console on purpose.
beforeEach(() => {
	consoleError.mockImplementation(() => {})
})

function renderRootError(
	response: Response,
	ErrorBoundary: ComponentType = NotFoundErrorBoundary,
) {
	const router = createMemoryRouter(
		[
			{
				path: '*',
				loader: () => {
					throw response
				},
				element: null,
				HydrateFallback: () => null,
				ErrorBoundary,
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

describe('GeneralErrorBoundary', () => {
	// Route boundaries inside the org shell (for example Staff while the module
	// is off) must show the not-found page with a way back, not bare status text.
	it('renders the not-found page with a link home for a 404', async () => {
		renderRootError(
			new Response('Not Found', { status: 404 }),
			GeneralErrorBoundary,
		)

		expect(await screen.findByText('Page not found')).toBeTruthy()
		expect(screen.queryByText(/404\s+Not Found/)).toBeNull()
		expect(
			screen.getByText('Take me home').closest('a')?.getAttribute('href'),
		).toBe('/')
	})

	it('fills the content area inside the App shell and the screen outside it', async () => {
		const { unmount } = renderRootError(
			new Response('Not Found', { status: 404 }),
			GeneralErrorBoundary,
		)
		const standalone = (await screen.findByText('Page not found')).closest(
			'section',
		)
		expect(standalone?.className).toContain('min-h-screen')
		unmount()

		renderRootError(new Response('Not Found', { status: 404 }), () => (
			<AppShellErrorScope>
				<GeneralErrorBoundary />
			</AppShellErrorScope>
		))
		const inline = (await screen.findByText('Page not found')).closest(
			'section',
		)
		expect(inline?.className).toContain('flex-1')
		expect(inline?.className).not.toContain('min-h-screen')
	})

	it('keeps a route-specific 404 handler', async () => {
		renderRootError(new Response('Not Found', { status: 404 }), () => (
			<GeneralErrorBoundary
				statusHandlers={{ 404: () => <p>No such note</p> }}
			/>
		))

		expect(await screen.findByText('No such note')).toBeTruthy()
		expect(screen.queryByText('Page not found')).toBeNull()
	})

	it('keeps the default status text for other errors', async () => {
		renderRootError(
			new Response('Forbidden', { status: 403 }),
			GeneralErrorBoundary,
		)

		expect(await screen.findByText(/403\s+Forbidden/)).toBeTruthy()
	})
})
