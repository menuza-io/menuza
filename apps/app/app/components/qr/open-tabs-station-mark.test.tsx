// @vitest-environment jsdom

import {
	cleanup,
	fireEvent,
	screen,
	waitFor,
	within,
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderStaff } from '#tests/staff-render.tsx'
import { OpenTabs } from './open-tabs.tsx'

const toasts = vi.hoisted(() => ({
	success: vi.fn(),
	error: vi.fn(),
	info: vi.fn(),
	warning: vi.fn(),
}))
vi.mock('sonner', () => ({ toast: toasts }))

afterEach(() => {
	cleanup()
	vi.unstubAllGlobals()
	vi.clearAllMocks()
})

const API = 'https://api-us.example.com'
const NOW = Date.now()
const SECTION = /rung up on a Station till in the last 24 hours/

type Call = { url: string; method: string; auth: string | null }

function markedTab(overrides: Record<string, unknown> = {}) {
	return {
		id: 'tab_1',
		tabNumber: '12',
		status: 'closed',
		paymentStatus: 'paid',
		paymentMethod: 'counter',
		table: { id: 'tbl_1', label: 'T4', locationId: 'loc_1' },
		openedAt: new Date(NOW - 3_600_000).toISOString(),
		closedAt: new Date(NOW - 600_000).toISOString(),
		guestName: null,
		lockedAt: null,
		voidReason: null,
		rungUpOnStation: true,
		rounds: [],
		roundsPending: false,
		totals: {
			currency: 'USD',
			subtotalCents: 800,
			taxCents: 80,
			tipCents: 0,
			totalCents: 880,
		},
		...overrides,
	}
}

function stubApi(
	options: {
		marked?: Array<ReturnType<typeof markedTab>>
		open?: Array<ReturnType<typeof markedTab>>
		/** The mark is already gone on the server (removed on another device). */
		alreadyRemoved?: boolean
	} = {},
) {
	const calls: Call[] = []
	let marked = options.marked ?? []
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
			const url = typeof input === 'string' ? input : input.toString()
			const method = init.method ?? 'GET'
			calls.push({
				url,
				method,
				auth: new Headers(init.headers).get('authorization'),
			})
			if (url.includes('/qr-token')) {
				return Response.json({
					jwt: url.includes('write=1') ? 'write-token' : 'read-token',
					tenantApiUrl: API,
				})
			}
			const path = url.startsWith(API) ? url.slice(API.length) : url
			if (
				method === 'GET' &&
				path === '/operator/qr/tabs?status=station&limit=200'
			) {
				return Response.json({ tabs: marked })
			}
			if (method === 'GET' && path === '/operator/qr/tabs?status=open') {
				return Response.json({ tabs: options.open ?? [] })
			}
			if (method === 'GET' && path.startsWith('/operator/qr/tabs?status=')) {
				return Response.json({ tabs: [] })
			}
			const clear = /^\/operator\/qr\/tabs\/([^/]+)\/clear-station-flag$/.exec(
				path,
			)
			if (method === 'POST' && clear) {
				const id = decodeURIComponent(clear[1]!)
				const tab = marked.find((entry) => entry.id === id)
				marked = marked.filter((entry) => entry.id !== id)
				if (options.alreadyRemoved || !tab) {
					return Response.json(
						{
							error: 'station_flag_not_set',
							message: 'This tab is not marked as rung up on a Station till.',
						},
						{ status: 409 },
					)
				}
				return Response.json({ tab: { ...tab, rungUpOnStation: false } })
			}
			return new Response('not found', { status: 404 })
		}),
	)
	return { calls }
}

const render = (props: Partial<Parameters<typeof OpenTabs>[0]> = {}) =>
	renderStaff(
		<OpenTabs
			orgSlug="joes"
			canWrite
			refreshKey={0}
			loyaltyEnabled
			{...props}
		/>,
	)

async function openMarkedList() {
	const section = await screen.findByRole('region', { name: SECTION })
	fireEvent.click(
		within(section).getByRole('button', {
			name: 'Show the tabs rung up on a Station till',
		}),
	)
	return section
}

describe('OpenTabs: tabs rung up on a Station till', () => {
	it('lists marked tabs behind a toggle and removes a mark after a warning', async () => {
		const api = stubApi({
			marked: [
				markedTab(),
				markedTab({
					id: 'tab_2',
					tabNumber: '13',
					table: { id: 'tbl_2', label: 'T7', locationId: 'loc_1' },
				}),
			],
		})
		render()
		const section = await screen.findByRole('region', {
			name: '2 tabs rung up on a Station till in the last 24 hours',
		})
		expect(within(section).queryByText('Table T4')).toBeNull()
		await openMarkedList()
		expect(within(section).getByText('Table T4')).toBeTruthy()
		expect(within(section).getByText('Table T7')).toBeTruthy()

		fireEvent.click(
			within(section).getByRole('button', {
				name: 'Remove the mark, tab 12, table T4',
			}),
		)
		const dialog = await screen.findByRole('alertdialog')
		expect(
			within(dialog).getByText('Remove the till mark from tab 12 (table T4)?'),
		).toBeTruthy()
		expect(within(dialog).getByText(/the guest could earn twice/)).toBeTruthy()
		fireEvent.click(
			within(dialog).getByRole('button', { name: 'Remove the mark' }),
		)

		await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
		expect(
			await screen.findByRole('region', {
				name: '1 tab rung up on a Station till in the last 24 hours',
			}),
		).toBeTruthy()
		expect(screen.queryByText('Table T4')).toBeNull()
		const post = api.calls.find((call) => call.method === 'POST')!
		expect(post.url).toBe(`${API}/operator/qr/tabs/tab_1/clear-station-flag`)
		expect(post.auth).toBe('Bearer write-token')
		expect(toasts.success).toHaveBeenCalledWith(
			'Mark removed from tab 12. It now earns loyalty points like any other tab.',
		)
	})

	it('drops the list once the last mark is removed', async () => {
		stubApi({ marked: [markedTab()] })
		render()
		const section = await openMarkedList()
		fireEvent.click(
			within(section).getByRole('button', {
				name: 'Remove the mark, tab 12, table T4',
			}),
		)
		fireEvent.click(
			within(await screen.findByRole('alertdialog')).getByRole('button', {
				name: 'Remove the mark',
			}),
		)
		await waitFor(() =>
			expect(screen.queryByRole('region', { name: SECTION })).toBeNull(),
		)
		await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
	})

	it('a mark already removed on another device closes the dialog with the reason', async () => {
		stubApi({ marked: [markedTab()], alreadyRemoved: true })
		render()
		const section = await openMarkedList()
		fireEvent.click(
			within(section).getByRole('button', {
				name: 'Remove the mark, tab 12, table T4',
			}),
		)
		fireEvent.click(
			within(await screen.findByRole('alertdialog')).getByRole('button', {
				name: 'Remove the mark',
			}),
		)
		await waitFor(() =>
			expect(toasts.error).toHaveBeenCalledWith(
				'This tab is not marked as rung up on a Station till.',
			),
		)
		await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
		expect(screen.queryByRole('region', { name: SECTION })).toBeNull()
		expect(toasts.success).not.toHaveBeenCalled()
	})

	it('a read-only member sees the marks but cannot remove them', async () => {
		stubApi({ marked: [markedTab()] })
		render({ canWrite: false })
		const section = await openMarkedList()
		expect(within(section).getByText('Table T4')).toBeTruthy()
		expect(
			within(section).queryByRole('button', { name: /Remove the mark/ }),
		).toBeNull()
	})

	it('names the close dialog till checkbox by its title, with the help as its description', async () => {
		stubApi({
			open: [
				markedTab({
					id: 'tab_3',
					tabNumber: '14',
					status: 'open',
					paymentStatus: 'unpaid',
					paymentMethod: null,
					closedAt: null,
					rungUpOnStation: false,
				}),
			],
		})
		render()
		fireEvent.click(
			await screen.findByRole('button', {
				name: 'Close at counter, tab 14, table T4',
			}),
		)
		const dialog = await screen.findByRole('alertdialog')
		const box = within(dialog).getByRole('checkbox', {
			name: 'Rung up on a Station till',
		})
		expect(box.getAttribute('aria-describedby')).toBe('tab-close-station-help')
		fireEvent.click(box)
		await waitFor(() =>
			expect(box.getAttribute('aria-describedby')).toBe(
				'tab-close-station-help tab-close-station-warning',
			),
		)
		expect(
			within(dialog).getByText(/The guest earns no points on this tab/),
		).toBeTruthy()
		expect(
			within(dialog).getByRole('checkbox', {
				name: 'Rung up on a Station till',
			}),
		).toBe(box)
	})

	it('neither asks for nor shows marks while loyalty is off', async () => {
		const api = stubApi({ marked: [markedTab()] })
		render({ loyaltyEnabled: false })
		await waitFor(() =>
			expect(api.calls.some((call) => call.url.includes('status=open'))).toBe(
				true,
			),
		)
		expect(api.calls.some((call) => call.url.includes('status=station'))).toBe(
			false,
		)
		expect(screen.queryByRole('region', { name: SECTION })).toBeNull()
	})
})
