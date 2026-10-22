import { type Page } from '@playwright/test'
import {
	ANA,
	addQuick,
	backend,
	confirmButton,
	dialog,
	expect,
	expectStored,
	menuItem,
	openCategory,
	lockScreen,
	openOrders,
	openPairingLink,
	pairLocked,
	signInWithPin,
	test,
} from './helpers.ts'

const bar = (page: Page) =>
	page.getByRole('button', { name: /Order is empty|View order|^Tab #/ })

// Pixel 7 project: 412 × 915, touch, mobile user agent.
test.describe('on a phone', () => {
	test('order bar at the bottom, no side panel, no sideways scroll', async ({
		demo: page,
	}) => {
		await expect(
			page.getByRole('region', { name: 'Current order' }),
		).toHaveCount(0)
		await expect(bar(page)).toContainText('Order is empty')
		expect(
			await page.evaluate(
				() =>
					document.documentElement.scrollWidth <=
					document.documentElement.clientWidth,
			),
		).toBe(true)
		const box = await bar(page).boundingBox()
		const viewport = page.viewportSize()!
		expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height)
		expect(box!.x).toBeGreaterThanOrEqual(0)
		expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width)
	})

	test('a whole sale with taps only: add, review, charge, take cash, new order', async ({
		demo: page,
	}) => {
		await openCategory(page, 'Starters')
		await menuItem(page, 'Truffle Fries').tap()
		await expect(bar(page)).toContainText('View order')
		await expect(bar(page)).toContainText('$8.12')
		await bar(page).tap()
		const order = dialog(page)
		await expect(
			order.getByRole('heading', { name: 'Current order' }),
		).toBeVisible()
		await expect(order.getByText('Truffle Fries')).toBeVisible()
		await order.getByRole('button', { name: /^Charge/ }).tap()
		const pay = dialog(page).last()
		await expect(pay.getByRole('heading', { name: 'Charge' })).toBeVisible()
		await confirmButton(pay).tap()
		await expect(
			dialog(page).getByRole('heading', { name: 'Paid' }),
		).toBeVisible()
		await dialog(page).getByRole('button', { name: 'New order' }).tap()
		await expect(bar(page)).toContainText('Order is empty')
	})

	test('sheets are full screen on a phone and keep their action in reach', async ({
		demo: page,
	}) => {
		await menuItem(page, 'Smash Burger').tap()
		const sheet = dialog(page)
		const viewport = page.viewportSize()!
		const box = await sheet.boundingBox()
		expect(Math.round(box!.width)).toBe(viewport.width)
		expect(Math.round(box!.height)).toBe(viewport.height)
		const add = sheet.getByRole('button', { name: /^Add ·/ })
		await expect(add).toBeInViewport()
		// Content scrolls inside the sheet; the action stays put.
		await sheet
			.getByRole('button', { name: /^Avocado/ })
			.scrollIntoViewIfNeeded()
		await expect(add).toBeInViewport()
		await sheet.getByRole('button', { name: /^Extra cheese/ }).tap()
		await add.tap()
		await expect(bar(page)).toContainText('$')
	})

	test('the payment sheet is usable on a phone: keypad, change and confirm in view', async ({
		demo: page,
	}) => {
		await openCategory(page, 'Starters')
		await addQuick(page, 'Truffle Fries')
		await bar(page).tap()
		await dialog(page)
			.getByRole('button', { name: /^Charge/ })
			.tap()
		const pay = dialog(page).last()
		for (const digit of '2000')
			await pay
				.getByRole('group', { name: 'Keypad' })
				.getByRole('button', { name: digit, exact: true })
				.tap()
		await expect(pay.getByText('Change $11.88')).toBeVisible()
		await expect(confirmButton(pay)).toBeInViewport()
		const box = await confirmButton(pay).boundingBox()
		expect(box!.height).toBeGreaterThanOrEqual(56)
	})

	test('pay later and split both work with a thumb', async ({ demo: page }) => {
		await openCategory(page, 'Starters')
		await addQuick(page, 'Truffle Fries')
		await addQuick(page, 'Truffle Fries')
		await bar(page).tap()
		await dialog(page).getByRole('button', { name: 'Pay later' }).tap()
		await expect(bar(page)).toContainText('Order is empty')
		await expect(page.getByRole('button', { name: /1 open tab/ })).toBeVisible()

		const orders = await openOrders(page, 'open')
		await orders.getByRole('button', { name: /#T1-0001/ }).tap() // phones show the list first
		await orders.getByRole('button', { name: /^Pay / }).tap()
		const pay = dialog(page).last()
		await pay.getByRole('button', { name: 'Split 2' }).tap()
		await confirmButton(pay).tap()
		await expect(pay.getByText('Balance')).toBeVisible()
		await confirmButton(pay).tap()
		await expect(
			dialog(page).getByRole('heading', { name: 'Paid' }),
		).toBeVisible()
	})

	test('Orders: the list and the detail take turns, with a way back', async ({
		demo: page,
	}) => {
		await openCategory(page, 'Starters')
		await addQuick(page, 'Truffle Fries')
		await bar(page).tap()
		await dialog(page).getByRole('button', { name: 'Pay later' }).tap()
		const orders = await openOrders(page, 'open')
		await expect(
			orders.getByRole('button', { name: /All orders/ }),
		).toHaveCount(0)
		await orders.getByRole('button', { name: /#T1-0001/ }).tap()
		await expect(
			orders.getByRole('button', { name: /All orders/ }),
		).toBeVisible()
		await expect(orders.getByText('1 × Truffle Fries')).toBeVisible()
		await orders.getByRole('button', { name: /All orders/ }).tap()
		await expect(orders.getByRole('button', { name: /#T1-0001/ })).toBeVisible()
	})

	test('the header fits: brand, status, Orders and Settings all on screen', async ({
		demo: page,
	}) => {
		const viewport = page.viewportSize()!
		for (const locator of [
			page.getByRole('heading', { name: 'Demo Kitchen' }),
			page.getByRole('button', { name: /^Orders/ }),
			page.getByRole('button', { name: 'Settings' }),
			page
				.locator('header')
				.getByRole('img', { name: /Online|Offline|Sending/ }),
		]) {
			const box = await locator.boundingBox()
			expect(box).not.toBeNull()
			expect(box!.x).toBeGreaterThanOrEqual(0)
			expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width)
		}
	})

	test('category chips and the search box stack and scroll without breaking the page', async ({
		demo: page,
	}) => {
		const nav = page.getByRole('navigation', { name: 'Categories' })
		await expect(
			page.getByRole('searchbox', { name: 'Search the menu' }),
		).toBeVisible()
		await nav.getByRole('button', { name: /^Dessert/ }).tap()
		await expect(menuItem(page, 'Warm Brownie')).toBeVisible()
		expect(
			await page.evaluate(
				() =>
					document.documentElement.scrollWidth <=
					document.documentElement.clientWidth,
			),
		).toBe(true)
	})

	test('sub-categories are reachable by touch', async ({ demo: page }) => {
		await openCategory(page, 'Drinks')
		await page
			.getByRole('navigation', { name: 'Drinks sections' })
			.getByRole('button', { name: /^Cold/ })
			.tap()
		await page
			.getByRole('navigation', { name: 'Cold sections' })
			.getByRole('button', { name: /^Juice/ })
			.tap()
		await expect(menuItem(page, 'Orange Juice')).toBeVisible()
	})

	test('landscape phone still works: bar mode, sheets scroll', async ({
		demo: page,
	}) => {
		await page.setViewportSize({ width: 915, height: 412 })
		await expect(bar(page)).toBeVisible()
		await menuItem(page, 'Smash Burger').tap()
		const sheet = dialog(page)
		await expect(sheet.getByRole('button', { name: /^Add ·/ })).toBeInViewport()
		await sheet.getByRole('button', { name: /^Add ·/ }).tap()
		await expect(bar(page)).toContainText('View order')
	})

	test('pairing and selling work on a phone against the real server', async ({
		page,
	}) => {
		const { link } = await backend.pairingCode({
			label: 'Waiter phone',
			terminalCode: 'W1',
		})
		await openPairingLink(page, link)
		await expect(
			page.getByRole('heading', { name: 'Demo Kitchen' }),
		).toBeVisible()
		await expect.poll(async () => (await backend.devices()).length).toBe(1)
		await openCategory(page, 'Starters')
		await addQuick(page, 'Truffle Fries')
		await bar(page).tap()
		await dialog(page)
			.getByRole('button', { name: /^Charge/ })
			.tap()
		await confirmButton(dialog(page).last()).tap()
		await dialog(page).getByRole('button', { name: 'New order' }).tap()
		const [order] = await expectStored(1)
		expect(order!.number).toBe('W1-0001')
	})

	test('the lock screen fits the phone, the keypad works by touch, and a PIN opens the till', async ({
		unpaired: page,
	}) => {
		await pairLocked(page)
		const lock = lockScreen(page)
		const viewport = page.viewportSize()!
		const keypad = lock.getByRole('group', { name: 'Keypad' })
		for (const target of [
			keypad,
			lock.getByRole('button', { name: 'Sign in' }),
		]) {
			const box = (await target.boundingBox())!
			expect(box.x).toBeGreaterThanOrEqual(0)
			expect(box.x + box.width).toBeLessThanOrEqual(viewport.width)
			expect(box.y + box.height).toBeLessThanOrEqual(viewport.height)
		}
		expect(
			await page.evaluate(
				() =>
					document.documentElement.scrollWidth <=
					document.documentElement.clientWidth,
			),
		).toBe(true)
		await signInWithPin(page, ANA.pin)
		await expect(lock).toHaveCount(0)
	})
})
