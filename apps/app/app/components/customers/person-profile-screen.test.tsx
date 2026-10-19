// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PersonProfileScreen } from '#app/components/customers/person-profile-screen.tsx'
import { type PeopleAccess } from '#app/utils/people/people-access.ts'
import {
	PeopleApiError,
	type PeopleClient,
	type PersonProfile,
} from '#app/utils/people/people-api.ts'
import { renderStaff } from '#tests/staff-render.tsx'

const FULL: PeopleAccess = {
	customers: true,
	dining: 'full',
	canUpdateCustomers: true,
	canUpdateDining: true,
	canDelete: true,
}

function profile(over: Partial<PersonProfile> = {}): PersonProfile {
	return {
		key: 'c_1',
		canonicalKey: 'c_1',
		kind: 'customer',
		status: 'signed_in',
		signedIn: true,
		customerLinked: true,
		walkIn: false,
		name: 'Vera Signed',
		phone: '+15555550100',
		email: 'vera@example.test',
		customer: {
			id: '1',
			name: 'Vera Signed',
			email: 'vera@example.test',
			phone: '+15555550100',
			phoneVerified: true,
			createdAt: 1,
			orders: { count: 2, lastOrderAt: null },
		},
		dining: {
			guest: {
				id: 'gst_1',
				firstName: 'Vera',
				lastName: 'Signed',
				phone: '+15555550100',
				email: 'vera@example.test',
				locale: 'en',
				allergyNotes: 'severe peanut allergy',
				hasAllergy: true,
				visits: 3,
				covers: 8,
				noShows: 1,
				lateCancels: 0,
				cancels: 0,
				firstVisitAt: null,
				lastVisitAt: null,
				version: 4,
				tags: [],
			},
			nextBookingAt: null,
			notes: [{ id: 'n1', body: 'Corner booth', pinned: true, createdAt: 1 }],
			pinnedNotes: [{ id: 'n1', body: 'Corner booth' }],
			reservations: [],
		},
		marketing: {
			subscriptions: [
				{
					topic: 'reservations',
					channel: 'email',
					subscribed: true,
					subscribedAt: 1,
					unsubscribedAt: null,
					source: 'reservation_booking',
				},
			],
		},
		access: FULL,
		...over,
	}
}

function render(
	p: PersonProfile,
	extra?: (path: string, options?: { method?: string }) => unknown,
) {
	const request = vi.fn(async (path: string, options?: { method?: string }) => {
		if (extra) {
			const handled = extra(path, options)
			if (handled !== undefined) return handled
		}
		if (path === '/tags') return { tags: [] }
		return p
	})
	renderStaff(
		<PersonProfileScreen
			client={{ request } as unknown as PeopleClient}
			orgSlug="acme"
			personKey="c_1"
		/>,
	)
	return request
}

describe('PersonProfileScreen', () => {
	it('shows contact, dining, notes, history, marketing consent and data sections', async () => {
		render(profile())
		expect(await screen.findByTestId('person-profile-name')).toHaveTextContent(
			'Vera Signed',
		)
		expect(screen.getByTestId('person-dining')).toBeInTheDocument()
		expect(screen.getByTestId('person-stat-visits')).toHaveTextContent('3')
		expect(screen.getByTestId('person-allergy')).toHaveTextContent('peanut')
		expect(screen.getByTestId('guest-notes')).toHaveTextContent('Corner booth')
		expect(screen.getByTestId('person-history')).toBeInTheDocument()
		expect(
			screen.getByTestId('person-subscription-reservations-email'),
		).toHaveTextContent('Subscribed')
		expect(screen.getByTestId('person-stat-orders')).toHaveTextContent('2')
		expect(screen.getByTestId('person-merge')).toBeInTheDocument()
		expect(screen.getByTestId('person-erase')).toBeInTheDocument()
	})

	it('shows no notes, allergy text or merge/erase without the grants', async () => {
		const p = profile({
			access: {
				customers: true,
				dining: 'flags',
				canUpdateCustomers: false,
				canUpdateDining: false,
				canDelete: false,
			},
		})
		p.dining!.notes = []
		p.dining!.pinnedNotes = []
		p.dining!.guest.allergyNotes = null
		p.dining!.guest.hasAllergy = null
		render(p)
		await screen.findByTestId('person-dining')
		expect(screen.queryByTestId('person-allergy')).toBeNull()
		expect(screen.queryByTestId('guest-notes')).toBeNull()
		expect(screen.queryByTestId('person-merge')).toBeNull()
		expect(screen.queryByTestId('person-erase')).toBeNull()
		expect(screen.queryByTestId('person-edit')).toBeNull()
	})

	it('hides the Dining section when the member has no dining facet', async () => {
		render(
			profile({
				dining: null,
				access: { ...FULL, dining: 'none', canUpdateDining: false },
			}),
		)
		await screen.findByTestId('person-contact')
		expect(screen.queryByTestId('person-dining')).toBeNull()
	})

	it('erases only after the name is typed, and states what is erased', async () => {
		const request = render(profile(), (path, options) =>
			path === '/c_1/erase' && options?.method === 'POST'
				? { guestsErased: 1, customersErased: 1 }
				: undefined,
		)
		fireEvent.click(await screen.findByTestId('person-erase'))
		const list = await screen.findByTestId('person-erase-list')
		expect(list).toHaveTextContent('Reservations')
		expect(list).toHaveTextContent('Orders')
		expect(list).toHaveTextContent('Marketing choices')
		expect(list).toHaveTextContent('Messages')
		const confirm = screen.getByTestId('person-erase-confirm')
		expect(confirm).toBeDisabled()
		fireEvent.change(screen.getByTestId('person-erase-confirm-input'), {
			target: { value: 'someone else' },
		})
		expect(confirm).toBeDisabled()
		fireEvent.change(screen.getByTestId('person-erase-confirm-input'), {
			target: { value: 'vera signed' },
		})
		expect(confirm).toBeEnabled()
		fireEvent.click(confirm)
		await waitFor(() =>
			expect(request).toHaveBeenCalledWith('/c_1/erase', {
				method: 'POST',
				body: {},
			}),
		)
	})

	it('explains a 409 merge_conflicting_customers in plain words', async () => {
		render(profile(), (path, options) => {
			if (path === '/merge' && options?.method === 'POST') {
				throw new PeopleApiError('x', 409, 'merge_conflicting_customers')
			}
			if (path === '') {
				return {
					people: [
						{
							key: 'c_2',
							name: 'Second Customer',
							phone: null,
							email: null,
						},
					],
					nextCursor: null,
					total: 1,
					meta: {},
				}
			}
			return undefined
		})
		fireEvent.click(await screen.findByTestId('person-merge'))
		fireEvent.change(await screen.findByTestId('person-merge-search'), {
			target: { value: 'second' },
		})
		fireEvent.click(await screen.findByTestId('person-merge-option-c_2'))
		fireEvent.click(screen.getByTestId('person-merge-continue'))
		fireEvent.click(await screen.findByTestId('person-merge-confirm'))
		expect(await screen.findByTestId('person-merge-error')).toHaveTextContent(
			'both signed in as different customers',
		)
	})
})
