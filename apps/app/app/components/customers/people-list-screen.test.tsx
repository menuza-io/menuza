// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PeopleListScreen } from '#app/components/customers/people-list-screen.tsx'
import { type PeopleAccess } from '#app/utils/people/people-access.ts'
import {
	type PeopleClient,
	type PersonRow,
} from '#app/utils/people/people-api.ts'
import { renderStaff } from '#tests/staff-render.tsx'

const FULL: PeopleAccess = {
	customers: true,
	dining: 'full',
	canUpdateCustomers: true,
	canUpdateDining: true,
	canDelete: true,
}

function row(
	key: string,
	name: string,
	over: Partial<PersonRow> = {},
): PersonRow {
	return {
		key,
		kind: key.startsWith('c_') ? 'customer' : 'guest',
		name,
		phone: '+15555550100',
		email: null,
		status: key.startsWith('c_') ? 'signed_in' : 'guest_no_sign_in',
		signedIn: key.startsWith('c_'),
		hasDining: true,
		customerLinked: false,
		walkIn: false,
		dining: {
			visits: 4,
			covers: 9,
			noShows: 0,
			lastVisitAt: null,
			nextBookingAt: null,
		},
		orders: null,
		flags: { vip: false, allergy: false, noShowRisk: false },
		tags: [],
		createdAt: 1,
		lastActivityAt: 1,
		...over,
	}
}

const SUMMARY = {
	guests: { total: 120, change30d: 12 },
	returningGuests: { total: 45, change30d: -3, share: 0.375 },
	emailSubscribers: { total: 30, change30d: 0 },
	textSubscribers: { total: 1234, change30d: 1 },
	locationScoped: false,
	asOf: '2026-11-13T00:00:00.000Z',
}

function client(
	people: PersonRow[],
	meta: { hasOrders?: boolean; walkInCount?: number | null } = {},
) {
	const request = vi.fn(async (path: string, _options?: unknown) => {
		if (path === '/summary') return SUMMARY
		return {
			people,
			nextCursor: null,
			total: people.length,
			meta: { hasOrders: false, walkInCount: 0, ...meta },
		}
	})
	return { client: { request } as unknown as PeopleClient, request }
}

function renderList(
	people: PersonRow[],
	opts: {
		access?: PeopleAccess
		canBook?: boolean
		meta?: Parameters<typeof client>[1]
	} = {},
) {
	const { client: c, request } = client(people, opts.meta)
	renderStaff(
		<PeopleListScreen
			client={c}
			orgSlug="acme"
			access={opts.access ?? FULL}
			canBook={opts.canBook ?? false}
		/>,
	)
	return request
}

/** jsdom's Blob has no `.text()`. */
const readBlob = (blob: Blob) =>
	new Promise<string>((resolve) => {
		const reader = new FileReader()
		reader.onload = () => resolve(String(reader.result))
		reader.readAsText(blob)
	})

const listCalls = (request: ReturnType<typeof vi.fn>) =>
	request.mock.calls.filter((call) => call[0] !== '/summary')
const lastQuery = (request: ReturnType<typeof vi.fn>) =>
	(listCalls(request).at(-1)?.[1] as { query: Record<string, unknown> }).query

describe('PeopleListScreen', () => {
	it('shows a neutral "Guest, no sign-in" badge next to signed-in customers, and links to the profile', async () => {
		renderList([row('c_1', 'Vera Signed'), row('g_2', 'Gus Guest')])
		expect(await screen.findByTestId('person-row-c_1')).toBeInTheDocument()
		expect(screen.getByTestId('person-status-signed-in')).toHaveTextContent(
			'Signed in',
		)
		expect(screen.getByTestId('person-status-guest')).toHaveTextContent(
			'Guest, no sign-in',
		)
		expect(screen.getByTestId('person-link-g_2')).toHaveAttribute(
			'href',
			'/acme/customers/g_2',
		)
	})

	it('loads from the server and searches and filters there, not in the browser', async () => {
		const request = renderList([row('g_1', 'Gus Guest')])
		await screen.findByTestId('person-row-g_1')
		expect(listCalls(request)[0]?.[0]).toBe('')
		expect(lastQuery(request)).toMatchObject({ limit: 50 })
		fireEvent.click(screen.getByTestId('customers-filter-vip'))
		await waitFor(() => expect(lastQuery(request)).toMatchObject({ vip: 1 }))
		fireEvent.click(screen.getByTestId('customers-filter-lapsed'))
		await waitFor(() =>
			expect(lastQuery(request)).toMatchObject({ lapsed: 1, lapsedDays: 90 }),
		)
		fireEvent.click(screen.getByTestId('customers-filter-signed_in'))
		await waitFor(() =>
			expect(lastQuery(request)).toMatchObject({ account: 'signed_in' }),
		)
		// Signed in and guest only exclude each other.
		fireEvent.click(screen.getByTestId('customers-filter-guest_only'))
		await waitFor(() =>
			expect(lastQuery(request)).toMatchObject({ account: 'guest_only' }),
		)
		fireEvent.click(screen.getByTestId('customers-filter-walk_ins'))
		await waitFor(() =>
			expect(lastQuery(request)).toMatchObject({ includeWalkIns: 1 }),
		)
		fireEvent.change(screen.getByTestId('customers-search'), {
			target: { value: 'gus' },
		})
		await waitFor(() => expect(lastQuery(request)).toMatchObject({ q: 'gus' }))
	})

	it('shows the allergy chip only when the server sent the flag, and the no-show risk flag', async () => {
		renderList([
			row('g_1', 'Gus Guest', {
				flags: { vip: false, allergy: true, noShowRisk: true },
			}),
			row('g_2', 'Hosted', {
				flags: { vip: false, allergy: null, noShowRisk: false },
			}),
		])
		await screen.findByTestId('person-row-g_1')
		expect(screen.getByTestId('person-allergy-g_1')).toBeInTheDocument()
		expect(screen.getByTestId('person-no-show-risk-g_1')).toBeInTheDocument()
		expect(screen.queryByTestId('person-allergy-g_2')).not.toBeInTheDocument()
	})

	it('offers the allergy filter only with the guest grant, and no dining columns without the dining facet', async () => {
		renderList(
			[row('c_1', 'Vera Signed', { dining: null, hasDining: false })],
			{
				access: { ...FULL, dining: 'none', canUpdateDining: false },
			},
		)
		await screen.findByTestId('person-row-c_1')
		expect(screen.queryByTestId('customers-filter-allergy')).toBeNull()
		expect(screen.queryByTestId('customers-filter-vip')).toBeNull()
		expect(screen.queryByText('Next booking')).toBeNull()
	})

	it('shows the Orders column only when the organization has orders', async () => {
		renderList(
			[row('c_1', 'Vera', { orders: { count: 7, lastOrderAt: null } })],
			{ meta: { hasOrders: true } },
		)
		await screen.findByTestId('person-row-c_1')
		expect(screen.getByText('Orders')).toBeInTheDocument()
		expect(screen.getByText('7')).toBeInTheDocument()
	})

	it('puts New reservation in the header only when the member can book', async () => {
		renderList([row('g_1', 'Gus')], { canBook: true })
		const link = await screen.findByTestId('customers-new-reservation')
		expect(link).toHaveAttribute('href', '/acme/reservations/book')
	})

	it('has no New reservation action without booking rights', async () => {
		renderList([row('g_1', 'Gus')], { canBook: false })
		await screen.findByTestId('person-row-g_1')
		expect(screen.queryByTestId('customers-new-reservation')).toBeNull()
	})

	it('says walk-ins are hidden when a search finds nothing', async () => {
		renderList([], { meta: { walkInCount: 3 } })
		expect(await screen.findByTestId('customers-empty')).toBeInTheDocument()
		expect(
			screen.getByText(/Walk-ins without contact details are hidden/),
		).toBeInTheDocument()
	})

	describe('summary row', () => {
		it('shows the four totals with their 30-day change', async () => {
			renderList([row('g_1', 'Gus')])
			expect(await screen.findByTestId('customers-summary')).toBeInTheDocument()
			expect(
				screen.getByTestId('customers-summary-guests-total'),
			).toHaveTextContent('120')
			expect(
				screen.getByTestId('customers-summary-guests-change'),
			).toHaveTextContent('+12 in the last 30 days')
			expect(
				screen.getByTestId('customers-summary-returning-change'),
			).toHaveTextContent('−3 in the last 30 days')
			expect(
				screen.getByTestId('customers-summary-returning'),
			).toHaveTextContent('38% of guests')
			expect(
				screen.getByTestId('customers-summary-email-change'),
			).toHaveTextContent('No change in the last 30 days')
			expect(
				screen.getByTestId('customers-summary-sms-total'),
			).toHaveTextContent('1,234')
			expect(screen.queryByTestId('customers-summary-scoped')).toBeNull()
		})

		it('makes no request and shows no row without the customers facet', async () => {
			const request = renderList([row('c_1', 'Vera', { dining: null })], {
				access: { ...FULL, customers: false },
			})
			await screen.findByTestId('person-row-c_1')
			expect(screen.queryByTestId('customers-summary')).toBeNull()
			expect(screen.queryByTestId('customers-summary-loading')).toBeNull()
			expect(request.mock.calls.some((call) => call[0] === '/summary')).toBe(
				false,
			)
		})

		it('keeps the list usable when the totals fail, and Retry refetches', async () => {
			const { client: c, request } = client([row('g_1', 'Gus')])
			let fail = true
			request.mockImplementation(async (path: string) => {
				if (path === '/summary') {
					if (fail) throw new Error('boom')
					return SUMMARY
				}
				return {
					people: [row('g_1', 'Gus')],
					nextCursor: null,
					total: 1,
					meta: { hasOrders: false, walkInCount: 0 },
				}
			})
			renderStaff(
				<PeopleListScreen
					client={c}
					orgSlug="acme"
					access={FULL}
					canBook={false}
				/>,
			)
			const errorState = await screen.findByTestId('customers-summary-error')
			expect(errorState).toHaveAttribute('role', 'status')
			expect(errorState).toHaveAttribute('aria-live', 'polite')
			expect(await screen.findByTestId('person-row-g_1')).toBeInTheDocument()
			fail = false
			fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
			expect(await screen.findByTestId('customers-summary')).toBeInTheDocument()
		})

		it('filters the list from a tile, and clicking it again clears it', async () => {
			const request = renderList([row('g_1', 'Gus')])
			await screen.findByTestId('customers-summary')
			await screen.findByTestId('person-row-g_1')
			const tile = (id: string) => screen.getByTestId(`customers-summary-${id}`)
			// Guests is a plain "show all" button, not a toggle.
			expect(tile('guests')).not.toHaveAttribute('aria-pressed')
			expect(tile('returning')).toHaveAttribute('aria-pressed', 'false')

			fireEvent.click(tile('returning'))
			await waitFor(() =>
				expect(lastQuery(request)).toMatchObject({ returning: 1 }),
			)
			expect(tile('returning')).toHaveAttribute('aria-pressed', 'true')

			fireEvent.click(tile('email'))
			await waitFor(() =>
				expect(lastQuery(request)).toMatchObject({ subscribed: 'email' }),
			)
			expect(lastQuery(request).returning).toBeUndefined()

			fireEvent.click(tile('sms'))
			await waitFor(() =>
				expect(lastQuery(request)).toMatchObject({ subscribed: 'sms' }),
			)

			// Composes with a quick filter, and the same tile again clears it.
			fireEvent.click(screen.getByTestId('customers-filter-vip'))
			await waitFor(() =>
				expect(lastQuery(request)).toMatchObject({ vip: 1, subscribed: 'sms' }),
			)
			fireEvent.click(tile('sms'))
			await waitFor(() => expect(lastQuery(request).subscribed).toBeUndefined())
			expect(lastQuery(request)).toMatchObject({ vip: 1 })

			// Guests clears a group; the list Clear button clears it too.
			fireEvent.click(tile('returning'))
			await waitFor(() =>
				expect(lastQuery(request)).toMatchObject({ returning: 1 }),
			)
			fireEvent.click(tile('guests'))
			await waitFor(() => expect(lastQuery(request).returning).toBeUndefined())
			fireEvent.click(tile('email'))
			await waitFor(() =>
				expect(lastQuery(request)).toMatchObject({ subscribed: 'email' }),
			)
			fireEvent.click(screen.getByTestId('customers-clear-filters'))
			await waitFor(() => expect(lastQuery(request).subscribed).toBeUndefined())
			expect(tile('email')).toHaveAttribute('aria-pressed', 'false')
		})

		it('notes when the totals follow the member locations', async () => {
			const { client: c, request } = client([row('g_1', 'Gus')])
			request.mockImplementation(async (path: string) =>
				path === '/summary'
					? { ...SUMMARY, locationScoped: true }
					: {
							people: [],
							nextCursor: null,
							total: 0,
							meta: { hasOrders: false, walkInCount: 0 },
						},
			)
			renderStaff(
				<PeopleListScreen
					client={c}
					orgSlug="acme"
					access={FULL}
					canBook={false}
				/>,
			)
			expect(
				await screen.findByTestId('customers-summary-scoped'),
			).toHaveTextContent('Totals for your locations')
		})
	})
	it('sorts and filters by spend, points and dates on the server (#231)', async () => {
		const request = renderList([
			row('c_1', 'Big Spender', {
				spend: [{ currency: 'USD', minor: 7500 }],
				points: { balance: 40, used: 10 },
				marketing: { email: true, sms: true },
			}),
		])
		await screen.findByTestId('person-row-c_1')
		expect(screen.getByTestId('person-spend-c_1')).toHaveTextContent('$75.00')
		expect(screen.getByTestId('person-points-used-c_1')).toHaveTextContent('10')
		expect(screen.getByTestId('person-marketing-both')).toBeInTheDocument()

		fireEvent.click(screen.getByTestId('customers-view-top-guests'))
		await waitFor(() => expect(lastQuery(request).sort).toBe('total_spend'))
		fireEvent.click(screen.getByTestId('customers-view-top-rewards'))
		await waitFor(() => expect(lastQuery(request).sort).toBe('points_used'))

		fireEvent.change(screen.getByTestId('customers-joined-from'), {
			target: { value: '2026-01-01' },
		})
		fireEvent.change(screen.getByTestId('customers-last-order-to'), {
			target: { value: '2026-02-01' },
		})
		await waitFor(() => {
			expect(lastQuery(request).joinedFrom).toBe('2026-01-01')
			expect(lastQuery(request).lastOrderTo).toBe('2026-02-01')
		})
	})

	it('hides spend, points, saved views and export without the customers grant', async () => {
		renderList([row('g_1', 'Gus Guest')], {
			access: { ...FULL, customers: false },
		})
		await screen.findByTestId('person-row-g_1')
		expect(screen.queryByTestId('customers-export')).toBeNull()
		expect(screen.queryByTestId('customers-view-top-guests')).toBeNull()
		expect(screen.queryByTestId('person-spend-g_1')).toBeNull()
		expect(screen.queryByTestId('customers-last-order-from')).toBeNull()
	})

	describe('export (#231, #386)', () => {
		const created: Blob[] = []
		beforeEach(() => {
			created.length = 0
			URL.createObjectURL = vi.fn((blob: Blob) => {
				created.push(blob)
				return 'blob:test'
			})
			URL.revokeObjectURL = vi.fn()
			HTMLAnchorElement.prototype.click = vi.fn()
		})

		function exportClient(pages: number) {
			const calls: Array<Record<string, unknown>> = []
			const request = vi.fn(
				async (
					path: string,
					options?: { query?: Record<string, unknown>; signal?: AbortSignal },
				) => {
					if (path === '/summary') return SUMMARY
					if (path === '/export') {
						calls.push(options?.query ?? {})
						const index = Number(options?.query?.cursor ?? 0)
						return {
							header: ['Name'],
							rows: [[`Guest ${index}`]],
							nextCursor: index + 1 < pages ? String(index + 1) : null,
							total: pages,
							matching: pages,
							truncated: false,
							footer: null,
						}
					}
					return {
						people: [row('c_1', 'Vera Signed')],
						nextCursor: null,
						total: 1,
						meta: { hasOrders: false, walkInCount: 0 },
					}
				},
			)
			return { client: { request } as unknown as PeopleClient, calls }
		}

		it('exports the current view page by page and saves one file', async () => {
			const { client: c, calls } = exportClient(3)
			renderStaff(
				<PeopleListScreen client={c} orgSlug="acme" access={FULL} canBook={false} />,
			)
			await screen.findByTestId('person-row-c_1')
			fireEvent.click(screen.getByTestId('customers-view-top-guests'))
			await waitFor(() =>
				expect(screen.getByTestId('customers-export')).not.toBeDisabled(),
			)
			fireEvent.click(screen.getByTestId('customers-export'))
			await waitFor(() => expect(created).toHaveLength(1))
			expect(calls).toHaveLength(3)
			// The export asks for the same sort as the view.
			expect(calls[0]).toMatchObject({ sort: 'total_spend' })
			expect(await readBlob(created[0]!)).toBe('Name\nGuest 0\nGuest 1\nGuest 2\n')
			expect(await screen.findByTestId('customers-export-done')).toBeInTheDocument()
		})

		it('shows progress while it runs and cancel leaves no file', async () => {
			let release: (() => void) | null = null
			const request = vi.fn(
				async (
					path: string,
					options?: { query?: Record<string, unknown>; signal?: AbortSignal },
				) => {
					if (path === '/summary') return SUMMARY
					if (path === '/export') {
						const cursor = Number(options?.query?.cursor ?? 0)
						if (cursor === 1) {
							// The second page never arrives until cancelled.
							await new Promise<void>((_resolve, reject) => {
								release = () => reject(new Error('unused'))
								options?.signal?.addEventListener('abort', () =>
									reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
								)
							})
						}
						return {
							rows: [['Guest']],
							header: ['Name'],
							nextCursor: '1',
							total: 4,
							matching: 4,
							truncated: false,
							footer: null,
						}
					}
					return {
						people: [row('c_1', 'Vera Signed')],
						nextCursor: null,
						total: 1,
						meta: { hasOrders: false, walkInCount: 0 },
					}
				},
			)
			renderStaff(
				<PeopleListScreen
					client={{ request } as unknown as PeopleClient}
					orgSlug="acme"
					access={FULL}
					canBook={false}
				/>,
			)
			await screen.findByTestId('person-row-c_1')
			fireEvent.click(screen.getByTestId('customers-export'))
			expect(await screen.findByTestId('customers-export-progress')).toBeInTheDocument()
			await waitFor(() =>
				expect(screen.getByTestId('customers-export-progress')).toHaveTextContent('25'),
			)
			fireEvent.click(screen.getByTestId('customers-export-cancel'))
			expect(await screen.findByTestId('customers-export-cancelled')).toBeInTheDocument()
			expect(created).toHaveLength(0)
			expect(release).not.toBeNull()
		})
	})
})
