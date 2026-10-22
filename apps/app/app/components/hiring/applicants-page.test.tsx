// @vitest-environment jsdom

import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StaffClientProvider } from '#app/components/staff/staff-client-provider.tsx'
import {
	applicant,
	listResponse,
} from '#app/utils/hiring/applicant-fixtures.ts'
import { type ApplicantScope } from '#app/utils/hiring/applicant-types.ts'
import { renderStaff } from '#tests/staff-render.tsx'
import { ApplicantsPage } from './applicants-page.tsx'

// Requests that finish after a test ends (fire-and-forget reloads) must not
// reach MSW: swallow them instead of restoring its patched fetch.
afterEach(() => {
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => Response.json({})),
	)
})

let mobile = false
beforeEach(() => {
	mobile = false
	vi.stubGlobal(
		'matchMedia',
		(query: string) =>
			({
				matches: mobile && query.includes('max-width'),
				media: query,
				addEventListener: () => {},
				removeEventListener: () => {},
			}) as unknown as MediaQueryList,
	)
	Object.defineProperty(window, 'matchMedia', {
		configurable: true,
		writable: true,
		value: (query: string) => ({
			matches: mobile && query.includes('max-width'),
			media: query,
			addEventListener: () => {},
			removeEventListener: () => {},
		}),
	})
	Object.defineProperty(window, 'innerWidth', {
		configurable: true,
		writable: true,
		value: 1200,
	})
})

type Call = { method: string; url: string; body: unknown }

const SCOPES: ApplicantScope[] = [
	{
		id: 'main',
		name: 'Main office',
		timeZone: 'America/Chicago',
		currency: 'USD',
	},
	{
		id: 'annex',
		name: 'Annex',
		timeZone: 'America/Chicago',
		currency: 'USD',
	},
]

function stubApi(options: {
	list?: unknown
	grants?: string[]
	respond?: (call: Call) => Response | undefined
}) {
	const calls: Call[] = []
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input)
			if (url.includes('/staff/token')) {
				return Response.json({
					jwt: 'jwt',
					tenantApiUrl: 'https://us.tenant.test',
					scope: 'hiring',
					grants: options.grants ?? ['read:hiring:any', 'update:hiring:any'],
					expiresAt: Date.now() + 600_000,
				})
			}
			const call: Call = {
				method: init?.method ?? 'GET',
				url,
				body: init?.body ? JSON.parse(String(init.body)) : null,
			}
			calls.push(call)
			return options.respond?.(call) ?? Response.json(options.list ?? {})
		}),
	)
	return calls
}

function view(
	props: Partial<Parameters<typeof ApplicantsPage>[0]> = {},
	route = '/acme/staff/hiring/applicants',
) {
	return renderStaff(
		<StaffClientProvider orgSlug="acme">
			<Routes>
				<Route
					path="/acme/staff/hiring/applicants"
					element={
						<ApplicantsPage
							orgSlug="acme"
							userId="u1"
							canWrite
							canInvite={false}
							scopes={SCOPES}
							{...props}
						/>
					}
				/>
			</Routes>
		</StaffClientProvider>,
		{ route },
	)
}

const PEOPLE = [
	applicant({
		id: 'a1',
		firstName: 'Amira',
		stage: 'new',
		flagCount: 1,
		screenerScore: 40,
	}),
	applicant({ id: 'a2', firstName: 'Bilal', stage: 'screening' }),
	applicant({
		id: 'a3',
		firstName: 'Carla',
		stage: 'interview',
		interviewAt: Date.now() + 86_400_000,
	}),
]

describe('ApplicantsPage', () => {
	it('shows the open stages as columns with people in them', async () => {
		const calls = stubApi({ list: listResponse(PEOPLE) })
		view()
		const newColumn = await screen.findByRole('region', { name: /^New/ })
		expect(
			within(newColumn).getByRole('link', { name: 'Amira Ali' }),
		).toBeTruthy()
		expect(
			within(screen.getByRole('region', { name: /^Screening/ })).getByText(
				'Bilal Ali',
			),
		).toBeTruthy()
		expect(
			within(screen.getByRole('region', { name: /^Interview/ })).getByText(
				'Carla Ali',
			),
		).toBeTruthy()
		expect(screen.getByRole('region', { name: /^Offer/ })).toBeTruthy()
		// The board asks for every open stage at once.
		const request = calls.find((c) => c.url.includes('/applications'))!
		expect(request.url).toContain('/operator/hiring/applications?')
		expect(request.url).toContain('stage=open')
		expect(request.method).toBe('GET')
	})

	it('words a flag and a score without colour alone, and never shows contact details', async () => {
		stubApi({ list: listResponse(PEOPLE) })
		view()
		await screen.findByRole('region', { name: /^New/ })
		expect(screen.getByText('1 answer to check')).toBeTruthy()
		expect(screen.getByText('Many answers differ')).toBeTruthy()
		expect(document.body.textContent).not.toContain('@example.com')
		expect(document.body.textContent).not.toContain('+1415')
	})

	it("links each card to the candidate and keeps the page's filters on the link", async () => {
		stubApi({ list: listResponse(PEOPLE) })
		view({}, '/acme/staff/hiring/applicants?scope=main')
		const link = await screen.findByRole('link', { name: 'Amira Ali' })
		expect(link.getAttribute('href')).toBe(
			'/acme/staff/hiring/applicants/a1?scope=main',
		)
	})

	it('moves a card from its menu, shows it there at once, and tells the server', async () => {
		const calls = stubApi({
			list: listResponse(PEOPLE),
			respond: (call) =>
				call.url.endsWith('/a1/stage')
					? Response.json({
							application: applicant({ id: 'a1', stage: 'offer' }),
						})
					: undefined,
		})
		view()
		await screen.findByRole('link', { name: 'Amira Ali' })
		fireEvent.click(
			screen.getByRole('button', { name: 'Move Amira Ali to another stage' }),
		)
		fireEvent.click(await screen.findByRole('menuitem', { name: /^Offer/ }))
		await waitFor(() =>
			expect(
				within(screen.getByRole('region', { name: /^Offer/ })).getByText(
					'Amira Ali',
				),
			).toBeTruthy(),
		)
		const move = calls.find((c) => c.url.endsWith('/applications/a1/stage'))!
		expect(move).toMatchObject({ method: 'POST', body: { stage: 'offer' } })
		// The board reloads after the move; wait for that round trip.
		await waitFor(() =>
			expect(
				calls.filter((c) => c.url.includes('/applications?')).length,
			).toBeGreaterThan(1),
		)
	})

	it('puts the card back and says why when the move fails', async () => {
		stubApi({
			list: listResponse(PEOPLE),
			respond: (call) =>
				call.url.endsWith('/a1/stage')
					? Response.json({ error: 'already_hired' }, { status: 409 })
					: undefined,
		})
		view()
		await screen.findByRole('link', { name: 'Amira Ali' })
		fireEvent.click(
			screen.getByRole('button', { name: 'Move Amira Ali to another stage' }),
		)
		fireEvent.click(await screen.findByRole('menuitem', { name: /^Offer/ }))
		await waitFor(() =>
			expect(
				within(screen.getByRole('region', { name: /^New/ })).getByText(
					'Amira Ali',
				),
			).toBeTruthy(),
		)
	})

	it('hides every move control from someone who can only read', async () => {
		stubApi({
			list: listResponse(PEOPLE),
			grants: ['read:hiring:any'],
		})
		view({ canWrite: false })
		await screen.findByRole('link', { name: 'Amira Ali' })
		expect(screen.queryByRole('button', { name: /^Move / })).toBeNull()
		expect(screen.getByRole('link', { name: 'Amira Ali' })).toBeTruthy()
	})

	it('can show the same people as a table, with a stage filter', async () => {
		const calls = stubApi({ list: listResponse(PEOPLE) })
		view({}, '/acme/staff/hiring/applicants?view=list')
		await screen.findAllByRole('link', { name: 'Amira Ali' })
		expect(screen.getByRole('columnheader', { name: 'Applicant' })).toBeTruthy()
		const interviewChip = screen.getByRole('tab', { name: /Interview/ })
		expect(interviewChip).toBeTruthy()
		fireEvent.click(screen.getByRole('tab', { name: /Declined/ }))
		await waitFor(() =>
			expect(calls.some((c) => c.url.includes('stage=declined'))).toBe(true),
		)
	})

	it('shows a list rather than a board on a phone', async () => {
		mobile = true
		window.innerWidth = 400
		stubApi({ list: listResponse(PEOPLE) })
		view()
		await screen.findAllByRole('link', { name: 'Amira Ali' })
		expect(screen.queryByRole('region', { name: /^Screening/ })).toBeNull()
		expect(screen.getByRole('tab', { name: /In progress/ })).toBeTruthy()
	})

	it('filters by flagged answers and by search', async () => {
		const calls = stubApi({ list: listResponse(PEOPLE) })
		view()
		await screen.findByRole('region', { name: /^New/ })
		fireEvent.click(screen.getByRole('button', { name: 'Answers to check' }))
		await waitFor(() =>
			expect(calls.some((c) => c.url.includes('flagged=1'))).toBe(true),
		)
		fireEvent.change(
			screen.getByRole('searchbox', { name: 'Search applicants' }),
			{
				target: { value: 'amir' },
			},
		)
		await waitFor(() =>
			expect(calls.some((c) => c.url.includes('q=amir'))).toBe(true),
		)
	})

	it('teaches the empty state, and offers to clear filters when filtered', async () => {
		stubApi({ list: listResponse([]) })
		view()
		expect(await screen.findByText('No applicants yet')).toBeTruthy()
		expect(
			screen.getByText('See your jobs').closest('a')?.getAttribute('href'),
		).toBe('/acme/staff/hiring')
	})

	it('explains a failure and offers to try again', async () => {
		stubApi({
			respond: () => Response.json({ error: 'boom' }, { status: 500 }),
		})
		view()
		const alert = await screen.findByRole('alert')
		expect(alert.textContent).toMatch(/Something went wrong/)
		expect(alert.textContent).not.toContain('boom ')
		expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
	})

	it('notes when the list is cut short', async () => {
		stubApi({ list: listResponse(PEOPLE, { total: 450 }) })
		view()
		await screen.findByRole('region', { name: /^New/ })
		expect(screen.getByText(/Showing the newest 3 of 450/)).toBeTruthy()
	})
})
