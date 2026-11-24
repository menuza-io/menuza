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
import { AnnouncementsPage } from './announcements-page.tsx'

type Call = { method: string; url: string; body?: any }

const NOW = Date.UTC(2026, 2, 4, 18)
const view = (overrides: Record<string, unknown> = {}) => ({
	id: 'a1',
	title: 'New menu tomorrow',
	body: 'Read the specials card.',
	audience: 'everyone',
	audienceId: null,
	startsAt: NOW - 3_600_000,
	expiresAt: NOW + 2 * 86_400_000,
	createdAt: NOW - 3_600_000,
	withdrawnAt: null,
	state: 'live',
	recipients: 3,
	read: 1,
	...overrides,
})

function stub(options: { grants?: string[]; items?: unknown[] } = {}) {
	const calls: Call[] = []
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input)
			const method = init?.method ?? 'GET'
			if (url.includes('/staff/token')) {
				return Response.json({
					jwt: 'jwt',
					tenantApiUrl: 'https://us.tenant.test',
					scope: 'staff',
					grants: options.grants ?? ['read:staff:any', 'update:staff:any'],
					expiresAt: Date.now() + 600_000,
				})
			}
			calls.push({
				method,
				url,
				body: init?.body ? JSON.parse(String(init.body)) : undefined,
			})
			if (url.includes('/announcements/a1/withdraw')) {
				return Response.json({
					announcement: view({ state: 'withdrawn', withdrawnAt: NOW }),
				})
			}
			if (url.includes('/announcements/a1')) {
				return Response.json({
					announcement: view(),
					recipients: [
						{
							staffId: 's2',
							firstName: 'Omar',
							lastName: 'Saleh',
							readAt: null,
							source: null,
						},
						{
							staffId: 's1',
							firstName: 'Rana',
							lastName: 'Khalid',
							readAt: NOW,
							source: 'station',
						},
					],
				})
			}
			if (url.includes('/announcements') && method === 'POST') {
				return Response.json({ announcement: view() }, { status: 201 })
			}
			if (url.includes('/announcements')) {
				return Response.json({ announcements: options.items ?? [view()] })
			}
			if (url.includes('/positions')) {
				return Response.json({
					positions: [
						{
							id: 'p1',
							name: 'Cook',
							nameAr: null,
							area: null,
							colorKey: 'neutral',
							tipEligible: false,
							archivedAt: null,
						},
					],
				})
			}
			return Response.json({})
		}),
	)
	return calls
}

function page() {
	return renderStaff(
		<StaffClientProvider orgSlug="acme">
			<AnnouncementsPage
				orgSlug="acme"
				scopes={[{ id: 'loc-1', name: 'Downtown' }]}
			/>
		</StaffClientProvider>,
	)
}

afterEach(() => {
	cleanup()
	vi.unstubAllGlobals()
})

describe('announcements for managers (#486)', () => {
	it('lists what is showing, with how many read it', async () => {
		stub()
		page()
		expect(await screen.findByText('New menu tomorrow')).toBeTruthy()
		expect(screen.getByText('Everyone')).toBeTruthy()
		expect(screen.getByText('Showing')).toBeTruthy()
		expect(screen.getByText(/1 of 3 have read it/)).toBeTruthy()
	})

	it('shows who read it and who has not, and takes it down', async () => {
		const calls = stub()
		page()
		fireEvent.click(await screen.findByText('New menu tomorrow'))
		const dialog = await screen.findByRole('dialog')
		expect(await within(dialog).findByText('Omar Saleh')).toBeTruthy()
		expect(within(dialog).getByText('Rana Khalid')).toBeTruthy()
		expect(within(dialog).getByText('Not yet')).toBeTruthy()
		expect(within(dialog).getByText(/1 of 3 have read it/)).toBeTruthy()
		fireEvent.click(
			within(dialog).getByRole('button', { name: 'Take it down' }),
		)
		await waitFor(() =>
			expect(
				calls.some(
					(c) =>
						c.method === 'POST' && c.url.endsWith('/announcements/a1/withdraw'),
				),
			).toBe(true),
		)
	})

	it('writes one for everyone with an expiry date, as plain text', async () => {
		const calls = stub()
		page()
		fireEvent.click(
			await screen.findByRole('button', { name: 'New announcement' }),
		)
		const dialog = await screen.findByRole('dialog')
		const send = within(dialog).getByRole('button', {
			name: 'Send',
		}) as HTMLButtonElement
		expect(send).toBeDisabled()
		fireEvent.change(within(dialog).getByLabelText('Title'), {
			target: { value: 'Health inspection Friday' },
		})
		fireEvent.change(within(dialog).getByLabelText('Message'), {
			target: { value: '<b>Label everything</b>' },
		})
		fireEvent.change(within(dialog).getByLabelText('Stops showing after'), {
			target: { value: '2999-01-01' },
		})
		expect(send).toBeEnabled()
		fireEvent.click(send)
		await waitFor(() =>
			expect(
				calls.some(
					(c) => c.method === 'POST' && c.url.endsWith('/announcements'),
				),
			).toBe(true),
		)
		const post = calls.find((c) => c.method === 'POST')!
		expect(post.body).toMatchObject({
			title: 'Health inspection Friday',
			body: '<b>Label everything</b>',
			audience: 'everyone',
		})
		expect(post.body.audienceId).toBeUndefined()
		expect(typeof post.body.expiresAt).toBe('number')
	})

	it('offers no way to write without the roster grant', async () => {
		stub({ grants: ['read:staff:any'] })
		page()
		await screen.findByText('New menu tomorrow')
		expect(
			screen.queryByRole('button', { name: 'New announcement' }),
		).toBeNull()
	})

	it('says so when there is nothing yet', async () => {
		stub({ items: [] })
		page()
		expect(await screen.findByText('No announcements')).toBeTruthy()
	})
})
