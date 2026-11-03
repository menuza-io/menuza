// @vitest-environment jsdom
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import {
	loyaltyPromotionSchema,
	type LoyaltyOperatorProgram,
	type LoyaltyProgramConfig,
	type LoyaltyPromotion,
} from '@repo/loyalty'
import { render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { createRoutesStub } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LoyaltyClientContext } from '#app/components/loyalty/loyalty-client-provider.tsx'
import {
	LoyaltyApiError,
	type LoyaltyClient,
	type LoyaltyClientPool,
} from '#app/utils/loyalty/loyalty-client.ts'
import LoyaltyPromotionsRoute from './promotions.tsx'

// Tuesday 2026-01-13, 15:30 in New York (EST).
const NOW = Date.UTC(2026, 0, 13, 20, 30)

function promotion(extra: Record<string, unknown>): LoyaltyPromotion {
	return loyaltyPromotionSchema.parse({
		kind: 'multiplier',
		value: 20_000,
		...extra,
	})
}

const HAPPY_HOUR = promotion({
	id: 'promo_happy',
	name: 'Happy hour',
	recurring: { weekdays: [2], fromMinute: 900, toMinute: 1020 },
})
const LATTE = promotion({
	id: 'promo_latte',
	name: 'Latte bonus',
	kind: 'bonus',
	value: 3,
	scope: { type: 'items', itemIds: ['item_latte'] },
	labels: { items: { item_latte: 'Latte' }, categories: {} },
	locationIds: ['loc_2'],
})
const PAUSED = promotion({
	id: 'promo_paused',
	name: 'Paused one',
	enabled: false,
})
const OVER = promotion({
	id: 'promo_over',
	name: 'Launch week',
	startsAt: NOW - 10 * 86_400_000,
	endsAt: NOW - 3 * 86_400_000,
})
const LATER = promotion({
	id: 'promo_later',
	name: 'Summer boost',
	startsAt: NOW + 30 * 86_400_000,
})

const CONFIG: LoyaltyProgramConfig = {
	name: 'Coffee Club',
	unitLabel: 'points',
	currency: 'USD',
	timeZone: 'America/New_York',
	minimumSpendMinor: 500,
	earning: { method: 'spend', points: 1, perMinor: 100 },
	terms: 'Points have no cash value.',
	labels: { items: {}, categories: {} },
	promotions: [],
	promotionStacking: 'best',
}

function programWith(
	config: Partial<LoyaltyProgramConfig>,
	options: { version?: number; status?: LoyaltyOperatorProgram['status'] } = {},
): LoyaltyOperatorProgram {
	const version = options.version ?? 3
	const status = options.status ?? 'active'
	return {
		id: 'prog_1',
		status,
		version,
		currencyLocked: true,
		current: {
			id: `ver_${version}`,
			version,
			status,
			effectiveAt: 1_700_000_000_000,
			config: { ...CONFIG, ...config },
			createdAt: 1_700_000_000_000,
			createdBy: null,
		},
		history: [],
	}
}

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
	vi.spyOn(Date, 'now').mockReturnValue(NOW)
})

afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
	Element.prototype.scrollIntoView = originalScrollIntoView
})

type FakeClient = {
	getProgram: ReturnType<typeof vi.fn>
	saveProgram: ReturnType<typeof vi.fn>
}

/** A client whose saves answer with the program as saved, one version later. */
function clientFor(program: LoyaltyOperatorProgram | null): FakeClient {
	let current = program
	return {
		getProgram: vi.fn(async () => current),
		saveProgram: vi.fn(
			async (body: {
				expectedVersion: number
				config: LoyaltyProgramConfig
			}) => {
				current = programWith(body.config, {
					version: body.expectedVersion + 1,
				})
				return current
			},
		),
	}
}

function renderPromotions(
	client: FakeClient,
	loader: {
		canManage?: boolean
		locations?: Array<{ id: string; name: string }>
	} = {},
) {
	i18n.load('en', {})
	i18n.activate('en')
	const pool = {
		orgSlug: 'acme',
		forScope: vi.fn(),
		invalidateAll: vi.fn(),
	} as unknown as LoyaltyClientPool
	const Stub = createRoutesStub([
		{
			path: '/acme/loyalty/promotions',
			Component: () => (
				<LoyaltyClientContext.Provider
					value={{ pool, client: client as unknown as LoyaltyClient }}
				>
					<LoyaltyPromotionsRoute />
				</LoyaltyClientContext.Provider>
			),
			HydrateFallback: () => null,
			loader: () => ({
				orgSlug: 'acme',
				canManage: loader.canManage ?? true,
				catalog: {
					items: [{ id: 'item_latte', name: 'Latte', detail: null }],
					categories: [],
				},
				locations: loader.locations ?? [
					{ id: 'loc_1', name: 'Downtown' },
					{ id: 'loc_2', name: 'Airport' },
				],
			}),
		},
	])
	return render(
		<I18nProvider i18n={i18n}>
			<Stub initialEntries={['/acme/loyalty/promotions']} />
		</I18nProvider>,
	)
}

describe('Loyalty promotions page', () => {
	it('sends the operator to the program when there is none', async () => {
		renderPromotions(clientFor(null))
		const empty = await screen.findByTestId('loyalty-promotions-no-program')
		expect(
			within(empty).getByText('Go to the program').closest('a'),
		).toHaveAttribute('href', '/acme/loyalty/program')
	})

	it('shows an empty state when the program has no promotions', async () => {
		renderPromotions(clientFor(programWith({})))
		expect(await screen.findByTestId('loyalty-promotions-empty')).toBeVisible()
		expect(screen.getByTestId('loyalty-promotion-create')).toBeEnabled()
	})

	it('lists each promotion with what it does, when, where and its status at this moment', async () => {
		renderPromotions(
			clientFor(
				programWith({
					promotions: [HAPPY_HOUR, LATTE, PAUSED, OVER, LATER],
					promotionStacking: 'best',
				}),
			),
		)
		const happy = await screen.findByTestId('loyalty-promotion-row-promo_happy')
		expect(
			within(happy).getByText('2x points on the whole order'),
		).toBeVisible()
		expect(within(happy).getByText(/Tue, 3:00\s?PM to 5:00\s?PM/)).toBeVisible()
		expect(within(happy).getByText('All locations')).toBeVisible()
		expect(
			screen.getByTestId('loyalty-promotion-status-promo_happy'),
		).toHaveTextContent('Live now')

		const latte = screen.getByTestId('loyalty-promotion-row-promo_latte')
		expect(
			within(latte).getByText('3 bonus points for each Latte'),
		).toBeVisible()
		expect(within(latte).getByText('Airport')).toBeVisible()
		expect(
			screen.getByTestId('loyalty-promotion-status-promo_latte'),
		).toHaveTextContent('Live now')
		expect(
			screen.getByTestId('loyalty-promotion-status-promo_paused'),
		).toHaveTextContent('Paused')
		expect(
			screen.getByTestId('loyalty-promotion-status-promo_over'),
		).toHaveTextContent('Ended')
		expect(
			screen.getByTestId('loyalty-promotion-status-promo_later'),
		).toHaveTextContent('Scheduled')
	})

	it('warns that a draft or paused program gives no bonus yet', async () => {
		renderPromotions(
			clientFor(programWith({ promotions: [HAPPY_HOUR] }, { status: 'draft' })),
		)
		expect(
			await screen.findByTestId('loyalty-promotions-inactive'),
		).toHaveTextContent('still a draft')
	})

	it('turns a promotion off by saving the program with every other setting carried over', async () => {
		const client = clientFor(
			programWith({
				promotions: [HAPPY_HOUR, LATTE],
				promotionStacking: 'add',
			}),
		)
		renderPromotions(client)
		await userEvent.click(
			await screen.findByTestId('loyalty-promotion-toggle-promo_happy'),
		)
		await waitFor(() => expect(client.saveProgram).toHaveBeenCalledTimes(1))
		const [body] = client.saveProgram.mock.calls[0]!
		expect(body.expectedVersion).toBe(3)
		expect(body.config).toEqual({
			...CONFIG,
			promotions: [{ ...HAPPY_HOUR, enabled: false }, LATTE],
			promotionStacking: 'add',
		})
		expect(
			await screen.findByTestId('loyalty-promotion-status-promo_happy'),
		).toHaveTextContent('Paused')
	})

	it('deletes a promotion only after the operator confirms', async () => {
		const client = clientFor(programWith({ promotions: [HAPPY_HOUR, LATTE] }))
		renderPromotions(client)
		await userEvent.click(
			await screen.findByTestId('loyalty-promotion-delete-promo_latte'),
		)
		const dialog = await screen.findByTestId('loyalty-promotion-delete-dialog')
		expect(dialog).toHaveTextContent('Latte bonus')
		await userEvent.click(
			within(dialog).getByRole('button', { name: 'Keep it' }),
		)
		expect(client.saveProgram).not.toHaveBeenCalled()

		await userEvent.click(
			screen.getByTestId('loyalty-promotion-delete-promo_latte'),
		)
		await userEvent.click(
			await screen.findByTestId('loyalty-promotion-delete-confirm'),
		)
		await waitFor(() => expect(client.saveProgram).toHaveBeenCalledTimes(1))
		expect(client.saveProgram.mock.calls[0]![0].config.promotions).toEqual([
			HAPPY_HOUR,
		])
		await waitFor(() =>
			expect(
				screen.queryByTestId('loyalty-promotion-row-promo_latte'),
			).toBeNull(),
		)
	})

	it('creates a promotion from the dialog and saves it with the program', async () => {
		const client = clientFor(programWith({ promotions: [HAPPY_HOUR] }))
		renderPromotions(client)
		await userEvent.click(await screen.findByTestId('loyalty-promotion-create'))
		await userEvent.type(
			await screen.findByTestId('loyalty-promotion-name'),
			'Double points',
		)
		await userEvent.click(screen.getByTestId('loyalty-promotion-save'))

		await waitFor(() => expect(client.saveProgram).toHaveBeenCalledTimes(1))
		const [body] = client.saveProgram.mock.calls[0]!
		expect(body.expectedVersion).toBe(3)
		expect(body.config.promotions).toHaveLength(2)
		expect(body.config.promotions[0]).toEqual(HAPPY_HOUR)
		expect(body.config.promotions[1]).toMatchObject({
			name: 'Double points',
			kind: 'multiplier',
			value: 20_000,
		})
		// The dialog closes once the save lands, and the list shows the new row.
		await waitFor(() =>
			expect(screen.queryByTestId('loyalty-promotion-dialog')).toBeNull(),
		)
		expect(await screen.findByText('Double points')).toBeVisible()
	})

	it('edits a promotion in place', async () => {
		const client = clientFor(programWith({ promotions: [HAPPY_HOUR, LATTE] }))
		renderPromotions(client)
		await userEvent.click(
			await screen.findByTestId('loyalty-promotion-edit-promo_happy'),
		)
		const name = await screen.findByTestId('loyalty-promotion-name')
		await userEvent.clear(name)
		await userEvent.type(name, 'Happy hour (Tuesdays)')
		await userEvent.click(screen.getByTestId('loyalty-promotion-save'))
		await waitFor(() => expect(client.saveProgram).toHaveBeenCalledTimes(1))
		expect(client.saveProgram.mock.calls[0]![0].config.promotions).toEqual([
			{ ...HAPPY_HOUR, name: 'Happy hour (Tuesdays)' },
			LATTE,
		])
	})

	it('changes how several promotions stack', async () => {
		const client = clientFor(programWith({ promotions: [HAPPY_HOUR, LATTE] }))
		renderPromotions(client)
		await userEvent.click(
			await screen.findByRole('combobox', {
				name: 'When several promotions match a purchase',
			}),
		)
		await userEvent.click(
			await screen.findByRole('option', { name: 'Add the bonuses up' }),
		)
		await waitFor(() => expect(client.saveProgram).toHaveBeenCalledTimes(1))
		expect(client.saveProgram.mock.calls[0]![0].config).toMatchObject({
			promotions: [HAPPY_HOUR, LATTE],
			promotionStacking: 'add',
		})
	})

	it('asks to reload when someone else saved the program first', async () => {
		const client = clientFor(programWith({ promotions: [HAPPY_HOUR] }))
		client.saveProgram.mockRejectedValueOnce(
			new LoyaltyApiError('Conflict', 409, 'stale_version'),
		)
		renderPromotions(client)
		await userEvent.click(
			await screen.findByTestId('loyalty-promotion-toggle-promo_happy'),
		)
		const alert = await screen.findByTestId('loyalty-promotions-error')
		expect(alert).toHaveTextContent('Someone else saved changes first.')
		await userEvent.click(within(alert).getByRole('button', { name: 'Reload' }))
		await waitFor(() => expect(client.getProgram).toHaveBeenCalledTimes(2))
		await waitFor(() =>
			expect(screen.queryByTestId('loyalty-promotions-error')).toBeNull(),
		)
	})

	it('keeps the dialog open with the error when the save fails', async () => {
		const client = clientFor(programWith({ promotions: [] }))
		client.saveProgram.mockRejectedValueOnce(
			new LoyaltyApiError('Conflict', 409, 'stale_version'),
		)
		renderPromotions(client)
		await userEvent.click(await screen.findByTestId('loyalty-promotion-create'))
		await userEvent.type(
			await screen.findByTestId('loyalty-promotion-name'),
			'Boost',
		)
		await userEvent.click(screen.getByTestId('loyalty-promotion-save'))
		expect(
			await screen.findByTestId('loyalty-promotion-error'),
		).toHaveTextContent('Someone else saved changes first.')
		expect(screen.getByTestId('loyalty-promotion-dialog')).toBeVisible()
	})

	it('lets someone without edit access look but not touch', async () => {
		renderPromotions(
			clientFor(programWith({ promotions: [HAPPY_HOUR, LATTE] })),
			{ canManage: false },
		)
		expect(
			await screen.findByTestId('loyalty-promotions-readonly'),
		).toBeVisible()
		expect(screen.queryByTestId('loyalty-promotion-create')).toBeNull()
		expect(
			screen.queryByTestId('loyalty-promotion-toggle-promo_happy'),
		).toBeNull()
		expect(
			screen.queryByTestId('loyalty-promotion-edit-promo_happy'),
		).toBeNull()
		expect(
			screen.queryByTestId('loyalty-promotion-delete-promo_happy'),
		).toBeNull()
		expect(screen.queryByRole('combobox')).toBeNull()
		expect(screen.getByText(/only the\s+biggest bonus is given/)).toBeVisible()
	})

	it('offers a retry when the program cannot be loaded', async () => {
		const client = clientFor(programWith({}))
		client.getProgram.mockRejectedValueOnce(new Error('boom'))
		renderPromotions(client)
		const error = await screen.findByTestId('loyalty-promotions-load-error')
		await userEvent.click(
			within(error).getByRole('button', { name: 'Try again' }),
		)
		expect(await screen.findByTestId('loyalty-promotions-empty')).toBeVisible()
	})
})
