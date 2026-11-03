// @vitest-environment jsdom
import {
	loyaltyPromotionSchema,
	type LoyaltyProgramConfig,
	type LoyaltyPromotion,
} from '@repo/loyalty'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type LoyaltyCatalog } from '#app/utils/loyalty/catalog.ts'
import { renderStaff } from '#tests/staff-render.tsx'
import {
	promotionDefaults,
	promotionFromValues,
	PromotionDialog,
	type PromotionLocation,
} from './promotion-dialog.tsx'

const CATALOG: LoyaltyCatalog = {
	items: [
		{ id: 'item_latte', name: 'Latte', detail: null },
		{ id: 'item_mocha', name: 'Mocha', detail: null },
	],
	categories: [{ id: 'cat_drinks', name: 'Drinks', detail: null }],
}

const CONFIG: LoyaltyProgramConfig = {
	name: 'Coffee Club',
	unitLabel: 'points',
	currency: 'USD',
	timeZone: 'America/New_York',
	minimumSpendMinor: 0,
	earning: { method: 'spend', points: 1, perMinor: 100 },
	terms: '',
	labels: { items: {}, categories: {} },
	promotions: [],
	promotionStacking: 'best',
}

const LOCATIONS: PromotionLocation[] = [
	{ id: 'loc_1', name: 'Downtown' },
	{ id: 'loc_2', name: 'Airport' },
]

// Tuesday 2026-01-13, 10:00 in New York.
const NOW = Date.UTC(2026, 0, 13, 15, 0)

const originalScrollIntoView = Element.prototype.scrollIntoView

beforeEach(() => {
	vi.stubGlobal(
		'ResizeObserver',
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	)
	Element.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
	vi.unstubAllGlobals()
	Element.prototype.scrollIntoView = originalScrollIntoView
})

function setup(
	promotion: LoyaltyPromotion | null = null,
	options: {
		locations?: PromotionLocation[]
		config?: LoyaltyProgramConfig
		onSubmit?: (promotion: LoyaltyPromotion) => Promise<string | null>
	} = {},
) {
	const onSubmit = vi.fn(options.onSubmit ?? (async () => null))
	renderStaff(
		<PromotionDialog
			promotion={promotion}
			config={options.config ?? CONFIG}
			catalog={CATALOG}
			locations={options.locations ?? LOCATIONS}
			now={NOW}
			onClose={() => {}}
			onSubmit={onSubmit}
		/>,
	)
	return { onSubmit }
}

function existing(extra: Record<string, unknown> = {}): LoyaltyPromotion {
	return loyaltyPromotionSchema.parse({
		id: 'promo_existing',
		name: 'Double Tuesdays',
		kind: 'multiplier',
		value: 20_000,
		...extra,
	})
}

describe('PromotionDialog', () => {
	it('creates a whole-order 2x promotion that is always on', async () => {
		const { onSubmit } = setup()
		await userEvent.type(
			await screen.findByTestId('loyalty-promotion-name'),
			'Double points',
		)
		await userEvent.click(screen.getByTestId('loyalty-promotion-save'))

		await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
		expect(onSubmit.mock.calls[0]![0]).toEqual({
			id: expect.stringMatching(/^promo_[a-z0-9]{16}$/),
			name: 'Double points',
			enabled: true,
			kind: 'multiplier',
			value: 20_000,
			scope: { type: 'order' },
			startsAt: null,
			endsAt: null,
			recurring: null,
			locationIds: null,
			maxPointsPerPurchase: null,
			labels: { items: {}, categories: {} },
		})
	})

	it('shows a live example from the real earning rule and updates as you type', async () => {
		setup()
		const example = await screen.findByTestId('loyalty-promotion-example')
		await userEvent.type(
			screen.getByTestId('loyalty-promotion-name'),
			'Double points',
		)
		await waitFor(() =>
			expect(example).toHaveTextContent(
				/A \$20\.00 order on Jan 13, 2026.* earns 20 points; with this promotion it earns 40\./,
			),
		)
		const multiplier = screen.getByTestId('loyalty-promotion-multiplier')
		await userEvent.clear(multiplier)
		await userEvent.type(multiplier, '3')
		await waitFor(() =>
			expect(example).toHaveTextContent('with this promotion it earns 60.'),
		)
		await userEvent.clear(multiplier)
		await userEvent.type(multiplier, '1')
		await waitFor(() =>
			expect(example).toHaveTextContent(
				'Fill in the fields above to see an example.',
			),
		)
	})

	it('explains each problem in its own words and saves nothing', async () => {
		const { onSubmit } = setup(null, { locations: LOCATIONS })
		await userEvent.clear(screen.getByTestId('loyalty-promotion-multiplier'))
		await userEvent.type(
			screen.getByTestId('loyalty-promotion-multiplier'),
			'1',
		)
		await userEvent.click(screen.getByTestId('loyalty-promotion-save'))
		expect(
			await screen.findByText('Enter a name for the promotion.'),
		).toBeTruthy()
		expect(
			screen.getByText(
				'Enter how many times the points, above 1 and up to 10. For example 2 or 1.5.',
			),
		).toBeTruthy()
		expect(screen.queryByText('Required')).toBeNull()
		expect(onSubmit).not.toHaveBeenCalled()
	})

	it('reads dates in the program time zone and refuses an end before the start', async () => {
		const { onSubmit } = setup()
		expect(screen.getByTestId('loyalty-promotion-timezone')).toHaveTextContent(
			'America/New_York',
		)
		await userEvent.type(
			screen.getByTestId('loyalty-promotion-name'),
			'Launch week',
		)
		fireEvent.change(screen.getByTestId('loyalty-promotion-starts'), {
			target: { value: '2026-01-13T12:00' },
		})
		fireEvent.change(screen.getByTestId('loyalty-promotion-ends'), {
			target: { value: '2026-01-13T11:00' },
		})
		await userEvent.click(screen.getByTestId('loyalty-promotion-save'))
		expect(
			await screen.findByText('The promotion must end after it starts.'),
		).toBeTruthy()
		expect(onSubmit).not.toHaveBeenCalled()

		fireEvent.change(screen.getByTestId('loyalty-promotion-ends'), {
			target: { value: '2026-01-13T18:00' },
		})
		await userEvent.click(screen.getByTestId('loyalty-promotion-save'))
		await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
		// 12:00 and 18:00 New York (EST, UTC-5).
		expect(onSubmit.mock.calls[0]![0]).toMatchObject({
			startsAt: Date.UTC(2026, 0, 13, 17, 0),
			endsAt: Date.UTC(2026, 0, 13, 23, 0),
		})
	})

	it('saves a weekly window and needs at least one day', async () => {
		const { onSubmit } = setup()
		await userEvent.type(
			screen.getByTestId('loyalty-promotion-name'),
			'Happy hour',
		)
		await userEvent.click(screen.getByTestId('loyalty-promotion-weekly'))
		fireEvent.change(screen.getByTestId('loyalty-promotion-from'), {
			target: { value: '15:00' },
		})
		fireEvent.change(screen.getByTestId('loyalty-promotion-to'), {
			target: { value: '17:00' },
		})
		await userEvent.click(screen.getByTestId('loyalty-promotion-save'))
		expect(await screen.findByText('Choose at least one day.')).toBeTruthy()
		expect(onSubmit).not.toHaveBeenCalled()

		await userEvent.click(screen.getByTestId('loyalty-promotion-weekday-4'))
		await userEvent.click(screen.getByTestId('loyalty-promotion-weekday-2'))
		await userEvent.click(screen.getByTestId('loyalty-promotion-save'))
		await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
		expect(onSubmit.mock.calls[0]![0].recurring).toEqual({
			weekdays: [2, 4],
			fromMinute: 900,
			toMinute: 1020,
		})
	})

	it('refuses a window that ends before it starts, and reads 00:00 as the end of the day', async () => {
		const { onSubmit } = setup()
		await userEvent.type(screen.getByTestId('loyalty-promotion-name'), 'Late')
		await userEvent.click(screen.getByTestId('loyalty-promotion-weekly'))
		await userEvent.click(screen.getByTestId('loyalty-promotion-weekday-5'))
		fireEvent.change(screen.getByTestId('loyalty-promotion-from'), {
			target: { value: '18:00' },
		})
		fireEvent.change(screen.getByTestId('loyalty-promotion-to'), {
			target: { value: '17:00' },
		})
		await userEvent.click(screen.getByTestId('loyalty-promotion-save'))
		expect(
			await screen.findByText('The window must end after it starts.'),
		).toBeTruthy()

		fireEvent.change(screen.getByTestId('loyalty-promotion-to'), {
			target: { value: '00:00' },
		})
		await userEvent.click(screen.getByTestId('loyalty-promotion-save'))
		await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
		expect(onSubmit.mock.calls[0]![0].recurring).toEqual({
			weekdays: [5],
			fromMinute: 1080,
			toMinute: 1440,
		})
	})

	it('scopes a bonus to chosen items and keeps their menu names', async () => {
		const { onSubmit } = setup()
		await userEvent.type(
			screen.getByTestId('loyalty-promotion-name'),
			'Latte bonus',
		)
		await userEvent.click(
			screen.getByRole('combobox', { name: 'What it does' }),
		)
		await userEvent.click(
			await screen.findByRole('option', { name: 'Add bonus points' }),
		)
		await userEvent.type(screen.getByTestId('loyalty-promotion-bonus'), '3')
		await userEvent.click(screen.getByRole('combobox', { name: 'Applies to' }))
		await userEvent.click(
			await screen.findByRole('option', { name: 'Selected items' }),
		)

		await userEvent.click(screen.getByTestId('loyalty-promotion-save'))
		expect(await screen.findByText('Choose at least one item.')).toBeTruthy()

		await userEvent.click(screen.getByRole('button', { name: /^Items/ }))
		await userEvent.click(await screen.findByRole('option', { name: /^Latte/ }))
		await userEvent.keyboard('{Escape}')
		await userEvent.click(screen.getByTestId('loyalty-promotion-save'))
		await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
		expect(onSubmit.mock.calls[0]![0]).toMatchObject({
			kind: 'bonus',
			value: 3,
			scope: { type: 'items', itemIds: ['item_latte'] },
			labels: { items: { item_latte: 'Latte' }, categories: {} },
		})
	})

	it('limits a promotion to chosen locations and hides the choice when there is only one', async () => {
		const { onSubmit } = setup()
		await userEvent.type(
			screen.getByTestId('loyalty-promotion-name'),
			'Airport',
		)
		await userEvent.click(screen.getByRole('combobox', { name: 'Locations' }))
		await userEvent.click(
			await screen.findByRole('option', { name: 'Selected locations' }),
		)
		await userEvent.click(screen.getByTestId('loyalty-promotion-save'))
		expect(
			await screen.findByText('Choose at least one location.'),
		).toBeTruthy()

		await userEvent.click(
			within(screen.getByTestId('loyalty-promotion-locations')).getByRole(
				'checkbox',
				{ name: 'Airport' },
			),
		)
		await userEvent.click(screen.getByTestId('loyalty-promotion-save'))
		await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
		expect(onSubmit.mock.calls[0]![0].locationIds).toEqual(['loc_2'])
	})

	it('hides the location choice for an organization with one location', async () => {
		setup(null, { locations: [LOCATIONS[0]!] })
		await screen.findByTestId('loyalty-promotion-name')
		expect(screen.queryByTestId('loyalty-promotion-location-mode')).toBeNull()
	})

	it('edits a promotion in place: same id, same other settings', async () => {
		const original = existing({
			recurring: { weekdays: [2], fromMinute: 900, toMinute: 1020 },
			locationIds: ['loc_1'],
			maxPointsPerPurchase: 50,
			enabled: false,
		})
		const { onSubmit } = setup(original)
		const name = await screen.findByTestId('loyalty-promotion-name')
		expect(name).toHaveValue('Double Tuesdays')
		await userEvent.clear(name)
		await userEvent.type(name, 'Double Tuesday afternoons')
		await userEvent.click(screen.getByTestId('loyalty-promotion-save'))

		await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
		expect(onSubmit.mock.calls[0]![0]).toEqual({
			...original,
			name: 'Double Tuesday afternoons',
		})
	})

	it('shows the error the save answers with and stays open', async () => {
		const { onSubmit } = setup(null, {
			onSubmit: async () => 'Someone else saved changes first.',
		})
		await userEvent.type(screen.getByTestId('loyalty-promotion-name'), 'Boost')
		await userEvent.click(screen.getByTestId('loyalty-promotion-save'))
		expect(
			await screen.findByTestId('loyalty-promotion-error'),
		).toHaveTextContent('Someone else saved changes first.')
		expect(onSubmit).toHaveBeenCalledTimes(1)
		expect(screen.getByTestId('loyalty-promotion-dialog')).toBeVisible()
	})
})

describe('promotion form values', () => {
	it('round-trips a promotion through the form values', () => {
		const original = loyaltyPromotionSchema.parse({
			id: 'promo_1',
			name: 'Latte bonus',
			kind: 'bonus',
			value: 3,
			scope: { type: 'items', itemIds: ['item_latte'] },
			startsAt: Date.UTC(2026, 0, 13, 17, 0),
			endsAt: Date.UTC(2026, 0, 14, 5, 0),
			recurring: { weekdays: [1, 3], fromMinute: 600, toMinute: 1440 },
			locationIds: ['loc_1', 'loc_2'],
			maxPointsPerPurchase: 20,
			labels: { items: { item_latte: 'Latte' }, categories: {} },
			enabled: false,
		})
		const values = promotionDefaults(original, 'America/New_York')
		const rebuilt = loyaltyPromotionSchema.parse(
			promotionFromValues(values, {
				id: original.id,
				timeZone: 'America/New_York',
				catalog: CATALOG,
				saved: original,
			}),
		)
		expect(rebuilt).toEqual(original)
	})
})
