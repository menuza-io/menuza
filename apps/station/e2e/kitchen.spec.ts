import fs from 'node:fs'
import path from 'node:path'
import { type Page } from '@playwright/test'
import {
	backend,
	cart,
	expect,
	expectStored,
	fillCart,
	goOffline,
	goOnline,
	pairUi,
	selectStationApp,
	test,
} from './helpers.ts'

const kitchen = (page: Page) =>
	page.getByRole('main', { name: 'Kitchen display' })
const ticket = (page: Page, number: string) =>
	kitchen(page).getByRole('article', { name: `Ticket ${number}`, exact: true })

async function expectViewGutters(page: Page) {
	const tabs = await page
		.getByRole('main')
		.getByRole('radiogroup')
		.evaluate((group) =>
			Array.from(group.querySelectorAll('[role="radio"]')).map((tab) => {
				const bounds = tab.getBoundingClientRect()
				const range = document.createRange()
				range.selectNodeContents(tab.lastElementChild!)
				const text = range.getBoundingClientRect()
				const style = getComputedStyle(tab)
				return {
					leftGutter: text.left - bounds.left,
					rightGutter: bounds.right - text.right,
					paddingLeft: parseFloat(style.paddingLeft),
					paddingRight: parseFloat(style.paddingRight),
					height: bounds.height,
					fits: bounds.left >= 0 && bounds.right <= window.innerWidth,
				}
			}),
		)
	expect(tabs).toHaveLength(3)
	for (const tab of tabs) {
		expect(tab.leftGutter).toBeGreaterThanOrEqual(tab.paddingLeft - 1)
		expect(tab.rightGutter).toBeGreaterThanOrEqual(tab.paddingRight - 1)
		expect(tab.height).toBeGreaterThanOrEqual(44)
		expect(tab.fits).toBe(true)
	}
}

async function openKitchen(page: Page) {
	await selectStationApp(page, 'Kitchen')
	await expect(kitchen(page)).toBeVisible()
}
async function capture(page: Page, name: string) {
	if (!process.env.CAPTURE_DIR) return
	fs.mkdirSync(process.env.CAPTURE_DIR, { recursive: true })
	await page.emulateMedia({ reducedMotion: 'reduce' })
	await page.screenshot({
		path: path.join(process.env.CAPTURE_DIR, `${name}.png`),
		fullPage: true,
	})
}

test('Station and online tickets share a kitchen, with readiness, completion and recall', async ({
	unpaired: page,
}) => {
	await pairUi(page, { locationId: 'loc-1' })
	await fillCart(page)
	await cart(page).getByRole('button', { name: 'Pay later' }).click()
	const [order] = await expectStored(1)
	await backend.post('/__test/kitchen-orders')
	await openKitchen(page)
	await expect(ticket(page, order!.number)).toBeVisible()
	await expect(ticket(page, 'WEB-0042')).toContainText(
		'No salt · allergy: sesame',
	)
	await expect(kitchen(page)).not.toContainText('+15555550123')
	await capture(page, 'kitchen-desktop')
	const station = ticket(page, order!.number)
	await station
		.getByRole('button', { name: 'Start preparing', exact: true })
		.click()
	await expect(
		station.getByRole('button', { name: 'Mark ready', exact: true }),
	).toBeEnabled()
	await station.getByRole('button', { name: 'Mark ready', exact: true }).click()
	await station
		.getByRole('button', { name: 'Done · clear ticket', exact: true })
		.click()
	await expect(station).toHaveCount(0)
	await kitchen(page).getByRole('radio', { name: 'Done', exact: true }).click()
	await ticket(page, order!.number)
		.getByRole('button', { name: 'Recall ticket' })
		.click()
	await kitchen(page).getByRole('radio', { name: 'Live', exact: true }).click()
	await expect(ticket(page, order!.number)).toBeVisible()
	expect((await backend.orders())[0]!.status).toBe('open')
})

test('kitchen setup routes items and offers an item-level quick-service workflow', async ({
	unpaired: page,
}) => {
	await pairUi(page, { locationId: 'loc-1' })
	await backend.post('/__test/kitchen-orders')
	await openKitchen(page)
	await kitchen(page)
		.getByRole('button', { name: 'Kitchen setup', exact: true })
		.click()
	const setup = page.getByRole('dialog', { name: 'Kitchen setup' })
	await setup.getByRole('radio', { name: 'Individual items' }).click()
	await setup.getByLabel('Use a Preparing step before Ready').uncheck()
	await setup.getByRole('button', { name: 'Add station' }).click()
	await setup.getByLabel('Station name').last().fill('Fry station')
	await setup
		.getByRole('combobox', { name: 'Station for Truffle Fries' })
		.selectOption({ label: 'Fry station' })
	await capture(page, 'kitchen-setup')
	await setup.getByRole('button', { name: 'Save kitchen setup' }).click()
	await expect(setup).toHaveCount(0)
	await kitchen(page)
		.getByRole('combobox', { name: 'Prep station', exact: true })
		.selectOption({ label: 'Fry station' })
	await expect(ticket(page, 'WEB-0042')).toBeVisible()
	await ticket(page, 'WEB-0042')
		.getByRole('button', { name: 'Item ready', exact: true })
		.click()
	await expect(
		ticket(page, 'WEB-0042').getByText('Ready for the pass'),
	).toBeVisible()
	await kitchen(page)
		.getByRole('combobox', { name: 'Prep station', exact: true })
		.selectOption('')
	await ticket(page, 'WEB-0042')
		.getByRole('button', { name: 'Done · clear ticket' })
		.click()
	await expect(
		kitchen(page).getByRole('heading', { name: 'The kitchen is clear' }),
	).toBeVisible()
})

test('scheduled food stays out of Live and disconnected screens cannot mark food ready', async ({
	unpaired: page,
	context,
}) => {
	await pairUi(page, { locationId: 'loc-1' })
	await backend.post('/__test/kitchen-orders', { scheduled: true })
	await backend.post('/__test/kitchen-orders')
	await openKitchen(page)
	await expect(ticket(page, 'WEB-0042')).toBeVisible()
	await expect(ticket(page, 'WEB-LATER')).toHaveCount(0)
	await kitchen(page)
		.getByRole('radio', { name: 'Scheduled', exact: true })
		.click()
	await expect(ticket(page, 'WEB-LATER')).toBeVisible()
	await expectViewGutters(page)
	await capture(page, 'kitchen-scheduled')
	await expect(
		ticket(page, 'WEB-LATER').getByRole('button', { name: 'Start preparing' }),
	).toBeDisabled()
	await kitchen(page).getByRole('radio', { name: 'Live', exact: true }).click()
	await goOffline(context, page)
	await expect(kitchen(page).getByText('Updates paused')).toBeVisible()
	await expect(
		ticket(page, 'WEB-0042').getByRole('button', { name: 'Start preparing' }),
	).toBeDisabled()
	await goOnline(context, page)
	await expect(
		ticket(page, 'WEB-0042').getByRole('button', { name: 'Start preparing' }),
	).toBeEnabled()
})

test('kitchen stays usable on a narrow screen, Arabic and reduced motion', async ({
	unpaired: page,
}) => {
	await pairUi(page, { locationId: 'loc-1' })
	await backend.post('/__test/kitchen-orders')
	await openKitchen(page)
	await page.setViewportSize({ width: 390, height: 844 })
	await expect(ticket(page, 'WEB-0042')).toBeVisible()
	await expectViewGutters(page)
	await capture(page, 'kitchen-mobile')
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= window.innerWidth,
		),
	).toBe(true)
	await page.evaluate(() => {
		const settings = JSON.parse(localStorage.getItem('pos.settings.v1')!)
		localStorage.setItem(
			'pos.settings.v1',
			JSON.stringify({ ...settings, locale: 'ar' }),
		)
	})
	await page.reload()
	await expect(page.locator('html')).toHaveAttribute('dir', 'rtl')
	await expect(page.locator('[data-kitchen-ticket]')).toBeVisible()
	await page.setViewportSize({ width: 320, height: 844 })
	await expectViewGutters(page)
	const targets = await page.getByRole('radio').evaluateAll((nodes) =>
		nodes.map((node) => {
			const { width, height } = node.getBoundingClientRect()
			return { width, height }
		}),
	)
	expect(targets).toHaveLength(3)
	expect(
		targets.every(({ width, height }) => width >= 44 && height >= 44),
	).toBe(true)
	await capture(page, 'kitchen-arabic')
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= window.innerWidth,
		),
	).toBe(true)
})

test('Scheduled keeps its padding in dark mode at tablet and phone widths, including RTL', async ({
	unpaired: page,
}) => {
	await backend.theme({
		css: ':root{--background:oklch(.16 0 0);--foreground:oklch(.96 0 0);--card:oklch(.19 0 0);--card-foreground:oklch(.96 0 0);--popover:oklch(.22 0 0);--popover-foreground:oklch(.96 0 0);--accent:oklch(.28 0 0);--border:oklch(.32 0 0);--muted:oklch(.24 0 0);--muted-foreground:oklch(.76 0 0)}',
		mode: 'dark',
	})
	await pairUi(page, { locationId: 'loc-1' })
	await backend.post('/__test/kitchen-orders', { scheduled: true })
	await openKitchen(page)
	await kitchen(page)
		.getByRole('radio', { name: 'Scheduled', exact: true })
		.click()
	await expect(ticket(page, 'WEB-LATER')).toBeVisible()
	for (const width of [1180, 768, 390, 320]) {
		await page.setViewportSize({ width, height: 844 })
		await expectViewGutters(page)
		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= window.innerWidth,
			),
		).toBe(true)
		if (width === 1180 || width === 320)
			await capture(page, `kitchen-scheduled-dark-${width}`)
	}
	await page.setViewportSize({ width: 390, height: 844 })
	await page.evaluate(() => {
		const key = 'pos.settings.v1'
		const settings = JSON.parse(localStorage.getItem(key)!)
		localStorage.setItem(key, JSON.stringify({ ...settings, locale: 'ar' }))
	})
	await page.reload()
	await expect(page.locator('html')).toHaveAttribute('dir', 'rtl')
	await expect(page.locator('[data-kitchen-ticket]')).toBeVisible()
	await expectViewGutters(page)
	await capture(page, 'kitchen-scheduled-dark-arabic')
})
