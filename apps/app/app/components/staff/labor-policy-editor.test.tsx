// @vitest-environment jsdom

import { BUILTIN_LABOR_POLICY } from '@repo/staffing'
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StaffClientProvider } from '#app/components/staff/staff-client-provider.tsx'
import { renderStaff } from '#tests/staff-render.tsx'
import { LaborPolicyEditor } from './labor-policy-editor.tsx'

afterEach(() => {
	vi.unstubAllGlobals()
})

type Call = { url: string; method: string; body: unknown }

const GRANTS = ['read:labor_policy:any', 'update:labor_policy:any']

function policyView(overrides: Record<string, unknown> = {}) {
	return {
		...BUILTIN_LABOR_POLICY,
		id: null,
		scopeId: 'loc-1',
		source: 'builtin',
		version: 1,
		updatedAt: null,
		aggregateDecisionRequired: false,
		...overrides,
	}
}

function stubApi(
	options: {
		grants?: string[]
		view?: Record<string, unknown>
		onPut?: (call: Call) => Response
		defaultPolicy?: Record<string, unknown> | null
	} = {},
) {
	const calls: Call[] = []
	let saved: Record<string, unknown> | null = null
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input)
			if (url.includes('/staff/token')) {
				return Response.json({
					jwt: 'jwt',
					tenantApiUrl: 'https://us.tenant.test',
					scope: 'timeclock',
					grants: options.grants ?? GRANTS,
					expiresAt: Date.now() + 600_000,
				})
			}
			const call: Call = {
				url,
				method: init?.method ?? 'GET',
				body: init?.body ? JSON.parse(String(init.body)) : null,
			}
			calls.push(call)
			if (call.method === 'PUT') {
				if (options.onPut) return options.onPut(call)
				saved = policyView({
					...options.view,
					...(call.body as object),
					source: 'scope',
					version: 2,
				})
				return Response.json(saved)
			}
			if (saved && !url.endsWith('/policies/default')) {
				return Response.json(saved)
			}
			if (url.endsWith('/policies/default')) {
				return Response.json({ policy: options.defaultPolicy ?? null })
			}
			return Response.json(policyView(options.view))
		}),
	)
	return calls
}

const scopes = [{ id: 'loc-1', name: 'Downtown', timeZone: 'America/Chicago' }]

function view(props: Partial<Parameters<typeof LaborPolicyEditor>[0]> = {}) {
	return renderStaff(
		<StaffClientProvider orgSlug="acme">
			<LaborPolicyEditor
				scopes={scopes}
				canEditDefault
				dataRegion="us"
				{...props}
			/>
		</StaffClientProvider>,
	)
}

/**
 * Advanced settings and each group inside them stay closed until opened (or
 * until something inside needs attention).
 */
async function openAdvanced(section?: string) {
	fireEvent.click(
		await screen.findByRole('button', { name: /Advanced settings/ }),
	)
	if (section) {
		fireEvent.click(
			await screen.findByRole('button', { name: new RegExp(`^${section}`) }),
		)
	}
}

describe('LaborPolicyEditor', () => {
	it('groups the rules in plain language and says these are estimates, not advice', async () => {
		stubApi()
		view()
		await screen.findByRole('heading', {
			name: 'How strict do you want to be?',
		})
		// The rules most people want are sentences, not a long form.
		for (const name of [
			'Track time at this workplace',
			'Deduct an unpaid break when none was recorded',
			'Weekly overtime',
		]) {
			expect(screen.getByRole('switch', { name })).toBeTruthy()
		}
		await openAdvanced()
		for (const name of [
			'Timesheets',
			'Schedule enforcement',
			'Alerts and reminders',
			'Breaks',
			'Overtime and pay week',
			'Rounding',
		]) {
			expect(
				screen.getByRole('button', { name: new RegExp(`^${name}`) }),
			).toBeTruthy()
		}
		expect(
			screen.getByText(/These are settings, not legal advice/),
		).toBeTruthy()
		expect(screen.getAllByText(/are estimates/).length).toBeGreaterThan(0)
	})

	it('starts clean: nothing to save until something changes', async () => {
		stubApi()
		view()
		await screen.findByText('All changes saved.')
		expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled()
	})

	it('fills in the standard starter settings without saving them', async () => {
		const calls = stubApi()
		view()
		fireEvent.click(
			await screen.findByRole('radio', { name: /Standard starter/ }),
		)
		expect(screen.getByText('You have unsaved changes.')).toBeTruthy()
		expect(calls.some((call) => call.method === 'PUT')).toBe(false)
		expect(
			screen
				.getByRole('radio', { name: /Standard starter/ })
				.getAttribute('aria-checked'),
		).toBe('true')
		// Reminders rather than hard rules: one meal break, not required.
		await openAdvanced('Breaks')
		expect(screen.getByText('Meal break')).toBeTruthy()
	})

	it('saves only what changed, creating the workplace copy without a version', async () => {
		const calls = stubApi()
		view()
		await openAdvanced('Schedule enforcement')
		fireEvent.click(await screen.findByLabelText('Count as late after'))
		const late = screen.getByLabelText('Count as late after')
		fireEvent.change(late, { target: { value: '12' } })
		fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
		await waitFor(() =>
			expect(calls.some((c) => c.method === 'PUT')).toBe(true),
		)
		const put = calls.find((c) => c.method === 'PUT')!
		expect(put.url).toBe(
			'https://us.tenant.test/operator/timeclock/policies/loc-1',
		)
		expect(put.body).toEqual({ lateGraceMinutes: 12 })
		// The form settles on what it saved.
		await waitFor(() =>
			expect(
				screen.getByRole('button', { name: 'Save changes' }),
			).toBeDisabled(),
		)
	})

	it('sends the version it saw when changing an existing policy', async () => {
		const calls = stubApi({
			view: { source: 'scope', version: 3, id: 'p1' },
		})
		view()
		await openAdvanced('Schedule enforcement')
		fireEvent.change(await screen.findByLabelText('Count as late after'), {
			target: { value: '9' },
		})
		fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
		await waitFor(() =>
			expect(calls.some((c) => c.method === 'PUT')).toBe(true),
		)
		expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({
			lateGraceMinutes: 9,
			expectedVersion: 3,
		})
	})

	it('shows the alert settings with their defaults and saves a change to one', async () => {
		const calls = stubApi()
		view()
		await openAdvanced('Alerts and reminders')
		const noClockIn = await screen.findByRole('switch', {
			name: 'Tell managers when someone has not clocked in',
		})
		expect(noClockIn.getAttribute('aria-checked')).toBe('true')
		expect(screen.getByDisplayValue('15')).toBeTruthy()
		expect(
			screen
				.getByRole('switch', { name: 'Remind people before their shift' })
				.getAttribute('aria-checked'),
		).toBe('true')
		expect(
			screen
				.getByRole('switch', { name: 'Warn managers about overtime' })
				.getAttribute('aria-checked'),
		).toBe('true')

		fireEvent.click(noClockIn)
		expect(noClockIn.getAttribute('aria-checked')).toBe('false')
		fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
		await waitFor(() =>
			expect(calls.some((c) => c.method === 'PUT')).toBe(true),
		)
		expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({
			noClockInAlertMinutes: null,
		})
	})

	it('turns the other alerts off independently', async () => {
		const calls = stubApi()
		view()
		await openAdvanced('Alerts and reminders')
		fireEvent.click(
			await screen.findByRole('switch', {
				name: 'Remind people before their shift',
			}),
		)
		fireEvent.click(
			screen.getByRole('switch', { name: 'Warn managers about overtime' }),
		)
		fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
		await waitFor(() =>
			expect(calls.some((c) => c.method === 'PUT')).toBe(true),
		)
		expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({
			preShiftReminderMinutes: null,
			overtimeAlertMinutes: null,
		})
	})

	it('turns overtime on with a starting point', async () => {
		stubApi()
		view()
		fireEvent.click(
			await screen.findByRole('switch', { name: 'Weekly overtime' }),
		)
		expect(screen.getByDisplayValue('40')).toBeTruthy()
		expect(screen.getByDisplayValue('1.5')).toBeTruthy()
		expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled()
	})

	it('blocks a save the server would refuse, and says which setting', async () => {
		const calls = stubApi()
		view()
		await openAdvanced('Overtime and pay week')
		fireEvent.click(
			await screen.findByRole('switch', { name: 'Daily overtime' }),
		)
		fireEvent.click(screen.getByRole('switch', { name: 'Daily double time' }))
		const eight = screen
			.getAllByRole('textbox')
			.find((element) => (element as HTMLInputElement).value === '8')!
		fireEvent.change(eight, { target: { value: '14' } })
		expect(
			screen.getByText('Double time must start after daily overtime.'),
		).toBeTruthy()
		expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled()
		expect(calls.some((c) => c.method === 'PUT')).toBe(false)
	})

	it('makes the multi-scope overtime choice explicit and blocks saving until made', async () => {
		stubApi({
			defaultPolicy: policyView({
				source: 'default',
				scopeId: null,
				id: 'd1',
				version: 2,
				aggregateDecisionRequired: true,
			}),
		})
		view({
			scopes: [
				...scopes,
				{ id: 'loc-2', name: 'Airport', timeZone: 'America/Chicago' },
			],
		})
		await screen.findByText('People who work at more than one workplace')
		expect(
			screen.getByText('Choose how overtime is counted before saving.'),
		).toBeTruthy()
		fireEvent.click(screen.getByRole('switch', { name: 'Weekly overtime' }))
		expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled()
	})

	it('offers the organization default only when there are several workplaces and full access', async () => {
		stubApi()
		const two = [
			...scopes,
			{ id: 'loc-2', name: 'Airport', timeZone: 'America/Chicago' },
		]
		view({ scopes: two })
		const select = await screen.findByRole('combobox', { name: 'Rules for' })
		expect(select.textContent).toContain('All workplaces (default)')
		cleanup()
		stubApi()
		view({ scopes: two, canEditDefault: false })
		const scoped = await screen.findByRole('combobox', { name: 'Rules for' })
		expect(scoped.textContent).toContain('Downtown')
		cleanup()
		stubApi()
		view()
		await screen.findByText('All changes saved.')
		expect(screen.queryByRole('combobox', { name: 'Rules for' })).toBeNull()
	})

	it('shows the rules read-only without the update grant', async () => {
		stubApi({ grants: ['read:labor_policy:any'] })
		view()
		await screen.findByText('You can view these rules but not change them.')
		expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull()
	})

	it('reports a stale save and keeps the manager in the form', async () => {
		stubApi({
			view: { source: 'scope', version: 3, id: 'p1' },
			onPut: () =>
				Response.json(
					{ error: 'stale_version', currentVersion: 4 },
					{ status: 409 },
				),
		})
		view()
		await openAdvanced('Schedule enforcement')
		fireEvent.change(await screen.findByLabelText('Count as late after'), {
			target: { value: '9' },
		})
		fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
		const alert = await screen.findByRole('alert')
		expect(alert.textContent).toMatch(/Someone else changed these settings/)
		expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy()
		expect(screen.getByDisplayValue('9')).toBeTruthy()
	})

	it('shows server refusals beside the field', async () => {
		stubApi({
			onPut: () =>
				Response.json(
					{
						error: 'invalid_policy',
						problems: [{ path: 'longShiftMinutes', code: 'something_else' }],
					},
					{ status: 422 },
				),
		})
		view()
		await openAdvanced('Schedule enforcement')
		fireEvent.change(await screen.findByLabelText('Count as late after'), {
			target: { value: '9' },
		})
		fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
		expect(
			await screen.findByText('This value is outside the allowed range.'),
		).toBeTruthy()
	})

	it('applies a preset without saving and shows Custom once anything changes', async () => {
		const calls = stubApi()
		view()
		fireEvent.click(await screen.findByRole('radio', { name: /Strict/ }))
		expect(
			screen
				.getByRole('radio', { name: /Strict/ })
				.getAttribute('aria-checked'),
		).toBe('true')
		// Strict takes a missing break off, so that sentence is switched on.
		expect(
			screen
				.getByRole('switch', {
					name: 'Deduct an unpaid break when none was recorded',
				})
				.getAttribute('aria-checked'),
		).toBe('true')
		expect(calls.some((c) => c.method === 'PUT')).toBe(false)
		fireEvent.change(screen.getByLabelText('Deduct'), {
			target: { value: '20' },
		})
		expect(
			screen
				.getByRole('radio', { name: /Strict/ })
				.getAttribute('aria-checked'),
		).toBe('false')
		expect(screen.getByText('Custom: what you have now')).toBeTruthy()
	})

	it('edits a sentence in place and saves only that change', async () => {
		const calls = stubApi()
		view()
		fireEvent.change(await screen.findByLabelText('Flag shifts longer than'), {
			target: { value: '10' },
		})
		fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
		await waitFor(() =>
			expect(calls.some((c) => c.method === 'PUT')).toBe(true),
		)
		expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({
			longShiftMinutes: 600,
		})
	})

	it('explains an out-of-range sentence value and lets you discard it', async () => {
		const calls = stubApi()
		view()
		const input = await screen.findByLabelText('Flag shifts longer than')
		fireEvent.change(input, { target: { value: '0' } })
		expect(
			await screen.findByText('Enter between 1 and 48 hours.'),
		).toBeTruthy()
		expect(
			screen.getByText('Fix the highlighted settings to save.'),
		).toBeTruthy()
		expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled()
		const discard = screen.getByRole('button', { name: 'Discard' })
		expect(discard).toBeEnabled()
		fireEvent.click(discard)
		await waitFor(() =>
			expect((input as HTMLInputElement).value).toBe(
				String(BUILTIN_LABOR_POLICY.longShiftMinutes / 60),
			),
		)
		expect(screen.getByText('All changes saved.')).toBeTruthy()
		expect(calls.some((c) => c.method === 'PUT')).toBe(false)
	})

	it('marks and explains an out-of-range deduction and weekly limit', async () => {
		stubApi({
			view: {
				breakRules: {
					rules: [],
					autoDeduction: { afterMinutes: 6 * 60, deductMinutes: 30 },
				},
				weeklyOvertime: { thresholdMinutes: 40 * 60, multiplierBp: 15_000 },
			},
		})
		view()
		const deduct = await screen.findByLabelText('Deduct')
		fireEvent.change(deduct, { target: { value: '500' } })
		expect(
			await screen.findByText('Enter between 1 and 240 minutes.'),
		).toBeTruthy()
		expect(deduct.getAttribute('aria-invalid')).toBe('true')

		const weeklyAfter = screen.getByLabelText('After')
		fireEvent.change(weeklyAfter, { target: { value: '200' } })
		expect(
			await screen.findByText('Enter more than 0 and up to 168 hours.'),
		).toBeTruthy()
		expect(weeklyAfter.getAttribute('aria-invalid')).toBe('true')
		expect(screen.getByLabelText('For shifts longer than')).not.toHaveAttribute(
			'aria-invalid',
		)
		expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled()
	})

	it('shows what the rules do on an example shift, and follows the rules', async () => {
		stubApi()
		view()
		const example = await screen.findByRole('complementary', {
			name: 'Example shift',
		})
		// Nothing deducts a break or pays overtime until it is turned on.
		expect(example.textContent).toContain('Nobody recorded a break')
		expect(example.textContent).toContain('Overtime is off')
		fireEvent.click(
			screen.getByRole('switch', {
				name: 'Deduct an unpaid break when none was recorded',
			}),
		)
		fireEvent.click(screen.getByRole('switch', { name: 'Weekly overtime' }))
		expect(example.textContent).toContain('− 30m')
		// 4 earlier shifts plus this one just pass 40 hours once breaks come off.
		expect(example.textContent).toContain('paid at the overtime rate')
		expect(example.textContent).toContain('estimates, not payroll')
	})
})
