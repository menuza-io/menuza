// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { createElement as h } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import catalogFixture from './fixtures/catalog.json'
import { stockRows } from './queue.ts'
import { Stock } from './Stock.tsx'
import { ORIGIN, resetStock, session, settings } from './testing.ts'
import {
	button,
	click,
	flush,
	hasButton,
	installDom,
	mount,
	region,
	text,
	type,
	type Page,
} from './ui-testing.ts'
import { usePos } from '~/lib/store.ts'

/**
 * A whole dish as waste from the Stock waste sheet (#517): the Dishes filter
 * lists the menu's dishes next to stock items, a size and extras can be
 * picked, and the entry is saved on the tablet as one dish ("2 x Chicken
 * shawarma") that Undo takes back as a whole.
 */

vi.setConfig({ testTimeout: 30_000 })

const fixture = catalogFixture as unknown as {
	settings: Record<string, unknown>
}

const SHAWARMA = {
	id: 'dish_shawarma',
	displayName: 'Chicken shawarma',
	variations: {
		groups: [
			{
				id: 'g_size',
				name: 'Size',
				values: [{ id: 'v_large', name: 'Large' }],
			},
		],
		variants: [{ id: 'var_large', valueIds: ['v_large'], price: 10 }],
	},
	modifierGroups: [
		{
			id: 'grp_extras',
			name: 'Extras',
			options: [{ id: 'opt_cheese', displayName: 'Extra cheese' }],
		},
	],
}

let page: Page

beforeEach(async () => {
	vi.spyOn(console, 'error').mockImplementation(() => {})
	installDom()
	await resetStock()
	page = mount()
	fixture.settings.dishWasteEnabled = true
	usePos.setState({
		shownItems: new Map([[SHAWARMA.id, SHAWARMA]]),
	} as never)
})
afterEach(async () => {
	await page.unmount()
	await resetStock()
	delete fixture.settings.dishWasteEnabled
	usePos.setState({ shownItems: new Map() } as never)
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
})

const dialog = () => page.host.querySelector('dialog[open]')!

async function openDishes() {
	region().install()
	await page.draw(
		h(Stock, { settings, session: session(), online: true, onSignIn: vi.fn() }),
	)
	await vi.waitFor(() => expect(text(page.host)).toContain('Weekly count'))
	await click(button(page.host, /^Waste/))
	await click(button(dialog(), 'Dishes'))
}

describe('Dishes in the waste sheet (#517)', () => {
	it('has no Dishes filter without the recipes flag', async () => {
		delete fixture.settings.dishWasteEnabled
		region().install()
		await page.draw(
			h(Stock, {
				settings,
				session: session(),
				online: true,
				onSignIn: vi.fn(),
			}),
		)
		await vi.waitFor(() => expect(text(page.host)).toContain('Weekly count'))
		await click(button(page.host, /^Waste/))
		expect(hasButton(dialog(), 'Dishes')).toBe(false)
	})

	it('saves a dish with its size, extras, quantity and reason as one entry, and Undo removes it before it leaves the tablet', async () => {
		await openDishes()
		await type(
			dialog().querySelector<HTMLInputElement>('input[type="search"]')!,
			'shaw',
		)
		await click(button(dialog(), 'Chicken shawarma'))
		const submit = () => button(dialog(), 'Log waste') as HTMLButtonElement
		// A size is needed because the dish has one.
		await click(button(dialog(), 'One more Chicken shawarma'))
		await click(button(dialog(), 'Dropped'))
		expect(submit().disabled).toBe(true)
		await click(button(dialog(), 'Large'))
		await click(button(dialog(), 'Extra cheese'))
		expect(submit().disabled).toBe(false)
		await click(submit())
		let rows: Awaited<ReturnType<typeof stockRows>> = []
		await vi.waitFor(async () => {
			rows = await stockRows(ORIGIN)
			expect(rows).toHaveLength(1)
		})
		expect(rows[0]).toMatchObject({
			kind: 'waste_dish',
			madeBy: 'stf_ana',
			payload: {
				dish: {
					menuItemId: 'dish_shawarma',
					variantId: 'var_large',
					options: [{ optionId: 'opt_cheese' }],
					quantity: 2,
					reason: 'dropped',
				},
			},
		})
		// One grouped line, however many ingredients the recipe has.
		await vi.waitFor(() =>
			expect(text(dialog())).toContain('2 × Chicken shawarma'),
		)
		await click(button(dialog(), /^Undo/))
		await flush()
		expect(await stockRows(ORIGIN)).toEqual([])
		await vi.waitFor(() => expect(text(dialog())).toContain('Undone'))
	})
})
