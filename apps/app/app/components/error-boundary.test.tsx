// @vitest-environment jsdom

import { TraceIdProvider } from '@repo/common/trace-id'
import { i18n, I18nProvider } from '@repo/i18n'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { type ComponentType } from 'react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
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

describe('error reference (#385)', () => {
	beforeEach(() => {
		i18n.load('en', {})
		i18n.activate('en')
	})

	function renderWithReference(traceId: string) {
		const router = createMemoryRouter(
			[
				{
					path: '*',
					loader: () => {
						throw new Response('Server exploded', { status: 500 })
					},
					element: null,
					HydrateFallback: () => null,
					ErrorBoundary: GeneralErrorBoundary,
				},
			],
			{ initialEntries: ['/orders'] },
		)
		return render(
			<I18nProvider i18n={i18n}>
				<TraceIdProvider value={traceId}>
					<RouterProvider router={router} />
				</TraceIdProvider>
			</I18nProvider>,
		)
	}

	it('shows the reference of this page load and copies it with the keyboard', async () => {
		// user-event installs its own clipboard, so it is set up before the spy.
		const user = userEvent.setup()
		const writeText = vi
			.spyOn(navigator.clipboard, 'writeText')
			.mockResolvedValue(undefined)
		const traceId = 'a1b2c3d4e5f6a7b8'
		renderWithReference(traceId)

		expect((await screen.findByTestId('error-reference-id')).textContent).toBe(
			traceId,
		)
		const button = screen.getByRole('button', { name: /copy reference/i })
		// Tab reaches it, Enter copies: no pointer needed.
		await user.tab()
		expect(button).toHaveFocus()
		await user.keyboard('{Enter}')
		expect(writeText).toHaveBeenCalledWith(traceId)
		expect(
			await screen.findByText('Copied', { selector: 'button' }),
		).toBeTruthy()

		// Space works too.
		await user.keyboard(' ')
		expect(writeText).toHaveBeenCalledTimes(2)
	})

	it('shows nothing extra when the page has no reference', async () => {
		renderRootError(
			new Response('Server exploded', { status: 500 }),
			GeneralErrorBoundary,
		)
		expect(await screen.findByText(/500\s+Server exploded/)).toBeTruthy()
		expect(screen.queryByTestId('error-reference-id')).toBeNull()
	})
})
