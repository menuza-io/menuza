// @vitest-environment jsdom

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from '@testing-library/react'
import { createMemoryRouter, Link, Outlet, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	type LeavePrompt,
	useConfirmBlocker,
	useLeavePrompt,
} from '#app/utils/navigation-guards.ts'
import { LeavePageDialog } from './leave-page-dialog.tsx'

afterEach(() => {
	cleanup()
	vi.restoreAllMocks()
})

const MESSAGE = 'You have unsaved changes. Leave this page and lose them?'

function DirtyPage() {
	useConfirmBlocker(true, MESSAGE)
	return <h1>Setup</h1>
}

function TwoGuardsPage() {
	useConfirmBlocker(true, 'First guard')
	useConfirmBlocker(true, MESSAGE)
	return <h1>Setup</h1>
}

let seenPrompts: LeavePrompt[] = []
function PromptProbe() {
	const prompt = useLeavePrompt()
	if (prompt && !seenPrompts.includes(prompt)) seenPrompts.push(prompt)
	return null
}

function renderApp(page = <DirtyPage />) {
	i18n.load('en', {})
	i18n.activate('en')
	seenPrompts = []
	const router = createMemoryRouter(
		[
			{
				path: '/',
				element: (
					<>
						<Link to="/knowledge">Knowledge</Link>
						<Outlet />
						<LeavePageDialog />
						<PromptProbe />
					</>
				),
				children: [
					{ index: true, element: page },
					{ path: 'knowledge', element: <h1>Knowledge page</h1> },
				],
			},
		],
		{ initialEntries: ['/'] },
	)
	render(
		<I18nProvider i18n={i18n}>
			<RouterProvider router={router} />
		</I18nProvider>,
	)
	return router
}

describe('LeavePageDialog', () => {
	it('asks in the page, not with window.confirm, before leaving unsaved edits', async () => {
		const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
		const router = renderApp()

		fireEvent.click(screen.getByRole('link', { name: 'Knowledge' }))
		const dialog = await screen.findByRole('alertdialog')
		expect(dialog.textContent).toContain(MESSAGE)
		expect(confirm).not.toHaveBeenCalled()

		fireEvent.click(screen.getByRole('button', { name: 'Stay' }))
		await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
		expect(router.state.location.pathname).toBe('/')

		fireEvent.click(screen.getByRole('link', { name: 'Knowledge' }))
		await screen.findByRole('alertdialog')
		fireEvent.click(screen.getByRole('button', { name: 'Leave' }))
		await waitFor(() =>
			expect(router.state.location.pathname).toBe('/knowledge'),
		)
		expect(await screen.findByText('Knowledge page')).toBeTruthy()
	})

	it('stays on the page when the dialog is dismissed with Escape', async () => {
		const router = renderApp()

		fireEvent.click(screen.getByRole('link', { name: 'Knowledge' }))
		const dialog = await screen.findByRole('alertdialog')
		fireEvent.keyDown(dialog, { key: 'Escape' })
		await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
		expect(router.state.location.pathname).toBe('/')

		// The blocker was reset, so the next attempt asks again.
		fireEvent.click(screen.getByRole('link', { name: 'Knowledge' }))
		await screen.findByRole('alertdialog')
		fireEvent.click(screen.getByRole('button', { name: 'Leave' }))
		await waitFor(() =>
			expect(router.state.location.pathname).toBe('/knowledge'),
		)
	})

	it('focuses Stay first and returns focus to the link', async () => {
		renderApp()
		const link = screen.getByRole('link', { name: 'Knowledge' })
		link.focus()

		fireEvent.click(link)
		await screen.findByRole('alertdialog')
		const stay = screen.getByRole('button', { name: 'Stay' })
		await waitFor(() => expect(stay).toHaveFocus())

		fireEvent.click(stay)
		await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
		await waitFor(() => expect(link).toHaveFocus())
	})

	it('answers a blocked navigation once, so a late Stay cannot undo Leave', async () => {
		const router = renderApp()

		fireEvent.click(screen.getByRole('link', { name: 'Knowledge' }))
		await screen.findByRole('alertdialog')
		const [prompt] = seenPrompts
		expect(prompt).toBeDefined()
		prompt!.leave()
		prompt!.stay()
		prompt!.leave()

		await waitFor(() =>
			expect(router.state.location.pathname).toBe('/knowledge'),
		)
		expect(await screen.findByText('Knowledge page')).toBeTruthy()
		// The blocking page unmounts after Leave; its blocker is removed in an effect.
		await waitFor(() => expect(router.state.blockers.size).toBe(0))
	})

	it('settles the one blocker React Router uses when two guards are mounted', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {})
		const router = renderApp(<TwoGuardsPage />)

		fireEvent.click(screen.getByRole('link', { name: 'Knowledge' }))
		const dialog = await screen.findByRole('alertdialog')
		// React Router consults only the newest blocker; the other never blocks.
		expect(dialog.textContent).toContain(MESSAGE)
		expect(seenPrompts).toHaveLength(1)

		fireEvent.click(screen.getByRole('button', { name: 'Leave' }))
		await waitFor(() =>
			expect(router.state.location.pathname).toBe('/knowledge'),
		)
	})
})
