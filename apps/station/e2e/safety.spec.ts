import { type Page } from '@playwright/test'
import {
	addQuick,
	backend,
	cart,
	confirmButton,
	dialog,
	expect,
	expectStored,
	fillCart,
	menuItem,
	openCategory,
	openOrders,
	pairUi,
	payExactCash,
	sellFries,
	startCharge,
	test,
	giveReason,
} from './helpers.ts'

const settingsButton = (page: Page) =>
	page.getByRole('button', { name: 'Settings' })

async function leaveTab(page: Page, item = 'Buffalo Wings') {
	await openCategory(page, 'Starters')
	await addQuick(page, item)
	await cart(page).getByRole('button', { name: 'Pay later' }).click()
	await expect(cart(page).getByText('No items yet')).toBeVisible()
}

test.describe('a terminal bound to a location', () => {
	test('whose location is not on the published menu refuses to sell from another one', async ({
		unpaired: page,
	}) => {
		// Pair to a real location, then publish a menu that no longer contains it.
		// Unknown control-plane locations are correctly refused during pairing.
		await pairUi(page, { terminalCode: 'T1', locationId: 'loc-1' })
		await backend.location({ id: 'loc-elsewhere' })
		await page.getByRole('button', { name: 'Refresh menu' }).click()
		await expect(page.getByText(/location isn’t on the menu/)).toBeVisible()
		await expect(
			page.getByRole('button', { name: /^Smash Burger,/ }),
		).toHaveCount(0)
		await expect(page.getByRole('button', { name: /^Charge/ })).toBeDisabled()
		expect(await backend.orders()).toHaveLength(0)
	})

	test('whose location is on the menu sells normally and cannot be switched', async ({
		unpaired: page,
	}) => {
		await pairUi(page, { terminalCode: 'T1', locationId: 'loc-1' })
		await sellFries(page)
		const [order] = await expectStored(1)
		expect(order!.reviewReason).toBeNull()
		expect(order!.locationName).toBe('Downtown')
	})
})

test.describe('a bill that comes to nothing', () => {
	test('is closed without a payment and arrives as a paid, zero order', async ({
		paired: page,
	}) => {
		await openCategory(page, 'Drinks')
		await addQuick(page, 'House Tap Water')
		const sheet = await startCharge(page)
		const close = sheet.getByRole('button', {
			name: 'Close order · nothing to pay',
		})
		await expect(close).toBeEnabled()
		await close.click()
		await expect(
			dialog(page).getByRole('heading', { name: 'Paid' }),
		).toBeVisible()
		await dialog(page).getByRole('button', { name: 'New order' }).click()
		const [order] = await expectStored(1)
		expect(order).toMatchObject({ status: 'paid', totalCents: 0, payments: [] })
	})
})

test.describe('taps and mix-ups that used to lose or duplicate work', () => {
	test('double-tapping Pay later saves one tab, not two', async ({
		demo: page,
	}) => {
		await openCategory(page, 'Starters')
		await addQuick(page, 'Truffle Fries')
		await cart(page).getByRole('button', { name: 'Pay later' }).dblclick()
		await expect(cart(page).getByText('No items yet')).toBeVisible()
		const orders = await openOrders(page, 'open')
		await expect(
			orders.getByRole('radio', { name: 'Open tabs · 1' }),
		).toBeVisible()
	})

	test('opening a tab over an order being rung up asks first, and "keep working" keeps it', async ({
		demo: page,
	}) => {
		await leaveTab(page)
		await addQuick(page, 'Truffle Fries') // a different order, not yet saved
		const orders = await openOrders(page, 'open')
		await orders.getByRole('button', { name: 'Add items' }).click()
		const ask = dialog(page).filter({ hasText: 'Replace the order on screen?' })
		await expect(ask).toBeVisible()
		await ask.getByRole('button', { name: 'Keep working' }).click()
		await expect(cart(page).getByText('Truffle Fries')).toBeVisible()
		await expect(cart(page).getByText(/Adding to tab/)).toHaveCount(0)
		// The Orders list is still open behind it; replacing is possible, on purpose.
		await orders.getByRole('button', { name: 'Add items' }).click()
		await dialog(page).getByRole('button', { name: 'Replace it' }).click()
		await expect(cart(page).getByText(/Adding to tab #T1-0001/)).toBeVisible()
		await expect(cart(page).getByText('Truffle Fries')).toHaveCount(0)
	})

	test('settling a tab from the Orders list leaves the order on screen alone', async ({
		demo: page,
	}) => {
		await leaveTab(page)
		await addQuick(page, 'Truffle Fries')
		const orders = await openOrders(page, 'open')
		await orders.getByRole('button', { name: /^Pay / }).click()
		await confirmButton(dialog(page)).click()
		await dialog(page).getByRole('button', { name: 'New order' }).click()
		await expect(cart(page).getByText('Truffle Fries')).toBeVisible()
	})

	test('cancelling a tab is deliberate: nothing happens until a reason is given and confirmed', async ({
		demo: page,
	}) => {
		await leaveTab(page)
		const orders = await openOrders(page, 'open')
		await orders.getByRole('button', { name: 'Cancel tab' }).click()
		// Nothing happened yet, and it cannot be confirmed without a reason.
		await expect(
			orders.getByRole('radio', { name: 'Open tabs · 1' }),
		).toBeVisible()
		const sheet = page.getByRole('dialog', { name: /^Cancel tab/ })
		await expect(
			sheet.getByRole('button', { name: 'Cancel the tab' }),
		).toBeDisabled()
		await giveReason(page, {
			title: /^Cancel tab/,
			confirm: /^Cancel the tab$/,
		})
		await expect(orders.getByText(/No open tabs/)).toBeVisible()
	})
})

test.describe('pairing links', () => {
	test('on a till that is already paired, a link asks before it changes anything', async ({
		paired: page,
	}) => {
		const { link } = await backend.pairingCode({
			label: 'Someone else',
			terminalCode: 'T2',
		})
		await page.goto(link)
		await expect(
			page.getByRole('heading', { name: 'Demo Kitchen' }),
		).toBeVisible()
		const ask = dialog(page).filter({
			hasText: 'Pair with a different restaurant?',
		})
		await expect(ask).toBeVisible()
		expect(page.url()).not.toContain('ppc1')
		await ask.getByRole('button', { name: 'Keep current pairing' }).click()
		// Nothing was redeemed: the code is still waiting.
		expect(await backend.devices()).toHaveLength(1)
		await settingsButton(page).click()
		await expect(
			dialog(page).getByText(/Paired as Front counter/),
		).toBeVisible()
	})

	test('and does pair when the person confirms', async ({ paired: page }) => {
		const { link } = await backend.pairingCode({
			label: 'Second',
			terminalCode: 'T2',
		})
		await page.goto(link)
		await dialog(page)
			.getByRole('button', { name: 'Pair with this link' })
			.click()
		await expect.poll(async () => (await backend.devices()).length).toBe(2)
		await settingsButton(page).click()
		await expect(dialog(page).getByText(/Paired as Second/)).toBeVisible()
	})
})

test.describe('demo mode can never touch a real restaurant', () => {
	test('sales made in demo mode while paired are kept on the device and never sent', async ({
		paired: page,
	}) => {
		await settingsButton(page).click()
		await dialog(page).getByLabel('Demo mode').check()
		await dialog(page).getByRole('button', { name: 'Save' }).click()
		await expect(page.getByRole('dialog')).toHaveCount(0)
		await sellFries(page)
		await page.waitForTimeout(1200)
		expect(await backend.orders()).toHaveLength(0)
		// Not counted as "sending", and explained in the order itself.
		await expect(page.getByText(/Sending/)).toHaveCount(0)
		const orders = await openOrders(page, 'today')
		await expect(
			orders.getByText(/taken in demo mode, so it is kept here and never sent/),
		).toBeVisible()
	})
})

test.describe('a re-paired terminal carries on', () => {
	test('a tab started before the terminal was removed can be paid after it is paired again', async ({
		paired: page,
	}) => {
		await leaveTab(page, 'Truffle Fries')
		await expectStored(1)
		const [device] = await backend.devices()
		await backend.revoke(device!.id)
		await page.reload()
		await expect(page.getByText(/This terminal was removed/)).toBeVisible()

		const { code } = await backend.pairingCode({
			label: 'Replacement',
			terminalCode: 'T1',
		})
		await page.getByText(/This terminal was removed/).click()
		await page.getByLabel('Pairing link or code').fill(code)
		await page.getByRole('button', { name: 'Pair terminal' }).click()
		await expect(page.getByRole('dialog')).toHaveCount(0)

		const orders = await openOrders(page, 'open')
		await orders.getByRole('button', { name: /^Pay / }).click()
		await confirmButton(dialog(page)).click()
		await expect(
			dialog(page).getByRole('heading', { name: 'Paid' }),
		).toBeVisible()
		await dialog(page).getByRole('button', { name: 'New order' }).click()
		await expect
			.poll(async () => (await backend.orders())[0]?.status)
			.toBe('paid')
		const stored = await backend.orders()
		expect(stored).toHaveLength(1)
		expect(stored[0]!.payments).toHaveLength(1)
		expect((await backend.requests()).filter((r) => r.status === 409)).toEqual(
			[],
		)
	})
})

test.describe('the menu cannot be checked, the sale is still kept', () => {
	test('an outage of the menu check stores the sale for review instead of holding it back', async ({
		paired: page,
	}) => {
		// The App is unreachable from the server's side: the order still lands.
		await backend.post('/__test/context', { down: true })
		await sellFries(page)
		const [order] = await expectStored(1)
		expect(order).toMatchObject({ status: 'paid', reviewReason: 'unverified' })
		await backend.post('/__test/context', { down: false })
	})
})

test.describe('the receipt and the page', () => {
	test('a hostile font address in the theme cannot add rules to the page', async ({
		unpaired: page,
	}) => {
		await backend.theme({
			css: ':root{--primary:oklch(.4 .1 150)}',
			headingFont: 'custom',
			headingCustomFont: {
				url: "https://x.example/a.woff2');}body{display:none}@font-face{src:url('",
				format: 'woff2',
			},
		})
		await page.getByRole('button', { name: 'Refresh menu' }).click()
		await expect
			.poll(() => page.locator('style#org-fonts').textContent())
			.toContain('SiteHeading')
		const body = await page.evaluate(
			() => getComputedStyle(document.body).display,
		)
		expect(body).not.toBe('none')
		await expect(menuItem(page, 'Smash Burger')).toBeVisible()
	})

	test('refuses a font from a non-web address', async ({ unpaired: page }) => {
		await backend.theme({
			css: ':root{--primary:oklch(.4 .1 150)}',
			headingFont: 'custom',
			headingCustomFont: { url: 'javascript:alert(1)', format: 'woff2' },
		})
		await page.getByRole('button', { name: 'Refresh menu' }).click()
		await expect(page.locator('style#org-theme')).toHaveCount(1)
		expect(
			(await page.locator('style#org-fonts').textContent()) ?? '',
		).not.toContain('SiteHeading')
		await fillCart(page, 1)
		await payExactCash(page)
	})
})
