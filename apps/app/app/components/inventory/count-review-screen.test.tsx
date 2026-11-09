// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react'
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
	} = {},
) {
	return vi.fn<InventoryClient['request']>(async (path) => {
		if (path === '/counts/cnt_1/review') {
			return review(options.withMoney ?? true, options.status)
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
})
