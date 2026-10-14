// @vitest-environment jsdom

import {
	cleanup,
	fireEvent,
	screen,
	waitFor,
	within,
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StaffClientProvider } from '#app/components/staff/staff-client-provider.tsx'
import { renderStaff } from '#tests/staff-render.tsx'
import { ScheduleLinkSection } from './schedule-link-section.tsx'

type Call = { method: string; url: string }

function stub(options: {
	grants?: string[]
	tokenFails?: boolean
	status?: Record<string, unknown>
	statusFails?: boolean
}) {
	const calls: Call[] = []
	let active = true
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input)
			const method = init?.method ?? 'GET'
			if (url.includes('/staff/token')) {
				if (options.tokenFails) {
					return Response.json({ error: 'staffing_off' }, { status: 403 })
				}
				return Response.json({
					jwt: 'jwt',
					tenantApiUrl: 'https://us.tenant.test',
					scope: 'schedule',
					grants: options.grants ?? [
						'read:schedule:any',
						'update:schedule:any',
					],
					expiresAt: Date.now() + 600_000,
				})
			}
			calls.push({ method, url })
			if (options.statusFails)
				return Response.json({ error: 'x' }, { status: 500 })
			if (url.endsWith('/revoke')) {
				active = false
				return Response.json({
					staffId: 's1',
					active: false,
					createdAt: 1,
					lastUsedAt: 2,
					expiresAt: 3,
				})
			}
			return Response.json({
				staffId: 's1',
				active,
				createdAt: Date.UTC(2026, 2, 1, 12),
				lastUsedAt: Date.UTC(2026, 2, 3, 12),
				expiresAt: Date.UTC(2026, 5, 1, 12),
				...options.status,
			})
		}),
	)
	return calls
}

function view(terminated = false) {
	return renderStaff(
		<StaffClientProvider orgSlug="acme">
			<ScheduleLinkSection staffId="s1" terminated={terminated} />
		</StaffClientProvider>,
	)
}

afterEach(() => {
	cleanup()
	vi.unstubAllGlobals()
})

describe('ScheduleLinkSection', () => {
	it('says the link is live, when it lapses and when it was last opened', async () => {
		stub({})
		view()
		expect(await screen.findByText('My schedule link')).toBeTruthy()
		const text = screen.getByText(
			/They see their own published shifts/,
		).parentElement!
		expect(text.textContent).toMatch(/works until Jun 1, 2026/)
		expect(text.textContent).toMatch(/Last opened Mar 3, 2026/)
	})

	it('turns the link off after a confirmation, and says what happens next', async () => {
		const calls = stub({})
		view()
		fireEvent.click(
			await screen.findByRole('button', { name: 'Turn off the link' }),
		)
		const dialog = await screen.findByRole('alertdialog')
		expect(
			within(dialog).getByText(/get a new one in the next schedule email/),
		).toBeTruthy()
		fireEvent.click(within(dialog).getByRole('button', { name: 'Turn off' }))
		await waitFor(() =>
			expect(calls.some((c) => c.url.endsWith('/links/s1/revoke'))).toBe(true),
		)
		expect(calls.find((c) => c.url.endsWith('/revoke'))!.method).toBe('POST')
		expect(
			await screen.findByText(
				/No link is active\. They get one in the next schedule email/,
			),
		).toBeTruthy()
		expect(
			screen.queryByRole('button', { name: 'Turn off the link' }),
		).toBeNull()
	})

	it('says when it has not been opened yet', async () => {
		stub({ status: { lastUsedAt: null } })
		view()
		expect(await screen.findByText(/Not opened yet\./)).toBeTruthy()
	})

	it('shows nothing to turn off when there is no link, and no button to someone who cannot edit', async () => {
		stub({ status: { active: false, expiresAt: null, lastUsedAt: null } })
		view()
		expect(await screen.findByText(/No link is active/)).toBeTruthy()
		expect(screen.queryByRole('button')).toBeNull()
		cleanup()
		stub({ grants: ['read:schedule:any'] })
		view()
		await screen.findByText('My schedule link')
		expect(
			screen.queryByRole('button', { name: 'Turn off the link' }),
		).toBeNull()
	})

	it('offers no turn-off for someone who has left', async () => {
		stub({})
		view(true)
		await screen.findByText('My schedule link')
		expect(
			screen.queryByRole('button', { name: 'Turn off the link' }),
		).toBeNull()
	})

	it('is not there at all while scheduling is off, the member cannot read it, or it cannot load', async () => {
		stub({ tokenFails: true })
		const { container } = view()
		await new Promise((resolve) => setTimeout(resolve, 50))
		expect(container.textContent).toBe('')
		cleanup()
		stub({ grants: ['read:staff:any'] })
		const second = view()
		await new Promise((resolve) => setTimeout(resolve, 50))
		expect(second.container.textContent).toBe('')
		cleanup()
		stub({ statusFails: true })
		const third = view()
		await new Promise((resolve) => setTimeout(resolve, 50))
		expect(third.container.textContent).toBe('')
	})
})
