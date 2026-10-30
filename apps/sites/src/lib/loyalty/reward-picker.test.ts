// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, expect, it, vi } from 'vitest'
import {
	honoredSelection,
	initRewardPicker,
	orderLineName,
	selectionFor,
} from './reward-picker.ts'
import { testQuote, testReward, testRewardQuote } from './test-fixtures.ts'
import { testLoyaltyLabels } from './test-labels.ts'

const labels = testLoyaltyLabels()
const formatMoney = (minor: number) => `$${(minor / 100).toFixed(2)}`

function setup(onSelect = vi.fn()) {
	const container = document.createElement('div')
	document.body.replaceChildren(container)
	const picker = initRewardPicker(container, {
		labels,
		locale: 'en',
		formatMoney,
		onSelect,
	})
	return { container, picker, onSelect }
}

function change(input: HTMLInputElement) {
	input.checked = true
	input.dispatchEvent(new Event('change', { bubbles: true }))
}

describe('reward picker', () => {
	it('lists every quoted reward with its name, saving and cost', () => {
		const { container, picker } = setup()
		const rewards = [
			testReward(),
			testReward({ id: 'rwd_big', name: '$20 off', pointsCost: 400 }),
		]
		const quote = testQuote({
			rewards: [
				testRewardQuote(),
				testRewardQuote({
					rewardId: 'rwd_big',
					discountMinor: 2_000,
					pointsCost: 400,
					affordable: false,
				}),
			],
		})
		picker.render(quote, rewards, null)

		const radios = container.querySelectorAll<HTMLInputElement>(
			'input[type="radio"]',
		)
		expect(radios).toHaveLength(3)
		expect(radios[0]).toBeChecked()
		expect(container.textContent).toContain(labels.pickerNoReward)

		const first = container.querySelector('[data-reward-id="rwd_coffee"]')!
		expect(first.textContent).toContain('Free coffee')
		expect(first.textContent).toContain('You save $5.00')
		expect(first.textContent).toContain('100 points')
		expect(first.querySelector('input')).toBeEnabled()

		const second = container.querySelector('[data-reward-id="rwd_big"]')!
		// "$20 off" keeps its own direction on a right-to-left page.
		expect(second.querySelector('bdi')?.textContent).toBe('$20 off')
		expect(second.querySelector('input')).toBeDisabled()
		expect(second.textContent).toContain('250 points more needed')
	})

	it('keeps keyboard focus on the same choice across renders', () => {
		const { container, picker } = setup()
		const quote = testQuote()
		picker.render(quote, [testReward()], null)
		const first = container.querySelector<HTMLInputElement>(
			'input[value="rwd_coffee"]',
		)!
		first.focus()
		expect(first).toHaveFocus()
		picker.render(quote, [testReward()], null)
		const next = container.querySelector<HTMLInputElement>(
			'input[value="rwd_coffee"]',
		)!
		expect(next).not.toBe(first)
		expect(next).toHaveFocus()
	})

	it('moves focus to "No reward" when the focused reward goes away', () => {
		const { container, picker } = setup()
		const quote = testQuote()
		picker.render(quote, [testReward()], null)
		container
			.querySelector<HTMLInputElement>('input[value="rwd_coffee"]')!
			.focus()
		picker.render(testQuote({ rewards: [] }), [testReward()], null)
		const none = container.querySelector<HTMLInputElement>('input[value=""]')!
		expect(none).toHaveFocus()
	})

	it('marks rewards that do not apply to this order', () => {
		const { container, picker } = setup()
		const quote = testQuote({
			rewards: [
				testRewardQuote({
					applicable: false,
					code: 'reward_not_applicable',
					discountMinor: 0,
				}),
			],
		})
		picker.render(quote, [testReward()], null)
		const option = container.querySelector('[data-reward-id="rwd_coffee"]')!
		expect(option.querySelector('input')).toBeDisabled()
		expect(option.querySelector('[data-reward-unavailable]')!.textContent).toBe(
			labels.pickerNotApplicable,
		)
	})

	it('keeps the reason a reward cannot be used readable and tied to its radio', () => {
		const { container, picker } = setup()
		const quote = testQuote({
			rewards: [testRewardQuote({ affordable: false, pointsCost: 400 })],
		})
		picker.render(quote, [testReward({ pointsCost: 400 })], null)
		const option = container.querySelector<HTMLElement>(
			'[data-reward-id="rwd_coffee"]',
		)!
		const input = option.querySelector('input')!
		const note = option.querySelector<HTMLElement>('[data-reward-unavailable]')!
		expect(input).toBeDisabled()
		expect(note.textContent).toBe('250 points more needed')
		// The card of a disabled radio is faded; the reason sits outside it.
		expect(note.closest('label')).toBeNull()
		for (const node of [option, ...option.querySelectorAll('*')]) {
			expect(node.getAttribute('class') ?? '').not.toMatch(
				/opacity-|pointer-events-none/,
			)
		}
		expect(input).toHaveAccessibleDescription('250 points more needed')
	})
	it('skips quote rows the program no longer lists', () => {
		const { container, picker } = setup()
		picker.render(testQuote(), [], null)
		expect(container.querySelectorAll('input[type="radio"]')).toHaveLength(1)
	})

	it('names the lines a reward lands on and what is left once it is picked', () => {
		const names = ['Latte', 'Croissant', 'Latte']
		const container = document.createElement('div')
		document.body.replaceChildren(container)
		const picker = initRewardPicker(container, {
			labels,
			locale: 'en',
			formatMoney,
			onSelect: vi.fn(),
			lineName: (lineId) => orderLineName(names, lineId),
		})
		const latte = testReward({
			kind: 'items',
			itemIds: ['itm_latte'],
			labels: { items: { itm_latte: 'Latte' }, categories: {} },
		})
		const quote = testQuote({
			rewards: [
				testRewardQuote({
					lines: [
						{ lineId: '0', discountMinor: 300, rewardUnits: 0 },
						{ lineId: '1', discountMinor: 0, rewardUnits: 0 },
						{ lineId: '2', discountMinor: 200, rewardUnits: 0 },
					],
				}),
			],
			selectedRewardId: 'rwd_coffee',
			availableAfter: 50,
		})
		picker.render(quote, [latte], {
			rewardId: 'rwd_coffee',
			rewardVersion: 1,
			expectedDiscountMinor: 500,
			targetLineId: null,
		})
		const option = container.querySelector('[data-reward-id="rwd_coffee"]')!
		expect(option.querySelector('[data-reward-lines]')!.textContent).toBe(
			'Used on \u2068Latte\u2069',
		)
		expect(option.querySelector('[data-reward-after]')!.textContent).toBe(
			'50 points left after this reward',
		)
	})

	it('names no lines for a whole-order reward or when a line is unknown', () => {
		const container = document.createElement('div')
		document.body.replaceChildren(container)
		const picker = initRewardPicker(container, {
			labels,
			locale: 'en',
			formatMoney,
			onSelect: vi.fn(),
			lineName: (lineId) => orderLineName(['Latte'], lineId),
		})
		const lines = [
			{ lineId: '0', discountMinor: 300, rewardUnits: 0 },
			{ lineId: '7', discountMinor: 200, rewardUnits: 0 },
		]
		picker.render(
			testQuote({
				rewards: [
					testRewardQuote({ lines }),
					testRewardQuote({ rewardId: 'rwd_items', lines }),
				],
			}),
			[
				testReward(),
				testReward({ id: 'rwd_items', kind: 'items', itemIds: ['itm_latte'] }),
			],
			null,
		)
		expect(container.querySelector('[data-reward-lines]')).toBeNull()
	})

	it('shows what is left only for the pick the quote priced', () => {
		const { container, picker } = setup()
		picker.render(testQuote({ availableAfter: 50 }), [testReward()], {
			rewardId: 'rwd_coffee',
			rewardVersion: 1,
			expectedDiscountMinor: 500,
			targetLineId: null,
		})
		expect(container.querySelector('[data-reward-after]')).toBeNull()
	})
	it('reports the pick with the quoted version, discount and target', () => {
		const onSelect = vi.fn()
		const { container, picker } = setup(onSelect)
		const quote = testQuote({
			rewards: [testRewardQuote({ targetLineId: 'line_1' })],
		})
		picker.render(quote, [testReward()], null)
		change(
			container.querySelector<HTMLInputElement>('input[value="rwd_coffee"]')!,
		)
		expect(onSelect).toHaveBeenCalledWith({
			rewardId: 'rwd_coffee',
			rewardVersion: 1,
			expectedDiscountMinor: 500,
			targetLineId: 'line_1',
		})
	})

	it('reports clearing the pick with "No reward"', () => {
		const onSelect = vi.fn()
		const { container, picker } = setup(onSelect)
		const quote = testQuote()
		picker.render(quote, [testReward()], {
			rewardId: 'rwd_coffee',
			rewardVersion: 1,
			expectedDiscountMinor: 500,
			targetLineId: null,
		})
		expect(
			container.querySelector<HTMLInputElement>('input[value="rwd_coffee"]'),
		).toBeChecked()
		change(container.querySelector<HTMLInputElement>('input[value=""]')!)
		expect(onSelect).toHaveBeenCalledWith(null)
	})

	it('ignores changes from other radio groups on the page', () => {
		const onSelect = vi.fn()
		const { container, picker } = setup(onSelect)
		picker.render(testQuote(), [testReward()], null)
		const foreign = document.createElement('input')
		foreign.type = 'radio'
		foreign.name = 'tipPercent'
		container.append(foreign)
		change(foreign)
		expect(onSelect).not.toHaveBeenCalled()
	})
})

describe('orderLineName', () => {
	it('reads a checkout line id as the position on the order', () => {
		const names = ['Latte', 'Bagel']
		expect(orderLineName(names, '1')).toBe('Bagel')
		expect(orderLineName(names, '2')).toBeNull()
		expect(orderLineName(names, '')).toBeNull()
		expect(orderLineName(names, '1.0')).toBeNull()
		expect(orderLineName(names, 'tab-1:0')).toBeNull()
	})
})

describe('selectionFor', () => {	it('builds the pick from the quote row only', () => {
		const quote = testQuote()
		expect(selectionFor(quote, 'rwd_coffee')).toEqual({
			rewardId: 'rwd_coffee',
			rewardVersion: 1,
			expectedDiscountMinor: 500,
			targetLineId: null,
		})
		expect(selectionFor(quote, 'rwd_unknown')).toBeNull()
		expect(
			selectionFor(
				testQuote({ rewards: [testRewardQuote({ affordable: false })] }),
				'rwd_coffee',
			),
		).toBeNull()
	})
})

describe('honoredSelection', () => {
	const selection = {
		rewardId: 'rwd_coffee',
		rewardVersion: 1,
		expectedDiscountMinor: 500,
		targetLineId: null,
	}

	it('sends the pick with the discount the quote showed', () => {
		const quote = testQuote({
			selectedRewardId: 'rwd_coffee',
			totals: { ...testQuote().totals, discountMinor: 450 },
		})
		expect(honoredSelection(quote, selection)).toEqual({
			...selection,
			expectedDiscountMinor: 450,
		})
	})

	it('drops what the quote did not honor', () => {
		expect(honoredSelection(null, selection)).toBeNull()
		expect(honoredSelection(testQuote(), selection)).toBeNull()
		expect(honoredSelection(testQuote(), null)).toBeNull()
	})
})
