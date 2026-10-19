// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
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

function client(
	people: PersonRow[],
	meta: { hasOrders?: boolean; walkInCount?: number | null } = {},
) {
	const request = vi.fn(async (_path: string, _options?: unknown) => ({
		people,
		nextCursor: null,
		total: people.length,
		meta: { hasOrders: false, walkInCount: 0, ...meta },
	}))
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

const lastQuery = (request: ReturnType<typeof vi.fn>) =>
	(request.mock.calls.at(-1)?.[1] as { query: Record<string, unknown> }).query

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
		expect(request.mock.calls[0]?.[0]).toBe('')
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
})
