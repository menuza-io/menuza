// @vitest-environment jsdom

import {
	cleanup,
	fireEvent,
	screen,
	waitFor,
	within,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StaffClientProvider } from '#app/components/staff/staff-client-provider.tsx'
import {
	demand,
	HOUR,
	NINE_AM,
	person,
	shift,
	week,
} from '#app/utils/staffing/schedule-fixtures.ts'
import { renderStaff } from '#tests/staff-render.tsx'
import { SchedulePage } from './schedule-page.tsx'

const EDIT = ['read:schedule:any', 'update:schedule:any', 'read:staff:any']
const VIEW = ['read:schedule:any', 'read:staff:any']

type Call = { method: string; url: string; body?: any }

const publication = (overrides: Record<string, unknown> = {}) => ({
	id: 'pub2',
	scopeId: 'loc-1',
	weekStart: '2026-03-02',
	version: 2,
	notifyMode: 'changed',
	summary: { created: 1, changed: 2, cancelled: 0, shifts: 3 },
	publishedBy: 'u1',
	publishedAt: Date.UTC(2026, 2, 3, 15, 14, 0),
	changes: [
		{ shiftId: 'a', kind: 'created', staffId: 's1' },
		{ shiftId: 'b', kind: 'changed', staffId: 's2', previousStaffId: 's1' },
	],
	notification: {
		mode: 'changed',
		recipients: 2,
		queued: 1,
		notReached: [{ staffId: 's2', reason: 'no_email' }],
	},
	...overrides,
})

const notices = (overrides: Record<string, unknown> = {}) => ({
	publicationId: 'pub2',
	mode: 'changed',
	current: true,
	emailEnabled: true,
	notices: [
		{ staffId: 's1', state: 'sent', reason: null, round: 0, sentAt: 5 },
	],
	notReached: [{ staffId: 's2', reason: 'no_email' }],
	...overrides,
})

function stub(options: {
	week: unknown
	grants?: string[]
	publishResult?: unknown
	publications?: unknown[]
	notices?: unknown
	resendResult?: unknown
	resendFails?: string
}) {
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
					scope: 'schedule',
					grants: options.grants ?? EDIT,
					expiresAt: Date.now() + 600_000,
				})
			}
			calls.push({
				method,
				url,
				body: init?.body ? JSON.parse(String(init.body)) : undefined,
			})
			if (url.includes('/operator/schedule/week')) {
				return Response.json(options.week)
			}
			if (url.includes('/operator/schedule/demand')) {
				return Response.json(demand())
			}
			if (url.includes('/operator/schedule/publish') && method === 'POST') {
				return Response.json(options.publishResult)
			}
			if (url.includes('/operator/schedule/publications/pub2/notices')) {
				return Response.json(options.notices ?? notices())
			}
			if (url.includes('/resend')) {
				if (options.resendFails) {
					return Response.json({ error: options.resendFails }, { status: 409 })
				}
				return Response.json(
					options.resendResult ?? { queued: 1, notReached: [] },
				)
			}
			if (url.includes('/operator/schedule/publications')) {
				return Response.json(options.publications ?? [publication()])
			}
			return Response.json({})
		}),
	)
	return calls
}

function view() {
	return renderStaff(
		<StaffClientProvider orgSlug="acme">
			<SchedulePage
				orgSlug="acme"
				scopes={[
					{ id: 'loc-1', name: 'Downtown', timeZone: 'America/Chicago' },
				]}
			/>
		</StaffClientProvider>,
		{ route: '/?date=2026-03-04' },
	)
}

const populated = (overrides: Record<string, unknown> = {}) =>
	week({
		people: [
			person({ id: 's1', firstName: 'Rana', lastName: 'Khalid' }),
			person({ id: 's2', firstName: 'Omar', lastName: 'Saleh' }),
			person({ id: 's3', firstName: 'Lina', lastName: 'Haddad' }),
		],
		shifts: [
			shift({ id: 'a', staffId: 's1', state: 'draft', version: 3 }),
			shift({
				id: 'b',
				staffId: 's2',
				state: 'changed',
				positionId: 'p2',
				localDate: '2026-03-03',
				startsAt: NINE_AM + 24 * HOUR,
				endsAt: NINE_AM + 32 * HOUR,
				published: {
					staffId: 's3',
					positionId: 'p2',
					startsAt: NINE_AM + 24 * HOUR,
					endsAt: NINE_AM + 32 * HOUR,
					unpaidBreakMinutes: 0,
					notes: null,
				},
				conflicts: [
					{ code: 'overtime', shiftId: 'b', detail: { minutes: 30 } },
				],
			}),
			shift({
				id: 'c',
				staffId: null,
				state: 'draft',
				localDate: '2026-03-05',
				startsAt: NINE_AM + 72 * HOUR,
				endsAt: NINE_AM + 78 * HOUR,
			}),
			shift({
				id: 'd',
				staffId: 's3',
				state: 'published',
				localDate: '2026-03-06',
				startsAt: NINE_AM + 96 * HOUR,
				endsAt: NINE_AM + 104 * HOUR,
			}),
		],
		unpublishedCount: 3,
		totals: {
			minutes: 1530,
			overtimeMinutes: 0,
			openShifts: 1,
			openMinutes: 360,
			costMinorByCurrency: { USD: 30600 },
		},
		...overrides,
	})

beforeEach(() => {
	window.innerWidth = 1200
})
afterEach(async () => {
	await new Promise((resolve) => setTimeout(resolve, 30))
	cleanup()
	vi.unstubAllGlobals()
})

async function openDialog() {
	fireEvent.click(await screen.findByRole('button', { name: /Publish \(3\)/ }))
	return screen.findByRole('dialog')
}

describe('publishing, with a summary first', () => {
	it('shows the shifts, hours, estimated cost and warnings before anything is sent', async () => {
		stub({ week: populated() })
		view()
		const dialog = await openDialog()
		const rows = within(dialog)
		expect(rows.getByText('Shifts').nextElementSibling?.textContent).toMatch(
			/4 shifts · 1 open/,
		)
		expect(
			rows.getByText('Scheduled hours').nextElementSibling?.textContent,
		).toBe('25h 30m')
		expect(
			rows.getByText('Estimated labor cost').nextElementSibling?.textContent,
		).toBe('$306.00')
		expect(rows.getByText('Warnings').nextElementSibling?.textContent).toBe(
			'1 shift needs a look',
		)
		expect(rows.getByText('2 new shifts')).toBeTruthy()
		expect(rows.getByText('1 changed shift')).toBeTruthy()
	})

	it('leaves the cost out when the member cannot see labor figures', async () => {
		stub({
			week: populated({
				totals: {
					minutes: 1530,
					overtimeMinutes: 0,
					openShifts: 1,
					openMinutes: 360,
				},
			}),
		})
		view()
		const dialog = await openDialog()
		expect(within(dialog).queryByText('Estimated labor cost')).toBeNull()
	})

	it('says how many people each choice would email', async () => {
		stub({ week: populated() })
		view()
		const dialog = await openDialog()
		// Changed: Rana (new), Omar (edited), Lina (loses the shift Omar takes).
		expect(
			within(dialog).getByText('About 3 people will be emailed.'),
		).toBeTruthy()
		fireEvent.click(within(dialog).getByText('Everyone on the schedule'))
		// Lina also works another published shift: still three.
		expect(
			within(dialog).getByText('About 3 people will be emailed.'),
		).toBeTruthy()
		fireEvent.click(within(dialog).getByText('Nobody'))
		expect(within(dialog).getByText('Nobody will be emailed.')).toBeTruthy()
	})

	it('then says who was told and who could not be reached, and offers the history', async () => {
		stub({
			week: populated(),
			publishResult: {
				publication: publication(),
				week: { version: 2, unpublishedCount: 0 },
			},
		})
		view()
		const dialog = await openDialog()
		fireEvent.click(within(dialog).getByRole('button', { name: 'Publish' }))
		expect(await within(dialog).findByText('Published')).toBeTruthy()
		expect(within(dialog).getByText('Emailing 1 person now.')).toBeTruthy()
		expect(
			within(dialog).getByText(
				/1 person could not be emailed\. Add an email address/,
			),
		).toBeTruthy()
		const list = within(dialog).getByText('Not notified').parentElement!
		expect(within(list).getByText('Omar Saleh')).toBeTruthy()
		expect(within(list).getByText('No email address on file')).toBeTruthy()
		fireEvent.click(
			within(dialog).getByRole('button', { name: 'Publish history' }),
		)
		expect(
			await screen.findByText('Publish history', {
				selector: '[data-slot="sheet-title"]',
			}),
		).toBeTruthy()
	})

	it('says so when published quietly, and when nobody needed an email', async () => {
		stub({
			week: populated(),
			publishResult: {
				publication: publication({
					notifyMode: 'nobody',
					notification: {
						mode: 'nobody',
						recipients: 0,
						queued: 0,
						notReached: [],
					},
				}),
				week: { version: 2, unpublishedCount: 0 },
			},
		})
		view()
		const dialog = await openDialog()
		fireEvent.click(within(dialog).getByRole('button', { name: 'Publish' }))
		expect(
			await within(dialog).findByText('Published quietly. Nobody was emailed.'),
		).toBeTruthy()
		expect(within(dialog).queryByText('Not notified')).toBeNull()
	})

	it('shows a person who has left the schedule by a generic name, not a blank', async () => {
		stub({
			week: populated(),
			publishResult: {
				publication: publication({
					notification: {
						mode: 'changed',
						recipients: 1,
						queued: 0,
						notReached: [{ staffId: 'gone', reason: 'inactive' }],
					},
				}),
				week: { version: 2, unpublishedCount: 0 },
			},
		})
		view()
		const dialog = await openDialog()
		fireEvent.click(within(dialog).getByRole('button', { name: 'Publish' }))
		expect(await within(dialog).findByText('A former team member')).toBeTruthy()
		expect(within(dialog).getByText('No longer on the team')).toBeTruthy()
	})

	it('reloads the week after a refusal instead of leaving a stale dialog', async () => {
		const calls = stub({ week: populated() })
		view()
		const dialog = await openDialog()
		const before = calls.filter((c) => c.url.includes('/week')).length
		// The stub answers the publish with nothing usable.
		fireEvent.click(within(dialog).getByRole('button', { name: 'Publish' }))
		await waitFor(() =>
			expect(
				calls.filter((c) => c.url.includes('/week')).length,
			).toBeGreaterThan(before),
		)
	})
})

describe('the publish history', () => {
	async function openHistory(grants?: string[]) {
		const calls = stub({ week: populated(), grants })
		view()
		fireEvent.click(
			await screen.findByRole('button', { name: 'More schedule actions' }),
		)
		fireEvent.click(
			await screen.findByRole('menuitem', { name: /Publish history/ }),
		)
		return { calls, sheet: await screen.findByRole('dialog') }
	}

	it('lists the weeks publications, newest first, with who was told', async () => {
		const { calls, sheet } = await openHistory()
		const toggle = await within(sheet).findByRole('button', { name: /told/ })
		expect(toggle.textContent).toMatch(/1 new, 2 changed/)
		expect(toggle.textContent).toMatch(/1 person told/)
		const request = calls.find((c) => c.url.includes('/publications?'))!
		expect(request.url).toContain('scopeId=loc-1')
		expect(request.url).toContain('weekStart=2026-03-02')
	})

	it('shows who changed, who got the email and who was not reached, by name', async () => {
		const { sheet } = await openHistory()
		expect(await within(sheet).findByText('Who changed')).toBeTruthy()
		expect(within(sheet).getAllByText('Rana Khalid').length).toBeGreaterThan(0)
		expect(await within(sheet).findByText('Sent')).toBeTruthy()
		expect(within(sheet).getByText('No email address on file')).toBeTruthy()
		expect(within(sheet).getAllByText('Omar Saleh').length).toBeGreaterThan(0)
	})

	it('resends to people not yet reached, or to everyone, for the latest publication', async () => {
		const { calls, sheet } = await openHistory()
		fireEvent.click(
			await within(sheet).findByRole('button', {
				name: 'Resend to people not yet reached',
			}),
		)
		await waitFor(() =>
			expect(calls.some((c) => c.url.endsWith('/resend'))).toBe(true),
		)
		expect(calls.find((c) => c.url.endsWith('/resend'))).toMatchObject({
			method: 'POST',
			body: { scope: 'unsent' },
		})
		fireEvent.click(
			within(sheet).getByRole('button', { name: 'Resend to everyone' }),
		)
		await waitFor(() =>
			expect(calls.filter((c) => c.url.endsWith('/resend'))).toHaveLength(2),
		)
		expect(calls.filter((c) => c.url.endsWith('/resend'))[1]!.body).toEqual({
			scope: 'all',
		})
	})

	it('says why a resend was refused, in plain words', async () => {
		stub({ week: populated(), resendFails: 'resend_too_soon' })
		view()
		fireEvent.click(
			await screen.findByRole('button', { name: 'More schedule actions' }),
		)
		fireEvent.click(
			await screen.findByRole('menuitem', { name: /Publish history/ }),
		)
		const sheet = await screen.findByRole('dialog')
		fireEvent.click(
			await within(sheet).findByRole('button', { name: 'Resend to everyone' }),
		)
		expect(
			await within(sheet).findByText(/This was just sent\. Wait a few minutes/),
		).toBeTruthy()
	})

	it('offers no resend to someone who can only read the schedule', async () => {
		const { sheet } = await openHistory(VIEW)
		await within(sheet).findByText('Sent')
		expect(within(sheet).queryByRole('button', { name: /Resend/ })).toBeNull()
	})

	it('does not offer a resend for a publication a newer one replaced', async () => {
		stub({
			week: populated(),
			notices: notices({ current: false }),
		})
		view()
		fireEvent.click(
			await screen.findByRole('button', { name: 'More schedule actions' }),
		)
		fireEvent.click(
			await screen.findByRole('menuitem', { name: /Publish history/ }),
		)
		const sheet = await screen.findByRole('dialog')
		expect(
			await within(sheet).findByText(
				/A newer version of this week was published/,
			),
		).toBeTruthy()
		expect(within(sheet).queryByRole('button', { name: /Resend/ })).toBeNull()
	})

	it('says when email is switched off, and offers no resend', async () => {
		stub({ week: populated(), notices: notices({ emailEnabled: false }) })
		view()
		fireEvent.click(
			await screen.findByRole('button', { name: 'More schedule actions' }),
		)
		fireEvent.click(
			await screen.findByRole('menuitem', { name: /Publish history/ }),
		)
		const sheet = await screen.findByRole('dialog')
		expect(
			await within(sheet).findByText(/Staff email is switched off/),
		).toBeTruthy()
		expect(within(sheet).queryByRole('button', { name: /Resend/ })).toBeNull()
	})

	it('says so when nothing has been published', async () => {
		stub({ week: populated(), publications: [] })
		view()
		fireEvent.click(
			await screen.findByRole('button', { name: 'More schedule actions' }),
		)
		fireEvent.click(
			await screen.findByRole('menuitem', { name: /Publish history/ }),
		)
		const sheet = await screen.findByRole('dialog')
		expect(
			await within(sheet).findByText('This week has not been published yet.'),
		).toBeTruthy()
	})

	it('words a quiet publication as one nobody was told about', async () => {
		stub({
			week: populated(),
			publications: [
				publication({
					notifyMode: 'nobody',
					notification: {
						mode: 'nobody',
						recipients: 0,
						queued: 0,
						notReached: [],
					},
				}),
			],
			notices: notices({ notices: [], notReached: [], mode: 'nobody' }),
		})
		view()
		fireEvent.click(
			await screen.findByRole('button', { name: 'More schedule actions' }),
		)
		fireEvent.click(
			await screen.findByRole('menuitem', { name: /Publish history/ }),
		)
		const sheet = await screen.findByRole('dialog')
		expect(await within(sheet).findByText(/Nobody told/)).toBeTruthy()
		expect(
			await within(sheet).findByText(
				'This was published quietly. Nobody was emailed.',
			),
		).toBeTruthy()
	})
})
