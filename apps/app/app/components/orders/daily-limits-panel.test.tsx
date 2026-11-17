// @vitest-environment jsdom
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OperatorRequestError } from '#app/hooks/use-operator-client.ts'
import { DailyLimitsPanel } from './daily-limits-panel.tsx'

const special = {
	key: 'item:item_1',
	kind: 'item' as const,
	id: 'item_1',
	name: 'Special',
	limit: 20,
	showRemaining: false,
	toppedUpUnits: 5,
	soldUnits: 18,
	heldUnits: 2,
	remaining: 5,
}
const dessert = {
	key: 'option:opt_1',
	kind: 'option' as const,
	id: 'opt_1',
	name: 'Dessert',
	limit: 4,
	showRemaining: true,
	toppedUpUnits: 0,
	soldUnits: 4,
	heldUnits: 0,
	remaining: 0,
}

const status = (rows = [special, dessert]) => ({
	enabled: true,
	businessDate: '2026-03-10',
	rows,
})

const LOCATIONS = [{ id: 'loc_1', name: 'Main Street' }]

let posted: Array<Record<string, FormDataEntryValue>>
let actionAnswer: () => Response

function show(
	request: (path: string) => Promise<unknown>,
	props: Partial<Parameters<typeof DailyLimitsPanel>[0]> = {},
) {
	i18n.load('en', {})
	i18n.activate('en')
	const router = createMemoryRouter(
		[
			{
				path: '/acme/orders/daily-limits-top-up',
				action: async ({ request: req }) => {
					posted.push(Object.fromEntries(await req.formData()))
					return actionAnswer()
				},
			},
			{
				path: '*',
				element: (
					<DailyLimitsPanel
						orgSlug="acme"
						locations={LOCATIONS}
						canWrite
						request={request}
						{...props}
					/>
				),
			},
		],
		{ initialEntries: ['/acme/orders'] },
	)
	return render(
		<I18nProvider i18n={i18n}>
			<RouterProvider router={router} />
		</I18nProvider>,
	)
}

beforeEach(() => {
	posted = []
	actionAnswer = () => Response.json({ ok: true, error: null })
})

describe('DailyLimitsPanel (#409)', () => {
	it('reads today for the location and lists each dish and option', async () => {
		const request = vi.fn(async () => status())
		show(request)
		expect(await screen.findByText("Today's dish limits")).toBeInTheDocument()
		expect(request).toHaveBeenCalledWith('/daily-limits?locationId=loc_1')
		const rows = screen.getAllByRole('listitem')
		expect(rows).toHaveLength(2)
		expect(within(rows[0]!).getByText('Special')).toBeInTheDocument()
		expect(
			within(rows[0]!).getByTestId('daily-limit-remaining'),
		).toHaveTextContent('5 left')
		// 20 limit + 5 added: what is sold and what waits in open carts.
		expect(rows[0]).toHaveTextContent(
			'18 sold, 2 waiting for payment, limit today 25',
		)
		expect(within(rows[1]!).getByText('Option')).toBeInTheDocument()
		expect(within(rows[1]!).getByText('Sold out')).toBeInTheDocument()
	})

	it('shows nothing while the first read is out', () => {
		show(() => new Promise(() => {}))
		expect(screen.queryByText("Today's dish limits")).toBeNull()
	})

	it('hides itself when the region says the feature is off for the location', async () => {
		const request = vi.fn(async () => {
			throw new OperatorRequestError('off', 'daily_limits_disabled', 404)
		})
		show(request)
		await waitFor(() => expect(request).toHaveBeenCalled())
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(screen.queryByText("Today's dish limits")).toBeNull()
	})

	it('hides itself when the answer says the feature is not enabled', async () => {
		const request = vi.fn(async () => ({ ...status(), enabled: false }))
		show(request)
		await waitFor(() => expect(request).toHaveBeenCalled())
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(screen.queryByText("Today's dish limits")).toBeNull()
	})

	it('says so, in words, when a location has no limited dish', async () => {
		show(async () => status([]))
		expect(
			await screen.findByText('No dish has a daily limit at this location.'),
		).toBeInTheDocument()
	})

	it('shows a plain error when the read fails or cannot be understood', async () => {
		show(async () => {
			throw new Error('boom')
		})
		expect(
			await screen.findByText("Could not load today's dish limits."),
		).toBeInTheDocument()
	})

	it('offers no change to someone who cannot write', async () => {
		show(async () => status(), { canWrite: false })
		await screen.findByText('Special')
		expect(screen.queryByRole('button', { name: /^Add \d+ to / })).toBeNull()
		expect(screen.queryByRole('button', { name: 'Set amount left' })).toBeNull()
		expect(screen.getAllByTestId('daily-limit-remaining')).toHaveLength(2)
	})

	it('adds units with +5 and +10, then reads the new figures', async () => {
		const request = vi.fn(async () => status())
		show(request)
		const user = userEvent.setup()
		await screen.findByText('Special')
		const first = screen.getAllByRole('listitem')[0]!
		await user.click(
			within(first).getByRole('button', { name: 'Add 5 to Special' }),
		)
		await waitFor(() => expect(posted).toHaveLength(1))
		expect(posted[0]).toEqual({
			locationId: 'loc_1',
			key: 'item:item_1',
			addUnits: '5',
		})
		// The read after a change is what shows the new number.
		await waitFor(() => expect(request.mock.calls.length).toBeGreaterThan(1))
		await user.click(
			within(first).getByRole('button', { name: 'Add 10 to Special' }),
		)
		await waitFor(() => expect(posted).toHaveLength(2))
		expect(posted[1]).toMatchObject({ addUnits: '10' })
	})

	it('sets the amount left, and accepts 0', async () => {
		show(async () => status())
		const user = userEvent.setup()
		await screen.findByText('Special')
		const second = screen.getAllByRole('listitem')[1]!
		const input = within(second).getByLabelText('Amount left of Dessert')
		const set = within(second).getByRole('button', { name: 'Set amount left' })
		expect(set).toBeDisabled()
		await user.type(input, '0')
		expect(set).toBeEnabled()
		await user.click(set)
		await waitFor(() => expect(posted).toHaveLength(1))
		expect(posted[0]).toEqual({
			locationId: 'loc_1',
			key: 'option:opt_1',
			amountLeft: '0',
		})
		// Cleared after sending.
		await waitFor(() => expect(input).toHaveValue(null))
	})

	it('does not send an amount that is not a whole number', async () => {
		show(async () => status())
		const user = userEvent.setup()
		await screen.findByText('Special')
		const first = screen.getAllByRole('listitem')[0]!
		const input = within(first).getByLabelText('Amount left of Special')
		for (const bad of ['2.5', '-3']) {
			await user.clear(input)
			await user.type(input, bad)
			expect(
				within(first).getByRole('button', { name: 'Set amount left' }),
			).toBeDisabled()
		}
		expect(posted).toHaveLength(0)
	})

	it('tells the manager when a change did not go through', async () => {
		actionAnswer = () =>
			Response.json({ ok: false, error: 'top_up_failed' }, { status: 500 })
		show(async () => status())
		const user = userEvent.setup()
		await screen.findByText('Special')
		await user.click(
			within(screen.getAllByRole('listitem')[0]!).getByRole('button', {
				name: 'Add 5 to Special',
			}),
		)
		expect(
			await screen.findByText('Could not change the limit. Try again.'),
		).toBeInTheDocument()
	})

	it('says when the dish lost its limit in the meantime', async () => {
		actionAnswer = () =>
			Response.json(
				{ ok: false, error: 'daily_limit_not_found' },
				{ status: 404 },
			)
		show(async () => status())
		const user = userEvent.setup()
		await screen.findByText('Special')
		await user.click(
			within(screen.getAllByRole('listitem')[0]!).getByRole('button', {
				name: 'Add 5 to Special',
			}),
		)
		expect(
			await screen.findByText('This dish no longer has a daily limit here.'),
		).toBeInTheDocument()
	})

	it('reads another location when the manager picks one', async () => {
		const request = vi.fn(async () => status())
		show(request, {
			locations: [
				{ id: 'loc_1', name: 'Main Street' },
				{ id: 'loc_2', name: 'Airport' },
			],
		})
		const user = userEvent.setup()
		await screen.findByText('Special')
		await user.selectOptions(screen.getByRole('combobox'), 'loc_2')
		await waitFor(() =>
			expect(request).toHaveBeenCalledWith('/daily-limits?locationId=loc_2'),
		)
	})

	it('has no location picker for a single location', async () => {
		show(async () => status())
		await screen.findByText('Special')
		expect(screen.queryByRole('combobox')).toBeNull()
	})
})
