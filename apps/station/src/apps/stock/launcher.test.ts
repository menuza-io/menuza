// @vitest-environment jsdom
import { createElement as h } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	installDom,
	mount,
	button,
	click,
	hasButton,
	type Page,
} from './ui-testing.ts'
import { AppLauncher } from '~/screens/AppLauncher.tsx'

let page: Page
beforeEach(() => {
	installDom()
	page = mount()
})
afterEach(async () => {
	await page.unmount()
	vi.unstubAllGlobals()
})

const draw = (apps: {
	timeclock: boolean
	reservations: boolean
	inventory: boolean
	orders: boolean
}) =>
	page.draw(
		h(AppLauncher, {
			name: 'Menuza',
			logoUrl: null,
			locationName: 'Main',
			app: 'pos',
			apps,
			onApp: onApp,
		}),
	)
const onApp = vi.fn()

describe('Stock in the launcher', () => {
	it('is offered only when the terminal has it switched on', async () => {
		await draw({
			timeclock: false,
			reservations: false,
			inventory: false,
			orders: false,
		})
		await click(button(page.host, 'Apps'))
		expect(hasButton(page.host, 'Register')).toBe(true)
		expect(hasButton(page.host, 'Kitchen')).toBe(true)
		expect(hasButton(page.host, 'Stock')).toBe(false)
	})

	it('shows it beside the others when on, and picking it says so', async () => {
		onApp.mockClear()
		await draw({
			timeclock: true,
			reservations: true,
			inventory: true,
			orders: false,
		})
		await click(button(page.host, 'Apps'))
		const names = [...page.host.querySelectorAll('nav button')].map((entry) =>
			entry.textContent?.trim(),
		)
		expect(names).toEqual([
			'Register',
			'Kitchen',
			'Time clock',
			'Reservations',
			'Stock',
		])
		await click(button(page.host.querySelector('nav')!, 'Stock'))
		expect(onApp).toHaveBeenCalledWith('stock')
	})
})
