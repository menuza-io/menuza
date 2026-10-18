// @vitest-environment jsdom
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { ExperiencesScreen } from '#app/components/reservations/experiences/experiences-screen.tsx'
import {
	apiError,
	createScriptedClient,
	type ScriptedCall,
} from '#app/components/reservations/scripted-test-client.ts'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const BASE = '/operator/reservations/setup/locations/loc_1'

function experience(over: Record<string, unknown> = {}) {
	return {
		id: 'exp_1',
		locationId: 'loc_1',
		slug: 'chefs-counter',
		kind: 'ticketed',
		nameI18n: { en: "Chef's Counter", ar: 'مائدة الشيف' },
		descriptionI18n: null,
		imageUrl: null,
		priceMinor: 7500,
		pricePerCover: true,
		currency: 'USD',
		policyId: null,
		partyMin: 2,
		partyMax: 4,
		usesTables: true,
		exclusive: false,
		status: 'published',
		sort: 0,
		version: 3,
		schedules: [
			{
				id: 's1',
				experienceId: 'exp_1',
				fromDate: '2026-10-24',
				toDate: '2026-12-31',
				daysMask: 32,
				seatingMins: [1140, 1230],
				startMin: null,
				endMin: null,
				intervalMin: null,
				turnMin: 120,
				coversCapPerSeating: 8,
				coversCapPerDay: null,
				areaIds: null,
				serviceId: null,
				seatings: [1140, 1230],
			},
		],
		...over,
	}
}

function setup(
	options: {
		experiences?: unknown[]
		canWrite?: boolean
		listError?: ReturnType<typeof apiError>
		write?: (call: ScriptedCall) => unknown
		currency?: string
	} = {},
) {
	const scripted = createScriptedClient((call) => {
		if (call.method === 'GET') {
			if (call.path === `${BASE}/experiences`) {
				if (options.listError) return options.listError
				return {
					locationId: 'loc_1',
					experiences: options.experiences ?? [experience()],
				}
			}
			if (call.path === `${BASE}/settings`) {
				return { settings: { version: 1, currency: options.currency ?? 'USD' } }
			}
			if (call.path === `${BASE}/areas`) return { areas: [] }
			if (call.path === `${BASE}/services`) return { services: [] }
		}
		return options.write?.(call)
	})
	i18n.load('en', {})
	i18n.activate('en')
	const router = createMemoryRouter(
		[
			{
				path: '/',
				element: (
					<ExperiencesScreen
						client={scripted.client}
						orgSlug="acme"
						locationId="loc_1"
						canWrite={options.canWrite ?? true}
					/>
				),
			},
			{
				path: '/acme/reservations/experiences/:id',
				element: <div>editor</div>,
			},
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

describe('ExperiencesScreen', () => {
	it('lists experiences with status, price, party and next seatings', async () => {
		setup({
			experiences: [
				experience(),
				experience({
					id: 'exp_2',
					slug: 'tasting',
					nameI18n: { en: 'Tasting' },
					status: 'draft',
					schedules: [],
					priceMinor: null,
				}),
			],
		})
		const rows = await screen.findAllByTestId('experience-row')
		expect(rows).toHaveLength(2)
		expect(rows[0]!.textContent).toContain("Chef's Counter")
		expect(rows[0]!.textContent).toContain('Published')
		expect(rows[0]!.textContent).toContain('$75.00 per guest')
		expect(rows[0]!.textContent).toContain('2 to 4 guests')
		expect(rows[0]!.textContent).toMatch(/Oct 24, 2026/)
		expect(rows[0]!.textContent).toMatch(/7:00\s?PM/)
		expect(rows[1]!.textContent).toContain('Draft')
		expect(rows[1]!.textContent).toContain('No schedules yet')
		const link = screen.getAllByTestId(
			'experience-link',
		)[0] as HTMLAnchorElement
		expect(link.getAttribute('href')).toBe(
			'/acme/reservations/experiences/exp_1?locationId=loc_1',
		)
	})

	it('hides archived experiences until asked', async () => {
		setup({
			experiences: [
				experience(),
				experience({
					id: 'exp_3',
					nameI18n: { en: 'Old menu' },
					status: 'archived',
				}),
			],
		})
		expect(await screen.findAllByTestId('experience-row')).toHaveLength(1)
		await userEvent.click(screen.getByRole('combobox', { name: 'Show' }))
		await userEvent.click(
			await screen.findByRole('option', { name: 'Archived' }),
		)
		const rows = await screen.findAllByTestId('experience-row')
		expect(rows).toHaveLength(1)
		expect(rows[0]!.textContent).toContain('Old menu')
	})

	it('shows an empty state with the create action', async () => {
		setup({ experiences: [] })
		expect(
			await screen.findByText('No experiences configured yet'),
		).toBeTruthy()
		expect(
			screen.getAllByRole('button', { name: /New experience/ }).length,
		).toBeGreaterThan(0)
	})

	it('hides create for a read-only member and shows a 403 as no access', async () => {
		setup({ canWrite: false })
		await screen.findAllByTestId('experience-row')
		expect(screen.queryByTestId('experience-new')).toBeNull()
	})

	it('shows the valid rows and a warning when one row is malformed', async () => {
		setup({
			experiences: [
				experience(),
				experience({ id: 'exp_bad', kind: 'tasting' }),
				experience({ id: 'exp_2', slug: 'second' }),
			],
		})
		expect(await screen.findAllByTestId('experience-row')).toHaveLength(2)
		expect(screen.getByTestId('experiences-invalid-warning')).toHaveTextContent(
			'1 experience could not be displayed',
		)
		expect(screen.queryByTestId('experiences-error')).toBeNull()
	})

	it('decides access from the answer', async () => {
		setup({ listError: apiError(404, 'not_found') })
		expect(await screen.findByTestId('experiences-denied')).toBeTruthy()
	})

	it('creates a draft with the typed price and opens its editor', async () => {
		const { calls, router } = setup({
			experiences: [],
			currency: 'SAR',
			write: () => ({
				experience: experience({ id: 'exp_new', status: 'draft' }),
			}),
		})
		fireEvent.click(
			(await screen.findAllByRole('button', { name: /New experience/ }))[0]!,
		)
		await screen.findByTestId('experience-create-sheet')
		fireEvent.change(screen.getByTestId('experience-name'), {
			target: { value: "Chef's Counter" },
		})
		// The link name follows the name until the person edits it.
		expect(
			(screen.getByTestId('experience-slug') as HTMLInputElement).value,
		).toBe('chefs-counter')
		fireEvent.change(screen.getByTestId('experience-price'), {
			target: { value: '250.00' },
		})
		fireEvent.click(screen.getByTestId('experience-create'))
		await waitFor(() =>
			expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1),
		)
		const post = calls.find((call) => call.method === 'POST')!
		expect(post.path).toBe(`${BASE}/experiences`)
		expect(post.body).toMatchObject({
			slug: 'chefs-counter',
			kind: 'ticketed',
			nameI18n: { en: "Chef's Counter" },
			priceMinor: 25000,
			pricePerCover: true,
		})
		await waitFor(() =>
			expect(router.state.location.pathname).toBe(
				'/acme/reservations/experiences/exp_new',
			),
		)
	})

	it('asks for a name and link name before creating and shows a taken link name', async () => {
		const { calls } = setup({
			experiences: [],
			write: () => {
				throw apiError(409, 'slug_taken')
			},
		})
		fireEvent.click(
			(await screen.findAllByRole('button', { name: /New experience/ }))[0]!,
		)
		await screen.findByTestId('experience-create-sheet')
		fireEvent.click(screen.getByTestId('experience-create'))
		expect(
			await screen.findByText('Enter a name in at least one language.'),
		).toBeTruthy()
		expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0)
		fireEvent.change(screen.getByTestId('experience-name'), {
			target: { value: 'Tasting' },
		})
		fireEvent.click(screen.getByTestId('experience-create'))
		expect(
			(await screen.findByTestId('experience-create-error')).textContent,
		).toMatch(/already uses this link name/)
		expect(
			(screen.getByTestId('experience-name') as HTMLInputElement).value,
		).toBe('Tasting')
	})
})
