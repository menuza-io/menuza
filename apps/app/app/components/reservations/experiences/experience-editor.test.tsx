// @vitest-environment jsdom
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { ExperienceEditor } from '#app/components/reservations/experiences/experience-editor.tsx'
import { RESERVATIONS_LAYOUT_ROUTE_ID } from '#app/utils/reservations/use-reservation-locales.ts'
import {
	apiError,
	createScriptedClient,
	type ScriptedCall,
} from '#app/components/reservations/scripted-test-client.ts'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const BASE = '/operator/reservations/setup/locations/loc_1'
const ITEM = `${BASE}/experiences/exp_1`

function schedule(over: Record<string, unknown> = {}) {
	return {
		id: 's1',
		experienceId: 'exp_1',
		fromDate: '2026-10-24',
		toDate: '2026-12-31',
		daysMask: 32,
		seatingMins: [1140],
		startMin: null,
		endMin: null,
		intervalMin: null,
		turnMin: 120,
		coversCapPerSeating: 8,
		coversCapPerDay: null,
		areaIds: ['main'],
		serviceId: null,
		seatings: [1140],
		...over,
	}
}

function experience(over: Record<string, unknown> = {}) {
	return {
		id: 'exp_1',
		locationId: 'loc_1',
		slug: 'chefs-counter',
		kind: 'ticketed',
		nameI18n: { en: "Chef's Counter", ar: 'مائدة الشيف' },
		descriptionI18n: { en: 'Eight courses.' },
		imageUrl: null,
		priceMinor: 7500,
		pricePerCover: true,
		currency: 'USD',
		policyId: null,
		partyMin: 2,
		partyMax: 4,
		usesTables: true,
		exclusive: false,
		status: 'draft',
		sort: 0,
		version: 3,
		schedules: [schedule()],
		...over,
	}
}

type Writer = (call: ScriptedCall) => unknown

function setup(
	options: {
		current?: Record<string, unknown>
		canWrite?: boolean
		paymentsEnabled?: boolean
		write?: Writer
		getError?: ReturnType<typeof apiError>
		/** The Website settings languages the reservations layout loader returns. */
		languages?: { locales: string[]; defaultLocale: string }
	} = {},
) {
	const scripted = createScriptedClient((call) => {
		if (call.method === 'GET') {
			if (call.path === ITEM) {
				if (options.getError) return options.getError
				return { experience: options.current ?? experience() }
			}
			if (call.path === `${BASE}/settings`) {
				return { settings: { version: 1, currency: 'USD' } }
			}
			if (call.path === `${BASE}/areas`) {
				return {
					areas: [
						{ id: 'main', name: 'Main room' },
						{ id: 'bar', name: 'Bar' },
					],
				}
			}
			if (call.path === `${BASE}/services`) {
				return { services: [{ id: 'dinner', name: 'Dinner' }] }
			}
			if (call.path === `${BASE}/policies`) {
				return { policies: [{ id: 'pol_1', name: 'Prepay in full' }] }
			}
		}
		return options.write?.(call)
	})
	i18n.load('en', {})
	i18n.activate('en')
	const router = createMemoryRouter(
		[
			{
				id: RESERVATIONS_LAYOUT_ROUTE_ID,
				path: '/',
				HydrateFallback: () => null,
				loader: () =>
					options.languages ? { siteLocales: options.languages } : null,
				children: [
					{
						index: true,
						element: (
							<ExperienceEditor
								client={scripted.client}
								locationId="loc_1"
								experienceId="exp_1"
								listHref="/list"
								canWrite={options.canWrite ?? true}
								paymentsEnabled={options.paymentsEnabled ?? true}
								today="2026-10-18"
							/>
						),
					},
				],
			},
			{ path: '/list', element: <div>list</div> },
		],
		{ initialEntries: ['/'] },
	)
	render(
		<I18nProvider i18n={i18n}>
			<RouterProvider router={router} />
		</I18nProvider>,
	)
	return { ...scripted, router }
}

const writes = (calls: ScriptedCall[]) =>
	calls.filter((call) => call.method !== 'GET')

async function ready() {
	return screen.findByTestId('experience-editor')
}

describe('ExperienceEditor loading', () => {
	it('shows the details, price, party range and schedules', async () => {
		setup()
		await ready()
		expect(
			(screen.getByTestId('experience-name') as HTMLInputElement).value,
		).toBe("Chef's Counter")
		expect(
			(screen.getByTestId('experience-price') as HTMLInputElement).value,
		).toBe('75.00')
		expect(
			(screen.getByTestId('experience-party-min') as HTMLInputElement).value,
		).toBe('2')
		const row = screen.getByTestId('schedule-row')
		expect(row.textContent).toContain('Sat')
		expect(row.textContent).toMatch(/7:00\s?PM/)
		expect(row.textContent).toContain('8 per seating')
		expect(row.textContent).toContain('Main room')
		expect(screen.getByTestId('experience-status').textContent).toBe('Draft')
	})

	it('says so when the experience is gone or access is refused', async () => {
		setup({ getError: apiError(404, 'not_found') })
		expect(await screen.findByTestId('experience-missing')).toBeTruthy()
	})

	it('decides access from the answer', async () => {
		setup({ getError: apiError(403, 'forbidden') })
		expect(await screen.findByTestId('experience-denied')).toBeTruthy()
	})

	it('is read-only without the settings grant', async () => {
		setup({ canWrite: false })
		await ready()
		expect(screen.queryByTestId('experience-save')).toBeNull()
		expect(screen.queryByTestId('experience-publish')).toBeNull()
		expect(screen.queryByTestId('schedule-add')).toBeNull()
		expect(screen.queryByTestId('schedule-edit')).toBeNull()
		expect(screen.getByTestId('experience-name')).toBeDisabled()
	})

	it('explains that payments are off instead of offering a policy', async () => {
		setup({ paymentsEnabled: false })
		await ready()
		expect(screen.getByText(/Online payments are off/)).toBeTruthy()
	})
})

describe('ExperienceEditor languages', () => {
	it('shows one name field and no switcher for a one-language organization', async () => {
		setup()
		await ready()
		expect(screen.queryByRole('radiogroup')).toBeNull()
		expect(screen.queryByText(/Arabic/)).toBeNull()
		expect(screen.queryByLabelText(/Language to edit/)).toBeNull()
	})

	it('writes each language of the organization and sends them as a map', async () => {
		const { calls } = setup({
			languages: { locales: ['en', 'es', 'zh'], defaultLocale: 'en' },
			write: () => ({ experience: experience({ version: 4 }) }),
		})
		await ready()
		// Starts on the default language, whatever the interface language is.
		expect(
			(screen.getByTestId('experience-name') as HTMLInputElement).value,
		).toBe("Chef's Counter")
		expect(screen.getAllByRole('radio').map((r) => r.textContent)).toEqual([
			'en',
			'es',
			'zh',
		])
		fireEvent.click(screen.getByRole('radio', { name: 'Spanish' }))
		const name = screen.getByTestId('experience-name') as HTMLInputElement
		expect(name.value).toBe('')
		fireEvent.change(name, { target: { value: 'Mostrador del chef' } })
		fireEvent.click(screen.getByTestId('experience-save'))
		await waitFor(() => expect(writes(calls)).toHaveLength(1))
		// The stored Arabic name is not enabled here, so it is left alone, not sent.
		expect(writes(calls)[0]!.body).toEqual({
			nameI18n: { en: "Chef's Counter", es: 'Mostrador del chef' },
			expectedVersion: 3,
		})
	})

	it('needs the default-language name when the organization writes in several languages', async () => {
		const { calls } = setup({
			languages: { locales: ['ar', 'en'], defaultLocale: 'ar' },
			current: experience({ nameI18n: { en: 'Counter' } }),
		})
		await ready()
		fireEvent.change(screen.getByTestId('experience-price'), {
			target: { value: '80' },
		})
		fireEvent.click(screen.getByTestId('experience-save'))
		expect(
			await screen.findByText('Enter a name in the default language.'),
		).toBeTruthy()
		expect(writes(calls)).toHaveLength(0)
	})
})

describe('ExperienceEditor save', () => {
	it('sends only the changed field and the version, then settles', async () => {
		const { calls } = setup({
			write: () => ({
				experience: experience({ priceMinor: 8000, version: 4 }),
			}),
		})
		await ready()
		const save = screen.getByTestId('experience-save') as HTMLButtonElement
		expect(save).toBeDisabled()
		fireEvent.change(screen.getByTestId('experience-price'), {
			target: { value: '80' },
		})
		await waitFor(() => expect(save.disabled).toBe(false))
		expect(screen.getByText(/Unsaved changes/)).toBeTruthy()
		fireEvent.click(save)
		await waitFor(() => expect(writes(calls)).toHaveLength(1))
		expect(writes(calls)[0]).toMatchObject({
			method: 'PATCH',
			path: ITEM,
			body: { priceMinor: 8000, expectedVersion: 3 },
		})
		expect(Object.keys(writes(calls)[0]!.body!).sort()).toEqual([
			'expectedVersion',
			'priceMinor',
		])
		await waitFor(() => expect(save.disabled).toBe(true))
		expect(screen.queryByText(/Unsaved changes/)).toBeNull()
	})

	it('shows field errors and sends nothing for a bad form', async () => {
		const { calls } = setup()
		await ready()
		fireEvent.change(screen.getByTestId('experience-slug'), {
			target: { value: 'Not Valid' },
		})
		fireEvent.change(screen.getByTestId('experience-price'), {
			target: { value: '7.555' },
		})
		fireEvent.click(screen.getByTestId('experience-save'))
		expect(
			await screen.findByText(/lowercase letters, numbers and dashes only/i),
		).toBeTruthy()
		expect(screen.getByText(/Enter a price like 75.00/)).toBeTruthy()
		expect(writes(calls)).toHaveLength(0)
	})

	it('names a taken link name', async () => {
		setup({
			write: () => {
				throw apiError(409, 'slug_taken')
			},
		})
		await ready()
		fireEvent.change(screen.getByTestId('experience-slug'), {
			target: { value: 'taken' },
		})
		fireEvent.click(screen.getByTestId('experience-save'))
		expect((await screen.findByTestId('experience-error')).textContent).toMatch(
			/already uses this link name/,
		)
	})

	it('keeps the draft on a version conflict and lets the person choose', async () => {
		const theirs = experience({
			priceMinor: 9000,
			exclusive: true,
			version: 7,
		})
		let first = true
		const { calls } = setup({
			write: () => {
				if (first) {
					first = false
					throw Object.assign(apiError(409, 'stale_version'), {
						body: { error: 'stale_version', version: 7, current: theirs },
					})
				}
				return {
					experience: experience({
						priceMinor: 9000,
						exclusive: true,
						version: 8,
						partyMax: 6,
					}),
				}
			},
		})
		await ready()
		fireEvent.change(screen.getByTestId('experience-party-max'), {
			target: { value: '6' },
		})
		fireEvent.click(screen.getByTestId('experience-save'))
		await screen.findByTestId('experience-conflict')
		// The draft is intact.
		expect(
			(screen.getByTestId('experience-party-max') as HTMLInputElement).value,
		).toBe('6')
		fireEvent.click(screen.getByTestId('experience-keep-mine'))
		await waitFor(() => expect(writes(calls)).toHaveLength(2))
		// Only my field goes on top of their version.
		expect(writes(calls)[1]!.body).toEqual({
			partyMax: 6,
			expectedVersion: 7,
		})
	})

	it('lets the person take the other version instead', async () => {
		const theirs = experience({ priceMinor: 9000, version: 7 })
		setup({
			write: () => {
				throw Object.assign(apiError(409, 'stale_version'), {
					body: { error: 'stale_version', version: 7, current: theirs },
				})
			},
		})
		await ready()
		fireEvent.change(screen.getByTestId('experience-party-max'), {
			target: { value: '6' },
		})
		fireEvent.click(screen.getByTestId('experience-save'))
		fireEvent.click(await screen.findByTestId('experience-use-theirs'))
		await waitFor(() =>
			expect(
				(screen.getByTestId('experience-price') as HTMLInputElement).value,
			).toBe('90.00'),
		)
		expect(
			(screen.getByTestId('experience-party-max') as HTMLInputElement).value,
		).toBe('4')
		expect(screen.queryByTestId('experience-conflict')).toBeNull()
	})
})

describe('ExperienceEditor publishing', () => {
	it('publishes a clean draft with the version', async () => {
		const { calls } = setup({
			write: () => ({
				experience: experience({ status: 'published', version: 4 }),
			}),
		})
		await ready()
		fireEvent.click(screen.getByTestId('experience-publish'))
		await waitFor(() => expect(writes(calls)).toHaveLength(1))
		expect(writes(calls)[0]).toMatchObject({
			method: 'POST',
			path: `${ITEM}/publish`,
			body: { expectedVersion: 3 },
		})
		await waitFor(() =>
			expect(screen.getByTestId('experience-status').textContent).toBe(
				'Published',
			),
		)
		expect(screen.getByTestId('experience-unpublish')).toBeTruthy()
	})

	it('will not publish over unsaved edits', async () => {
		setup()
		await ready()
		fireEvent.change(screen.getByTestId('experience-price'), {
			target: { value: '80' },
		})
		await waitFor(() =>
			expect(screen.getByTestId('experience-publish')).toBeDisabled(),
		)
	})

	it('lists what is missing when the region refuses to publish', async () => {
		setup({
			current: experience({ schedules: [] }),
			write: () => {
				throw Object.assign(apiError(400, 'invalid'), {
					body: {
						error: 'invalid',
						issues: [{ path: 'schedules', code: 'schedules_required' }],
					},
				})
			},
		})
		await ready()
		fireEvent.click(screen.getByTestId('experience-publish'))
		expect((await screen.findByTestId('experience-error')).textContent).toMatch(
			/Add at least one schedule before publishing/,
		)
		expect(screen.getByTestId('schedules-empty')).toBeTruthy()
	})

	it('archives after a confirmation and then locks the editor', async () => {
		const { calls } = setup({
			write: () => ({
				experience: experience({ status: 'archived', version: 4 }),
			}),
		})
		await ready()
		fireEvent.click(screen.getByTestId('experience-archive'))
		const dialog = await screen.findByTestId('experience-archive-dialog')
		expect(writes(calls)).toHaveLength(0)
		fireEvent.click(within(dialog).getByTestId('experience-archive-confirm'))
		await waitFor(() => expect(writes(calls)).toHaveLength(1))
		expect(writes(calls)[0]).toMatchObject({ path: `${ITEM}/archive` })
		expect(await screen.findByTestId('experience-archived')).toBeTruthy()
		expect(screen.getByTestId('experience-name')).toBeDisabled()
		expect(screen.queryByTestId('schedule-add')).toBeNull()
	})
})

describe('ExperienceEditor schedules', () => {
	it('adds a schedule with specific times and limits', async () => {
		const added = schedule({
			id: 's2',
			daysMask: 127,
			seatingMins: [1140, 1230],
			seatings: [1140, 1230],
			areaIds: ['bar'],
			coversCapPerSeating: 6,
			fromDate: '2026-10-18',
			toDate: '2026-10-18',
		})
		const { calls } = setup({
			write: () => ({
				experience: experience({ schedules: [schedule(), added], version: 4 }),
			}),
		})
		await ready()
		fireEvent.click(screen.getByTestId('schedule-add'))
		await screen.findByTestId('schedule-sheet')
		fireEvent.change(screen.getByTestId('schedule-new-time'), {
			target: { value: '19:00' },
		})
		fireEvent.click(screen.getByTestId('schedule-add-time'))
		fireEvent.change(screen.getByTestId('schedule-new-time'), {
			target: { value: '20:30' },
		})
		fireEvent.click(screen.getByTestId('schedule-add-time'))
		fireEvent.change(screen.getByTestId('schedule-cap-seating'), {
			target: { value: '6' },
		})
		fireEvent.click(screen.getByRole('checkbox', { name: 'Bar' }))
		fireEvent.click(screen.getByTestId('schedule-save'))
		await waitFor(() => expect(writes(calls)).toHaveLength(1))
		expect(writes(calls)[0]).toMatchObject({
			method: 'POST',
			path: `${ITEM}/schedules`,
			body: {
				fromDate: '2026-10-18',
				toDate: '2026-10-18',
				daysMask: 127,
				seatingMins: [1140, 1230],
				turnMin: 90,
				coversCapPerSeating: 6,
				areaIds: ['bar'],
				expectedVersion: 3,
			},
		})
		await waitFor(() =>
			expect(screen.getAllByTestId('schedule-row')).toHaveLength(2),
		)
		await waitFor(() =>
			expect(screen.queryByTestId('schedule-sheet')).toBeNull(),
		)
	})

	it('asks for a time before saving and sends nothing', async () => {
		const { calls } = setup()
		await ready()
		fireEvent.click(screen.getByTestId('schedule-add'))
		await screen.findByTestId('schedule-sheet')
		fireEvent.click(screen.getByTestId('schedule-save'))
		expect(
			await screen.findByText('Add at least one seating time.'),
		).toBeTruthy()
		expect(writes(calls)).toHaveLength(0)
	})

	it('builds an interval schedule', async () => {
		const { calls } = setup({
			write: () => ({ experience: experience({ version: 4 }) }),
		})
		await ready()
		fireEvent.click(screen.getByTestId('schedule-add'))
		await screen.findByTestId('schedule-sheet')
		await userEvent.click(
			screen.getByRole('combobox', { name: 'Seating times' }),
		)
		await userEvent.click(
			await screen.findByRole('option', { name: 'Every few minutes' }),
		)
		fireEvent.change(await screen.findByTestId('schedule-interval'), {
			target: { value: '45' },
		})
		fireEvent.click(screen.getByTestId('schedule-save'))
		await waitFor(() => expect(writes(calls)).toHaveLength(1))
		expect(writes(calls)[0]!.body).toMatchObject({
			seatingMins: null,
			startMin: 1080,
			endMin: 1260,
			intervalMin: 45,
		})
	})

	it('edits an existing schedule in place', async () => {
		const { calls } = setup({
			write: () => ({ experience: experience({ version: 4 }) }),
		})
		await ready()
		fireEvent.click(screen.getByTestId('schedule-edit'))
		await screen.findByTestId('schedule-sheet')
		expect(
			(screen.getByTestId('schedule-turn') as HTMLInputElement).value,
		).toBe('120')
		fireEvent.change(screen.getByTestId('schedule-turn'), {
			target: { value: '150' },
		})
		fireEvent.click(screen.getByTestId('schedule-save'))
		await waitFor(() => expect(writes(calls)).toHaveLength(1))
		expect(writes(calls)[0]).toMatchObject({
			method: 'PATCH',
			path: `${ITEM}/schedules/s1`,
			body: { turnMin: 150, expectedVersion: 3 },
		})
	})

	it('keeps the sheet open on a conflict and follows the region version for the retry', async () => {
		let attempt = 0
		const { calls } = setup({
			write: () => {
				attempt += 1
				if (attempt === 1) {
					throw Object.assign(apiError(409, 'stale_version'), {
						body: {
							error: 'stale_version',
							version: 9,
							current: experience({ version: 9 }),
						},
					})
				}
				return { experience: experience({ version: 10 }) }
			},
		})
		await ready()
		fireEvent.click(screen.getByTestId('schedule-edit'))
		await screen.findByTestId('schedule-sheet')
		fireEvent.change(screen.getByTestId('schedule-turn'), {
			target: { value: '150' },
		})
		fireEvent.click(screen.getByTestId('schedule-save'))
		expect((await screen.findByTestId('schedule-error')).textContent).toMatch(
			/Someone else changed this experience first/,
		)
		expect(
			(screen.getByTestId('schedule-turn') as HTMLInputElement).value,
		).toBe('150')
		fireEvent.click(screen.getByTestId('schedule-save'))
		await waitFor(() => expect(writes(calls)).toHaveLength(2))
		expect(writes(calls)[1]!.body).toMatchObject({ expectedVersion: 9 })
	})

	it('removes a schedule after a confirmation, sending the version', async () => {
		const { calls } = setup({
			write: () => ({ experience: experience({ schedules: [], version: 4 }) }),
		})
		await ready()
		fireEvent.click(screen.getByTestId('schedule-remove'))
		const dialog = await screen.findByTestId('schedule-remove-dialog')
		expect(writes(calls)).toHaveLength(0)
		fireEvent.click(within(dialog).getByTestId('schedule-remove-confirm'))
		await waitFor(() => expect(writes(calls)).toHaveLength(1))
		expect(writes(calls)[0]).toMatchObject({
			method: 'DELETE',
			path: `${ITEM}/schedules/s1`,
			query: { expectedVersion: 3 },
		})
		await screen.findByTestId('schedules-empty')
	})
})
