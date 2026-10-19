// @vitest-environment jsdom

import { Sheet, SheetContent } from '@repo/ui/sheet'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import type * as ReactRouter from 'react-router'
import { Outlet, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StaffClientProvider } from '#app/components/staff/staff-client-provider.tsx'
import { applicant, detail } from '#app/utils/hiring/applicant-fixtures.ts'
import { type ApplicantScope } from '#app/utils/hiring/applicant-types.ts'
import { renderStaff } from '#tests/staff-render.tsx'
import { type ApplicantsContext } from './applicant-context.ts'
import { CandidateSheet } from './candidate-sheet.tsx'

// The test router is not a data router, so the invite fetcher is replaced.
const fetcherSubmit = vi.hoisted(() => vi.fn())
vi.mock('react-router', async (importOriginal) => ({
	...(await importOriginal<typeof ReactRouter>()),
	useFetcher: () => ({
		state: 'idle',
		data: undefined,
		submit: fetcherSubmit,
	}),
}))

afterEach(() => {
	vi.unstubAllGlobals()
	fetcherSubmit.mockReset()
})

class ResizeObserverStub {
	observe() {}
	unobserve() {}
	disconnect() {}
}

type Call = { method: string; url: string; body: unknown }

const SCOPES: ApplicantScope[] = [
	{
		id: 'main',
		name: 'Main office',
		timeZone: 'America/Chicago',
		currency: 'USD',
	},
]

function stubApi(options: {
	detail?: unknown
	respond?: (call: Call) => Response | undefined
	grants?: string[]
}) {
	const calls: Call[] = []
	vi.stubGlobal('ResizeObserver', ResizeObserverStub)
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
			return (
				options.respond?.(call) ??
				(call.method === 'GET' && /\/applications\/[^/]+$/.test(url)
					? Response.json(options.detail ?? detail())
					: Response.json({}))
			)
		}),
	)
	return calls
}

/**
 * A successful change reloads the application behind the sheet, and that reload
 * is fire-and-forget: wait for it before the test ends. A reload GET that
 * slips out after the test runs on MSW's fetch again (the stub is gone), and
 * its unhandled-request warning fails the whole run.
 */
async function waitForDetailReload(calls: Call[]) {
	await waitFor(() =>
		expect(
			calls.filter(
				(c) => c.method === 'GET' && c.url.endsWith('/applications/a1'),
			).length,
		).toBeGreaterThan(1),
	)
}

function view(overrides: Partial<ApplicantsContext> = {}, canWrite = true) {
	const reload = vi.fn()
	const close = vi.fn()
	const context: ApplicantsContext = {
		orgSlug: 'acme',
		basePath: '/acme/staff/hiring/applicants',
		search: '?view=list',
		scopes: SCOPES,
		canWrite,
		userId: 'u1',
		canInvite: false,
		reload,
		close,
		...overrides,
	}
	renderStaff(
		<StaffClientProvider orgSlug="acme">
			<Routes>
				<Route
					path="/acme/staff/hiring/applicants"
					element={
						<Sheet open>
							<SheetContent>
								<Outlet context={context} />
							</SheetContent>
						</Sheet>
					}
				>
					<Route
						path=":applicationId"
						element={<CandidateSheet applicationId="a1" />}
					/>
				</Route>
			</Routes>
		</StaffClientProvider>,
		{ route: '/acme/staff/hiring/applicants/a1' },
	)
	return { reload, close }
}

describe('CandidateSheet', () => {
	it('shows who they are, how they matched, and what they said', async () => {
		const calls = stubApi({})
		view()
		await screen.findByText('Sara Ali')
		expect(screen.getByText(/Line cook/)).toBeTruthy()
		expect(screen.getByText('1 answer to check')).toBeTruthy()
		const email = screen.getByRole('link', { name: 'sara@example.com' })
		expect(email.getAttribute('href')).toBe('mailto:sara@example.com')
		expect(
			screen.getByRole('link', { name: '+14155550123' }).getAttribute('href'),
		).toBe('tel:+14155550123')
		expect(screen.getByText('Can you work weekends?')).toBeTruthy()
		expect(
			screen.getByText('Wanted: Yes. This one matters for the job.'),
		).toBeTruthy()
		expect(screen.getByText('Two years on the grill')).toBeTruthy()
		expect(
			screen.getByText(
				/They agreed to your privacy notice \(version 2026-10\)/,
			),
		).toBeTruthy()
		expect(screen.getByText(/removed after 365 days/)).toBeTruthy()
		const read = calls.find((c) =>
			c.url.endsWith('/operator/hiring/applications/a1'),
		)!
		expect(read.method).toBe('GET')
	})

	it('escapes what the applicant wrote', async () => {
		stubApi({
			detail: detail({
				answers: [
					{
						id: 'about',
						kind: 'open',
						prompt: 'About you',
						answer: '<img src=x onerror=alert(1)><script>alert(2)</script>',
					},
				],
			}),
		})
		view()
		await screen.findByText('Sara Ali')
		expect(document.querySelector('img[src="x"]')).toBeNull()
		expect(document.querySelector('script')).toBeNull()
		expect(screen.getByText(/<img src=x onerror=alert\(1\)>/)).toBeTruthy()
	})

	it('offers the next steps to someone who can change things, and none to someone who cannot', async () => {
		stubApi({})
		view()
		await screen.findByText('Sara Ali')
		expect(screen.getByRole('button', { name: 'Hire' })).toBeTruthy()
		expect(screen.getByRole('button', { name: 'Interview' })).toBeTruthy()
		expect(screen.getByRole('button', { name: 'Decline' })).toBeTruthy()
		expect(screen.getByRole('combobox', { name: 'Stage' })).toBeTruthy()
	})

	it('is read-only without the update grant', async () => {
		stubApi({ grants: ['read:hiring:any'] })
		view({}, false)
		await screen.findByText('Sara Ali')
		expect(screen.queryByRole('button', { name: 'Hire' })).toBeNull()
		expect(screen.queryByRole('button', { name: 'Decline' })).toBeNull()
		expect(screen.queryByRole('combobox', { name: 'Stage' })).toBeNull()
		expect(
			screen.queryByRole('button', { name: /More actions for/ }),
		).toBeNull()
	})

	it('explains a candidate it cannot find', async () => {
		stubApi({
			respond: () =>
				Response.json({ error: 'Application not found' }, { status: 404 }),
		})
		view()
		expect(
			await screen.findByText('We could not find that applicant'),
		).toBeTruthy()
		expect(screen.getByRole('alert').textContent).toMatch(
			/may have been removed/,
		)
	})

	it('declines with a reason and a message, then reloads the pipeline', async () => {
		const calls = stubApi({
			respond: (call) =>
				call.url.endsWith('/decline')
					? Response.json({
							application: applicant({ stage: 'declined' }),
							email: 'sent',
						})
					: undefined,
		})
		const { reload } = view()
		await screen.findByText('Sara Ali')
		fireEvent.click(screen.getByRole('button', { name: 'Decline' }))
		const dialog = await screen.findByRole('dialog')
		expect(within(dialog).getByText('Decline Sara Ali')).toBeTruthy()
		expect(within(dialog).getByText(/removed after 365 days/)).toBeTruthy()
		// "Thank them" is chosen for an applicant with an email.
		expect(
			within(dialog)
				.getByRole('radio', { name: /Thank them/ })
				.getAttribute('aria-checked'),
		).toBe('true')
		fireEvent.click(within(dialog).getByRole('button', { name: 'Decline' }))
		await waitFor(() =>
			expect(calls.some((c) => c.url.endsWith('/decline'))).toBe(true),
		)
		const call = calls.find((c) => c.url.endsWith('/decline'))!
		expect(call).toMatchObject({
			method: 'POST',
			body: { reason: 'not_a_fit', template: 'thanks' },
		})
		await waitFor(() => expect(reload).toHaveBeenCalled())
		await waitForDetailReload(calls)
	})

	it('cannot send a message to someone with no email', async () => {
		const calls = stubApi({
			detail: detail({ email: null }),
			respond: (call) =>
				call.url.endsWith('/decline')
					? Response.json({
							application: applicant({ stage: 'declined' }),
							email: 'no_email',
						})
					: undefined,
		})
		view()
		await screen.findByText('Sara Ali')
		fireEvent.click(screen.getByRole('button', { name: 'Decline' }))
		const dialog = await screen.findByRole('dialog')
		expect(within(dialog).getByText(/There is no email on file/)).toBeTruthy()
		expect(
			within(dialog)
				.getByRole('radio', { name: /Do not send anything/ })
				.getAttribute('aria-checked'),
		).toBe('true')
		fireEvent.click(within(dialog).getByRole('button', { name: 'Decline' }))
		await waitFor(() =>
			expect(calls.some((c) => c.url.endsWith('/decline'))).toBe(true),
		)
		expect(calls.find((c) => c.url.endsWith('/decline'))!.body).toMatchObject({
			template: 'none',
		})
		await waitForDetailReload(calls)
	})

	it("books the interview in the workplace's time zone, not the browser's", async () => {
		const calls = stubApi({
			respond: (call) =>
				call.url.endsWith('/interviews') && call.method === 'POST'
					? Response.json({
							interview: {
								id: 'i1',
								applicationId: 'a1',
								scopeId: 'main',
								scheduledAt: 1,
								durationMinutes: 30,
								mode: 'in_person',
								details: null,
								status: 'scheduled',
								outcome: null,
								inviteStatus: 'sent',
								inviteSentAt: 1,
								createdBy: 'u1',
								createdAt: 1,
							},
						})
					: undefined,
		})
		view()
		await screen.findByText('Sara Ali')
		fireEvent.click(screen.getByRole('button', { name: 'Interview' }))
		const dialog = await screen.findByRole('dialog')
		expect(
			within(dialog).getByText(/Main office \(America\/Chicago\)/),
		).toBeTruthy()
		fireEvent.change(within(dialog).getByLabelText('Date'), {
			target: { value: '2030-01-15' },
		})
		fireEvent.change(within(dialog).getByLabelText('Time'), {
			target: { value: '09:30' },
		})
		fireEvent.change(
			within(dialog).getByLabelText(/Details for the applicant/),
			{
				target: { value: 'Ask for Hana' },
			},
		)
		fireEvent.click(within(dialog).getByRole('button', { name: 'Schedule' }))
		await waitFor(() =>
			expect(calls.some((c) => c.url.endsWith('/interviews'))).toBe(true),
		)
		const call = calls.find((c) => c.url.endsWith('/interviews'))!
		// 09:30 in Chicago in January (UTC-6) is 15:30 UTC.
		expect(call.body).toMatchObject({
			scheduledAt: Date.UTC(2030, 0, 15, 15, 30),
			durationMinutes: 30,
			mode: 'in_person',
			details: 'Ask for Hana',
			sendInvite: true,
		})
		// The applicant has a workplace already, so none is sent.
		expect(call.body).not.toHaveProperty('scopeId')
		await waitForDetailReload(calls)
	})

	it('does not book a time that has passed, and says so', async () => {
		const calls = stubApi({})
		view()
		await screen.findByText('Sara Ali')
		fireEvent.click(screen.getByRole('button', { name: 'Interview' }))
		const dialog = await screen.findByRole('dialog')
		fireEvent.change(within(dialog).getByLabelText('Date'), {
			target: { value: '2020-01-15' },
		})
		fireEvent.click(within(dialog).getByRole('button', { name: 'Schedule' }))
		expect(
			await within(dialog).findByText('Pick a time that has not passed yet.'),
		).toBeTruthy()
		expect(calls.some((c) => c.url.endsWith('/interviews'))).toBe(false)
	})

	it('hires with the position, workplace and first day, then offers the next steps', async () => {
		const calls = stubApi({
			respond: (call) => {
				if (call.url.endsWith('/positions')) {
					return Response.json({
						positions: [
							{ id: 'pos-1', name: 'Line cook', nameAr: null, area: null },
						],
					})
				}
				if (call.url.endsWith('/hire')) {
					return Response.json({
						staffId: 'staff-1',
						applicationId: 'a1',
						onboardingTasks: 5,
						inviteEmail: 'sara@example.com',
					})
				}
				return undefined
			},
		})
		const { reload } = view({ canInvite: true })
		await screen.findByText('Sara Ali')
		fireEvent.click(screen.getByRole('button', { name: 'Hire' }))
		const dialog = await screen.findByRole('dialog')
		fireEvent.change(within(dialog).getByLabelText('First day'), {
			target: { value: '2030-02-01' },
		})
		await waitFor(() =>
			expect(
				within(dialog).getByRole('button', { name: 'Hire' }),
			).toBeEnabled(),
		)
		fireEvent.click(within(dialog).getByRole('button', { name: 'Hire' }))
		await waitFor(() =>
			expect(calls.some((c) => c.url.endsWith('/hire'))).toBe(true),
		)
		const call = calls.find((c) => c.url.endsWith('/hire'))!
		expect(call.body).toMatchObject({
			scopeId: 'main',
			positionId: 'pos-1',
			hiredDate: '2030-02-01',
			workerType: 'employee',
			currency: 'USD',
			startOnboarding: true,
			rateMinor: null,
		})
		expect(await screen.findByText('Sara Ali is on your team')).toBeTruthy()
		expect(screen.getByText(/new-hire checklist with 5 tasks/)).toBeTruthy()
		fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }))
		// Only the address the applicant gave and the opaque staff id leave for the
		// control plane, through the same route the profile uses.
		expect(fetcherSubmit).toHaveBeenCalledWith(
			{ email: 'sara@example.com', staffId: 'staff-1' },
			{ method: 'post', action: '/acme/staff/invite' },
		)
		expect(
			screen.getByText('Open profile').closest('a')?.getAttribute('href'),
		).toBe('/acme/staff/team/staff-1')
		await waitFor(() => expect(reload).toHaveBeenCalled())
		await waitForDetailReload(calls)
	})

	it('leaves out the app invitation when this member cannot send one', async () => {
		const calls = stubApi({
			respond: (call) =>
				call.url.endsWith('/positions')
					? Response.json({
							positions: [
								{ id: 'pos-1', name: 'Cook', nameAr: null, area: null },
							],
						})
					: call.url.endsWith('/hire')
						? Response.json({
								staffId: 's',
								applicationId: 'a1',
								onboardingTasks: 0,
								inviteEmail: 'sara@example.com',
							})
						: undefined,
		})
		view({ canInvite: false })
		await screen.findByText('Sara Ali')
		fireEvent.click(screen.getByRole('button', { name: 'Hire' }))
		const dialog = await screen.findByRole('dialog')
		await waitFor(() =>
			expect(
				within(dialog).getByRole('button', { name: 'Hire' }),
			).toBeEnabled(),
		)
		fireEvent.click(within(dialog).getByRole('button', { name: 'Hire' }))
		await screen.findByText('Sara Ali is on your team')
		expect(screen.queryByRole('button', { name: 'Send invitation' })).toBeNull()
		await waitForDetailReload(calls)
	})

	it('tells a manager with no positions to add one first', async () => {
		stubApi({
			respond: (call) =>
				call.url.endsWith('/positions')
					? Response.json({ positions: [] })
					: undefined,
		})
		view()
		await screen.findByText('Sara Ali')
		fireEvent.click(screen.getByRole('button', { name: 'Hire' }))
		const dialog = await screen.findByRole('dialog')
		expect(
			await within(dialog).findByText(/You have not set up any positions yet/),
		).toBeTruthy()
		expect(within(dialog).getByRole('button', { name: 'Hire' })).toBeDisabled()
	})

	it("shows the server's refusal in plain words and keeps the dialog open", async () => {
		stubApi({
			respond: (call) =>
				call.url.endsWith('/positions')
					? Response.json({
							positions: [
								{ id: 'pos-1', name: 'Cook', nameAr: null, area: null },
							],
						})
					: call.url.endsWith('/hire')
						? Response.json({ error: 'staff_exists' }, { status: 409 })
						: undefined,
		})
		view()
		await screen.findByText('Sara Ali')
		fireEvent.click(screen.getByRole('button', { name: 'Hire' }))
		const dialog = await screen.findByRole('dialog')
		await waitFor(() =>
			expect(
				within(dialog).getByRole('button', { name: 'Hire' }),
			).toBeEnabled(),
		)
		fireEvent.click(within(dialog).getByRole('button', { name: 'Hire' }))
		expect(
			await within(dialog).findByText(
				/Someone on your team already has this email/,
			),
		).toBeTruthy()
		expect(screen.getByRole('dialog')).toBeTruthy()
	})

	it("shows a declined candidate's retention date and lets them back in", async () => {
		const calls = stubApi({
			detail: detail({
				stage: 'declined',
				declinedReason: 'position_filled',
				declinedAt: 1,
				retentionExpiresAt: Date.UTC(2027, 0, 5),
			}),
			respond: (call) =>
				call.url.endsWith('/stage')
					? Response.json({
							application: applicant({ id: 'a1', stage: 'new' }),
						})
					: undefined,
		})
		view()
		await screen.findByText('Sara Ali')
		expect(screen.getByText('Declined: Position filled.')).toBeTruthy()
		expect(screen.getByText(/Their details are removed on/)).toBeTruthy()
		expect(screen.queryByRole('button', { name: 'Hire' })).toBeNull()
		fireEvent.click(
			screen.getByRole('button', { name: 'Move back into the pipeline' }),
		)
		await waitFor(() =>
			expect(calls.some((c) => c.url.endsWith('/stage'))).toBe(true),
		)
		expect(calls.find((c) => c.url.endsWith('/stage'))!.body).toEqual({
			stage: 'new',
		})
		await waitForDetailReload(calls)
	})

	it('links a hired candidate to their profile', async () => {
		stubApi({
			detail: detail({
				stage: 'hired',
				hiredStaffId: 'staff-9',
				hiredAt: Date.UTC(2026, 9, 1),
			}),
		})
		view()
		await screen.findByText('Sara Ali')
		expect(screen.getByText(/Hired on/)).toBeTruthy()
		expect(
			screen.getByText('Open profile').closest('a')?.getAttribute('href'),
		).toBe('/acme/staff/team/staff-9')
		expect(screen.queryByRole('button', { name: 'Decline' })).toBeNull()
	})

	it("adds a note and shows a teammate's as theirs", async () => {
		const calls = stubApi({
			detail: detail({
				notes: [
					{
						id: 'n1',
						applicationId: 'a1',
						authorId: 'u2',
						body: 'Seemed keen',
						createdAt: Date.now(),
					},
					{
						id: 'n2',
						applicationId: 'a1',
						authorId: 'u1',
						body: 'Called back',
						createdAt: Date.now(),
					},
				],
			}),
			respond: (call) =>
				call.url.endsWith('/notes')
					? Response.json({
							note: {
								id: 'n3',
								applicationId: 'a1',
								authorId: 'u1',
								body: 'x',
								createdAt: 1,
							},
						})
					: undefined,
		})
		view()
		await screen.findByText('Sara Ali')
		fireEvent.click(screen.getByRole('tab', { name: /Notes/ }))
		expect(await screen.findByText('Seemed keen')).toBeTruthy()
		expect(screen.getByText(/A teammate/)).toBeTruthy()
		expect(screen.getByText(/^You ·/)).toBeTruthy()
		fireEvent.change(screen.getByLabelText('Add a note'), {
			target: { value: 'Great knife skills' },
		})
		fireEvent.click(screen.getByRole('button', { name: 'Add note' }))
		await waitFor(() =>
			expect(calls.some((c) => c.url.endsWith('/notes'))).toBe(true),
		)
		expect(calls.find((c) => c.url.endsWith('/notes'))!.body).toEqual({
			body: 'Great knife skills',
		})
		await waitForDetailReload(calls)
	})

	it('reads the timeline in plain words', async () => {
		stubApi({
			detail: detail({
				timeline: [
					{
						id: 'e3',
						kind: 'stage_changed',
						at: 3,
						actorId: 'u1',
						fromStage: 'new',
						toStage: 'interview',
						detail: null,
					},
					{
						id: 'e2',
						kind: 'invite_sent',
						at: 2,
						actorId: 'u1',
						fromStage: null,
						toStage: null,
						detail: 'no_email',
					},
					{
						id: 'e1',
						kind: 'applied',
						at: 1,
						actorId: null,
						fromStage: null,
						toStage: 'new',
						detail: null,
					},
				],
			}),
		})
		view()
		await screen.findByText('Sara Ali')
		fireEvent.click(screen.getByRole('tab', { name: 'History' }))
		expect(await screen.findByText('Moved from New to Interview')).toBeTruthy()
		expect(
			screen.getByText('No invitation sent: no email on file'),
		).toBeTruthy()
		expect(screen.getByText('Applied')).toBeTruthy()
	})

	it('lists interviews with how the invitation went and offers their actions', async () => {
		const calls = stubApi({
			detail: detail({
				interviews: [
					{
						id: 'i1',
						applicationId: 'a1',
						scopeId: 'main',
						scheduledAt: Date.UTC(2030, 0, 15, 15, 30),
						durationMinutes: 45,
						mode: 'phone',
						details: 'Call the front desk',
						status: 'scheduled',
						outcome: null,
						inviteStatus: 'sent',
						inviteSentAt: 1,
						createdBy: 'u1',
						createdAt: 1,
					},
				],
			}),
			respond: (call) =>
				call.method === 'PATCH'
					? Response.json({
							interview: {
								id: 'i1',
								applicationId: 'a1',
								scopeId: 'main',
								scheduledAt: 1,
								durationMinutes: 45,
								mode: 'phone',
								details: null,
								status: 'completed',
								outcome: null,
								inviteStatus: 'sent',
								inviteSentAt: 1,
								createdBy: 'u1',
								createdAt: 1,
							},
						})
					: undefined,
		})
		view()
		await screen.findByText('Sara Ali')
		fireEvent.click(screen.getByRole('tab', { name: /Interviews/ }))
		expect(await screen.findByText(/9:30\s?AM/)).toBeTruthy()
		expect(screen.getByText(/Phone call · 45 minutes · Scheduled/)).toBeTruthy()
		expect(screen.getByText('Invitation emailed')).toBeTruthy()
		fireEvent.click(
			screen.getByRole('button', { name: /Interview actions for/ }),
		)
		fireEvent.click(
			await screen.findByRole('menuitem', { name: 'Mark as done' }),
		)
		await waitFor(() =>
			expect(calls.some((c) => c.method === 'PATCH')).toBe(true),
		)
		const patch = calls.find((c) => c.method === 'PATCH')!
		expect(patch.url).toContain('/applications/a1/interviews/i1')
		expect(patch.body).toEqual({ status: 'completed' })
		await waitForDetailReload(calls)
	})

	it('confirms before deleting an application, and says what goes', async () => {
		const calls = stubApi({})
		const { reload } = view()
		await screen.findByText('Sara Ali')
		fireEvent.click(
			screen.getByRole('button', { name: /More actions for Sara Ali/ }),
		)
		fireEvent.click(
			await screen.findByRole('menuitem', { name: /Delete application/ }),
		)
		const dialog = await screen.findByRole('alertdialog')
		expect(
			within(dialog).getByText(/permanently deletes their application/),
		).toBeTruthy()
		expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
		fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
		await waitFor(() =>
			expect(calls.some((c) => c.method === 'DELETE')).toBe(true),
		)
		expect(calls.find((c) => c.method === 'DELETE')!.url).toMatch(
			/applications\/a1$/,
		)
		await waitFor(() => expect(reload).toHaveBeenCalled())
	})
})
