// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { type InventoryClient } from '#app/components/inventory/inventory-client-provider.tsx'
import { OperatorRequestError } from '#app/hooks/use-operator-client.ts'
import { renderInventory, sentJson } from '#tests/inventory-render.tsx'
import { CountReviewScreen } from './count-review-screen.tsx'

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

beforeEach(() => {
	toast.success.mockReset()
	toast.error.mockReset()
})

const COUNT = {
	id: 'cnt_1',
	locationId: 'main',
	listId: null,
	listName: 'Weekly count',
	status: 'in_review',
	businessDate: '2026-11-08',
	startedBy: { kind: 'operator', id: 'u1' },
	itemTotal: 50,
	itemsCounted: 45,
	counters: [],
	sentForReviewAt: 10,
	approvedAt: null,
	approvedBy: null,
	cancelledAt: null,
	createdAt: 1,
	version: 4,
}

function line(
	itemId: string,
	name: string,
	flag: 'not_counted' | 'big_difference',
	overrides: Record<string, unknown> = {},
) {
	return {
		itemId,
		name,
		baseUnit: 'g',
		countUnit: 'kg',
		units: [],
		counted: flag === 'not_counted' ? null : 46_000_000,
		expected: 49_000_000,
		difference: flag === 'not_counted' ? null : -3_000_000,
		flag,
		...overrides,
	}
}

function review(withMoney: boolean, status = 'in_review') {
	return {
		count: { ...COUNT, status },
		lines: [
			line('i1', 'Chicken thighs', 'big_difference', {
				...(withMoney ? { differenceValueMinor: -8_400, currency: 'SAR' } : {}),
			}),
			line('i2', 'Pita bread', 'not_counted'),
			line('i3', 'Tomatoes', 'not_counted'),
			line('i4', 'Garlic sauce', 'big_difference', {
				counted: 5_000_000,
				expected: 2_000_000,
				difference: 3_000_000,
			}),
		],
		matching: 41,
		notCounted: 2,
		...(withMoney ? { differenceValueMinor: -8_400, currency: 'SAR' } : {}),
	}
}

const APPROVED = {
	count: {
		...COUNT,
		status: 'approved',
		approvedAt: 20,
		itemsCounted: 45,
		version: 5,
	},
	adjustedItems: 3,
	differenceValueMinor: -8_400,
	currency: 'SAR',
	foodCost: {
		state: 'ok',
		from: '2026-11-01',
		to: '2026-11-08',
		targetBp: 3000,
		bp: 3120,
	},
}

function region(
	options: {
		withMoney?: boolean
		status?: string
		approve?: () => unknown
		extra?: Record<string, unknown>
	} = {},
) {
	return vi.fn<InventoryClient['request']>(async (path) => {
		if (path === '/counts/cnt_1/review') {
			return {
				...review(options.withMoney ?? true, options.status),
				...options.extra,
			}
		}
		if (
			path === '/counts/cnt_1/second/settle' ||
			path === '/counts/cnt_1/second/skip'
		) {
			return { ...COUNT, secondState: 'done', status: 'in_review', version: 6 }
		}
		if (path === '/counts/cnt_1/approve') {
			return options.approve?.() ?? APPROVED
		}
		if (path === '/counts/cnt_1/reopen') {
			return { ...COUNT, status: 'counting', version: 5 }
		}
		if (path === '/counts/cnt_1/cancel') {
			return { ...COUNT, status: 'cancelled', version: 5 }
		}
		throw new Error(`unexpected request ${path}`)
	})
}

function setup(
	request: InventoryClient['request'],
	props: { canEdit?: boolean; canSeeCost?: boolean } = {},
) {
	renderInventory(
		<CountReviewScreen
			orgSlug="acme"
			countId="cnt_1"
			canEdit={props.canEdit ?? true}
			canSeeCost={props.canSeeCost ?? true}
			search=""
		/>,
		{ request },
	)
}

const calls = (request: ReturnType<typeof region>, path: string) =>
	request.mock.calls
		.map(([p], index) => ({ p, index }))
		.filter((call) => call.p === path)

describe('CountReviewScreen', () => {
	it('lists only what needs a look and sums up the rest', async () => {
		setup(region())
		await screen.findByTestId('count-review')
		expect(screen.getByTestId('review-summary')).toHaveTextContent(
			'4 items need a look.',
		)
		expect(screen.getByTestId('review-uncounted-i2')).toHaveTextContent(
			'Pita bread',
		)
		expect(screen.getByTestId('review-uncounted-i2')).toHaveTextContent(
			'Expected 49 kg',
		)
		expect(screen.getByTestId('review-differences')).toHaveTextContent(
			'Chicken thighs',
		)
		expect(screen.getByTestId('review-matching')).toHaveTextContent(
			'41 items match and need no review.',
		)
	})

	it('shows expected, counted, how much is missing and what it is worth', async () => {
		setup(region())
		await screen.findByTestId('count-review')
		const figures = screen.getByTestId('review-detail-figures')
		expect(figures).toHaveTextContent('Expected 49 kg')
		expect(figures).toHaveTextContent('Counted 46 kg')
		expect(figures).toHaveTextContent('3 kg missing')
		expect(figures.textContent).toMatch(/84/)
	})

	it('selecting another difference shows its figures and its own note', async () => {
		setup(region())
		await screen.findByTestId('count-review')
		await userEvent.click(screen.getByTestId('review-diff-i4'))
		const figures = screen.getByTestId('review-detail-figures')
		expect(figures).toHaveTextContent('Expected 2 kg')
		expect(figures).toHaveTextContent('Counted 5 kg')
		expect(figures).toHaveTextContent('3 kg more than expected')
		expect(screen.getByTestId('review-note')).toHaveValue('')
	})

	it('approves with the choices and notes, and sums up what happened', async () => {
		const request = region()
		setup(request)
		await screen.findByTestId('count-review')
		// "Same as before" is chosen by default; change one to "None left".
		expect(screen.getByTestId('review-keep-i2')).toHaveAttribute(
			'aria-pressed',
			'true',
		)
		await userEvent.click(screen.getByTestId('review-zero-i3'))
		await userEvent.type(screen.getByTestId('review-note'), 'Spilled a box')

		await userEvent.click(screen.getByTestId('review-approve'))
		await userEvent.click(await screen.findByTestId('review-approve-confirm'))

		await waitFor(() =>
			expect(calls(request, '/counts/cnt_1/approve')).toHaveLength(1),
		)
		expect(
			sentJson(request, calls(request, '/counts/cnt_1/approve')[0]!.index),
		).toEqual({
			expectedVersion: 4,
			uncounted: { i2: 'keep', i3: 'zero' },
			notes: { i1: 'Spilled a box' },
		})

		const done = await screen.findByTestId('review-complete')
		expect(
			within(done).getByTestId('review-complete-counted'),
		).toHaveTextContent('45 of 50')
		expect(
			within(done).getByTestId('review-complete-difference'),
		).toHaveTextContent('missing')
		expect(within(done).getByTestId('review-complete-food')).toHaveTextContent(
			'31.2%',
		)
		expect(within(done).getByTestId('review-complete-food')).toHaveTextContent(
			'above your target of 30%',
		)
	})

	it('explains food cost when two counts are not there yet', async () => {
		const request = region({
			approve: () => ({
				...APPROVED,
				foodCost: {
					state: 'need_two_counts',
					from: null,
					to: null,
					targetBp: 3000,
				},
			}),
		})
		setup(request)
		await screen.findByTestId('count-review')
		await userEvent.click(screen.getByTestId('review-approve'))
		await userEvent.click(await screen.findByTestId('review-approve-confirm'))
		expect(await screen.findByTestId('review-complete-food')).toHaveTextContent(
			'needs two approved counts',
		)
	})

	it('hides Approve without the cost grant and says a manager approves', async () => {
		setup(region({ withMoney: false }), { canSeeCost: false })
		await screen.findByTestId('count-review')
		expect(screen.queryByTestId('review-approve')).toBeNull()
		expect(screen.getByTestId('review-needs-manager')).toBeInTheDocument()
		// No money anywhere, no choices to make either.
		expect(screen.getByTestId('review-detail-figures').textContent).not.toMatch(
			/SAR|84/,
		)
		expect(screen.queryByTestId('review-keep-i2')).toBeNull()
		expect(screen.queryByTestId('review-note')).toBeNull()
		// Still able to send it back for more counting.
		expect(screen.getByTestId('review-reopen')).toBeInTheDocument()
	})

	it('hides Approve without the update grant even with the cost grant', async () => {
		setup(region(), { canEdit: false, canSeeCost: true })
		await screen.findByTestId('count-review')
		expect(screen.queryByTestId('review-approve')).toBeNull()
		expect(screen.queryByTestId('review-reopen')).toBeNull()
	})

	it('reopens a count to keep counting, with the version it saw', async () => {
		const request = region()
		setup(request)
		await screen.findByTestId('count-review')
		await userEvent.click(screen.getByTestId('review-reopen'))
		await waitFor(() =>
			expect(calls(request, '/counts/cnt_1/reopen')).toHaveLength(1),
		)
		expect(
			sentJson(request, calls(request, '/counts/cnt_1/reopen')[0]!.index),
		).toEqual({ expectedVersion: 4 })
	})

	it('cancels only after a confirmation', async () => {
		const request = region()
		setup(request)
		await screen.findByTestId('count-review')
		await userEvent.click(screen.getByTestId('review-cancel'))
		expect(calls(request, '/counts/cnt_1/cancel')).toHaveLength(0)
		await userEvent.click(await screen.findByTestId('review-cancel-confirm'))
		await waitFor(() =>
			expect(calls(request, '/counts/cnt_1/cancel')).toHaveLength(1),
		)
		await waitFor(() =>
			expect(toast.success).toHaveBeenCalledWith(
				'Count cancelled. Nothing was changed.',
			),
		)
	})

	it('keeps the page and says so when someone else changed the count first', async () => {
		const request = vi.fn<InventoryClient['request']>(async (path) => {
			if (path === '/counts/cnt_1/review') return review(true)
			throw new OperatorRequestError('stale', 'stale_version', 409)
		})
		setup(request)
		await screen.findByTestId('count-review')
		await userEvent.click(screen.getByTestId('review-approve'))
		await userEvent.click(await screen.findByTestId('review-approve-confirm'))
		expect(await screen.findByTestId('review-save-error')).toHaveTextContent(
			'Someone else changed this first',
		)
		expect(screen.queryByTestId('review-complete')).toBeNull()
	})

	it('a count still being counted shows figures but cannot be approved', async () => {
		setup(region({ status: 'counting' }))
		await screen.findByTestId('count-review')
		expect(screen.getByTestId('review-still-counting')).toBeInTheDocument()
		expect(screen.queryByTestId('review-approve')).toBeNull()
	})

	it('says a closed count is closed instead of failing', async () => {
		setup(
			vi.fn<InventoryClient['request']>(async () => {
				throw new OperatorRequestError('closed', 'count_closed', 409)
			}),
		)
		expect(await screen.findByTestId('review-error')).toHaveTextContent(
			'already closed',
		)
	})

	it('says nothing needs a look when every line matches', async () => {
		setup(
			vi.fn<InventoryClient['request']>(async () => ({
				count: COUNT,
				lines: [],
				matching: 50,
				notCounted: 0,
			})),
		)
		await screen.findByTestId('count-review')
		expect(screen.getByTestId('review-summary')).toHaveTextContent(
			'Nothing needs a look.',
		)
		expect(screen.getByTestId('review-matching')).toHaveTextContent(
			'50 items match and need no review.',
		)
	})

	it('warns about devices still counting and approves anyway only after the manager confirms (#474)', async () => {
		const request = region({
			extra: {
				devices: [
					{
						deviceId: 'tablet-1',
						name: 'Kitchen iPad',
						kind: 'station',
						person: { kind: 'staff', id: 's1' },
						joinedAt: 1,
						lastSyncAt: Date.now(),
						unsentCount: 3,
						state: 'counting',
					},
					{
						deviceId: 'tablet-2',
						name: 'Bar tablet',
						kind: 'station',
						person: { kind: 'staff', id: 's2' },
						joinedAt: 1,
						lastSyncAt: 1,
						unsentCount: null,
						state: 'not_responding',
					},
					{
						deviceId: 'tablet-3',
						name: 'Done tablet',
						kind: 'station',
						person: { kind: 'staff', id: 's3' },
						joinedAt: 1,
						lastSyncAt: 1,
						unsentCount: 0,
						state: 'done',
					},
				],
			},
		})
		setup(request)
		const panel = await screen.findByTestId('review-devices')
		expect(panel).toHaveTextContent('2 devices are still counting')
		expect(
			within(panel).getByTestId('review-device-tablet-1'),
		).toHaveTextContent('Kitchen iPad')
		expect(within(panel).getByTestId('review-device-unsent')).toHaveTextContent(
			'3 entries not sent yet',
		)
		expect(
			within(panel).getByTestId('review-device-tablet-2'),
		).toHaveTextContent('Not responding')
		expect(screen.queryByTestId('review-device-tablet-3')).toBeNull()

		await userEvent.click(screen.getByTestId('review-approve'))
		await userEvent.click(await screen.findByTestId('review-approve-anyway'))
		await userEvent.click(await screen.findByTestId('review-approve-confirm'))
		await waitFor(() =>
			expect(calls(request, '/counts/cnt_1/approve')).toHaveLength(1),
		)
		expect(
			sentJson(request, calls(request, '/counts/cnt_1/approve')[0]!.index),
		).toMatchObject({ expectedVersion: 4, approveAnyway: true })
	})

	it('approves without the warning when every device said it is done', async () => {
		const request = region({
			extra: {
				devices: [
					{
						deviceId: 'tablet-3',
						name: 'Done tablet',
						kind: 'station',
						person: { kind: 'staff', id: 's3' },
						joinedAt: 1,
						lastSyncAt: 1,
						unsentCount: 0,
						state: 'done',
					},
				],
			},
		})
		setup(request)
		await screen.findByTestId('count-review')
		expect(screen.queryByTestId('review-devices')).toBeNull()
		await userEvent.click(screen.getByTestId('review-approve'))
		await userEvent.click(await screen.findByTestId('review-approve-confirm'))
		await waitFor(() =>
			expect(calls(request, '/counts/cnt_1/approve')).toHaveLength(1),
		)
		expect(
			sentJson(request, calls(request, '/counts/cnt_1/approve')[0]!.index),
		).not.toHaveProperty('approveAnyway')
	})

	it('shows the key items money gap since the last count (#490)', async () => {
		setup(region({ extra: { keyDifferenceValueMinor: -2_500 } }))
		expect(await screen.findByTestId('review-key-gap')).toHaveTextContent(
			'Key items',
		)
		expect(screen.getByTestId('review-key-gap')).toHaveTextContent('less')
	})

	it('settles the differences between the two key-item counts side by side before review (#525)', async () => {
		const request = region({
			status: 'counting',
			extra: {
				second: {
					state: 'settling',
					keyItemCount: 1,
					secondCounters: [{ kind: 'operator', id: 'u2' }],
					lines: [
						{
							itemId: 'k1',
							name: 'Saffron',
							baseUnit: 'g',
							firstQuantity: 8_000,
							secondQuantity: 7_000,
							matches: false,
							resolution: null,
						},
					],
					skipReason: null,
				},
			},
		})
		setup(request)
		const panel = await screen.findByTestId('second-check')
		expect(within(panel).getByTestId('second-line-k1')).toHaveTextContent(
			'Saffron',
		)
		const settle = within(panel).getByTestId('second-settle')
		expect(settle).toBeDisabled()
		await userEvent.click(within(panel).getByTestId('second-pick-second-k1'))
		expect(settle).toBeEnabled()
		await userEvent.click(settle)
		await waitFor(() =>
			expect(calls(request, '/counts/cnt_1/second/settle')).toHaveLength(1),
		)
		expect(
			sentJson(
				request,
				calls(request, '/counts/cnt_1/second/settle')[0]!.index,
			),
		).toEqual({ expectedVersion: 4, resolutions: { k1: 'second' } })
	})

	it('lets only a manager skip the second count, with a reason (#525)', async () => {
		const extra = {
			second: {
				state: 'waiting',
				keyItemCount: 2,
				secondCounters: [],
				lines: [],
				skipReason: null,
			},
		}
		setup(region({ status: 'counting', extra }), { canSeeCost: true })
		await screen.findByTestId('second-waiting')
		expect(screen.queryByTestId('second-skip-open')).toBeNull()
		cleanup()

		const request = region({ status: 'counting', extra })
		renderInventory(
			<CountReviewScreen
				orgSlug="acme"
				countId="cnt_1"
				canEdit
				canSeeCost
				canManageSettings
				search=""
			/>,
			{ request },
		)
		await userEvent.click(await screen.findByTestId('second-skip-open'))
		const confirm = screen.getByTestId('second-skip-confirm')
		expect(confirm).toBeDisabled()
		await userEvent.type(
			screen.getByTestId('second-skip-reason'),
			'Nobody else is in',
		)
		await userEvent.click(confirm)
		await waitFor(() =>
			expect(calls(request, '/counts/cnt_1/second/skip')).toHaveLength(1),
		)
		expect(
			sentJson(request, calls(request, '/counts/cnt_1/second/skip')[0]!.index),
		).toEqual({ expectedVersion: 4, reason: 'Nobody else is in' })
	})
})
