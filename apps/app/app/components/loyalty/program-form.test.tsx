// @vitest-environment jsdom
import {
	type LoyaltyOperatorProgram,
	type LoyaltyProgramConfig,
} from '@repo/loyalty'
import { screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type LoyaltyCatalog } from '#app/utils/loyalty/catalog.ts'
import { renderStaff } from '#tests/staff-render.tsx'
import { ProgramForm } from './program-form.tsx'

const CATALOG: LoyaltyCatalog = {
	items: [
		{ id: 'item_latte', name: 'Latte', detail: null },
		{ id: 'item_mocha', name: 'Mocha', detail: null },
	],
	categories: [{ id: 'cat_drinks', name: 'Drinks', detail: null }],
}

function programWith(config: Partial<LoyaltyProgramConfig>) {
	return {
		id: 'prog_1',
		status: 'active',
		version: 3,
		currencyLocked: true,
		current: {
			id: 'ver_3',
			version: 3,
			status: 'active',
			effectiveAt: 1_700_000_000_000,
			config: {
				name: 'Coffee Club',
				unitLabel: 'points',
				currency: 'USD',
				timeZone: 'America/New_York',
				minimumSpendMinor: 0,
				earning: { method: 'spend', points: 1, perMinor: 100 },
				terms: 'Points have no cash value.',
				labels: { items: {}, categories: {} },
				...config,
			},
			createdAt: 1_700_000_000_000,
			createdBy: null,
		},
		history: [],
	} satisfies LoyaltyOperatorProgram
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
})

afterEach(() => {
	vi.unstubAllGlobals()
	Element.prototype.scrollIntoView = originalScrollIntoView
})

function setup(program: LoyaltyOperatorProgram | null) {
	const onSave = vi.fn()
	renderStaff(
		<ProgramForm
			program={program}
			catalog={CATALOG}
			defaultTimeZone="America/New_York"
			canManage
			saving={false}
			onSave={onSave}
		/>,
	)
	return { onSave }
}

describe('ProgramForm', () => {
	it('creates a spend program with the optional fields left empty', async () => {
		const { onSave } = setup(null)
		await userEvent.type(screen.getByTestId('loyalty-program-name'), 'Club')
		await userEvent.type(screen.getByTestId('loyalty-program-currency'), 'usd')
		await userEvent.type(
			screen.getByTestId('loyalty-program-terms'),
			'Points have no cash value.',
		)
		await userEvent.click(screen.getByTestId('loyalty-program-save'))

		await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
		expect(onSave).toHaveBeenCalledWith(
			{
				name: 'Club',
				unitLabel: 'points',
				currency: 'USD',
				timeZone: 'America/New_York',
				minimumSpendMinor: 0,
				earning: { method: 'spend', points: 1, perMinor: 100 },
				terms: 'Points have no cash value.',
				labels: { items: {}, categories: {} },
			},
			null,
		)
	})

	it('explains an empty required field in its own words', async () => {
		const { onSave } = setup(null)
		await userEvent.click(screen.getByTestId('loyalty-program-save'))
		expect(await screen.findByText('Enter a program name.')).toBeTruthy()
		expect(screen.queryByText('Required')).toBeNull()
		expect(onSave).not.toHaveBeenCalled()
	})

	it('saves a locked currency without asking for it again', async () => {
		const { onSave } = setup(programWith({}))
		expect(screen.getByTestId('loyalty-program-currency')).toBeDisabled()
		await userEvent.click(screen.getByTestId('loyalty-program-save'))
		await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
		expect(onSave.mock.calls[0]![0]).toMatchObject({ currency: 'USD' })
		expect(onSave.mock.calls[0]![1]).toBe(3)
	})

	it('earns on chosen items and saves their menu names', async () => {
		const { onSave } = setup(
			programWith({
				earning: { method: 'items', points: 5, itemIds: ['item_latte'] },
				labels: { items: { item_latte: 'Old latte' }, categories: {} },
			}),
		)
		await userEvent.click(
			screen.getByRole('button', { name: /^Items that earn/ }),
		)
		await userEvent.click(await screen.findByRole('option', { name: /^Mocha/ }))
		await userEvent.keyboard('{Escape}')
		await userEvent.click(screen.getByTestId('loyalty-program-save'))

		await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
		const config = onSave.mock.calls[0]![0] as LoyaltyProgramConfig
		expect(config.earning).toEqual({
			method: 'items',
			points: 5,
			itemIds: ['item_latte', 'item_mocha'],
		})
		expect(config.labels).toEqual({
			items: { item_latte: 'Latte', item_mocha: 'Mocha' },
			categories: {},
		})
	})

	it('drops the menu name of an item that is no longer chosen', async () => {
		const { onSave } = setup(
			programWith({
				earning: {
					method: 'items',
					points: 5,
					itemIds: ['item_latte', 'item_mocha'],
				},
				labels: {
					items: { item_latte: 'Latte', item_mocha: 'Mocha' },
					categories: {},
				},
			}),
		)
		await userEvent.click(
			within(screen.getByTestId('loyalty-program-earn-items-chosen')).getByRole(
				'button',
				{ name: 'Remove Mocha' },
			),
		)
		await userEvent.click(screen.getByTestId('loyalty-program-save'))

		await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
		const config = onSave.mock.calls[0]![0] as LoyaltyProgramConfig
		expect(config.earning).toMatchObject({ itemIds: ['item_latte'] })
		expect(config.labels).toEqual({
			items: { item_latte: 'Latte' },
			categories: {},
		})
	})

	it('asks for at least one item when the last one is removed', async () => {
		const { onSave } = setup(
			programWith({
				earning: { method: 'items', points: 5, itemIds: ['item_latte'] },
			}),
		)
		await userEvent.click(
			within(screen.getByTestId('loyalty-program-earn-items-chosen')).getByRole(
				'button',
				{ name: 'Remove Latte' },
			),
		)
		await userEvent.click(screen.getByTestId('loyalty-program-save'))
		expect(await screen.findByText('Choose at least one item.')).toBeTruthy()
		expect(onSave).not.toHaveBeenCalled()
	})

	it('refuses a spend step of zero, with a decimal comma or past what the region accepts', async () => {
		const { onSave } = setup(programWith({}))
		const per = screen.getByTestId('loyalty-program-earn-per')
		for (const typed of ['0', '12,50']) {
			await userEvent.clear(per)
			await userEvent.type(per, typed)
			await userEvent.click(screen.getByTestId('loyalty-program-save'))
			expect(
				await screen.findByText(
					'Enter the spend that earns the points, like 10.00.',
				),
			).toBeTruthy()
		}
		await userEvent.clear(per)
		await userEvent.type(per, '2,000,000')
		await userEvent.click(screen.getByTestId('loyalty-program-save'))
		expect(
			await screen.findByText(
				'The spend that earns the points can be at most 1,000,000.00.',
			),
		).toBeTruthy()
		expect(onSave).not.toHaveBeenCalled()
	})

	it('reads Arabic-Indic digits and grouped thousands', async () => {
		const { onSave } = setup(programWith({}))
		const points = screen.getByTestId('loyalty-program-earn-points')
		await userEvent.clear(points)
		await userEvent.type(points, '٥')
		const per = screen.getByTestId('loyalty-program-earn-per')
		await userEvent.clear(per)
		await userEvent.type(per, '١٬٢٥٠٫٥٠')
		await userEvent.click(screen.getByTestId('loyalty-program-save'))

		await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
		expect(onSave.mock.calls[0]![0]).toMatchObject({
			earning: { method: 'spend', points: 5, perMinor: 125050 },
		})
	})

	it('opens a program saved with more points than its spend allows, and says how to fix it', async () => {
		const { onSave } = setup(
			programWith({ earning: { method: 'spend', points: 500, perMinor: 100 } }),
		)
		expect(screen.getByTestId('loyalty-program-earn-points')).toHaveValue('500')
		await userEvent.click(screen.getByTestId('loyalty-program-save'))
		expect(
			await screen.findByText('Use at most 100 points for this spend.'),
		).toBeTruthy()
		expect(onSave).not.toHaveBeenCalled()

		const points = screen.getByTestId('loyalty-program-earn-points')
		await userEvent.clear(points)
		await userEvent.type(points, '100')
		await userEvent.click(screen.getByTestId('loyalty-program-save'))
		await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
		expect(onSave.mock.calls[0]![0]).toMatchObject({
			earning: { method: 'spend', points: 100, perMinor: 100 },
		})
	})

	it('says so when the region would refuse what the fields allow', async () => {
		const { onSave } = setup(
			programWith({
				earning: { method: 'items', points: 5, itemIds: ['not a catalog id'] },
			}),
		)
		await userEvent.click(screen.getByTestId('loyalty-program-save'))
		expect(
			await screen.findByText('Check the fields and try again.'),
		).toBeTruthy()
		expect(onSave).not.toHaveBeenCalled()
	})
})
