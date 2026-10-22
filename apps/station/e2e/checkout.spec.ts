import { type Page } from '@playwright/test'
import {
	addQuick,
	cart,
	closeDialog,
	confirmButton,
	dialog,
	expect,
	fillCart,
	openCategory,
	openOrders,
	startCharge,
	test,
	trapPrint,
	typeKeypad,
} from './helpers.ts'

// Two fries: $15.00 + $1.24 tax = $16.24. One fries: $7.50 + $0.62 = $8.12.
const paidScreen = (page: Page) =>
	dialog(page).getByRole('heading', { name: 'Paid' })

test.describe('paying in full', () => {
	test('cash, exact: no keypad needed, no change', async ({ demo: page }) => {
		await fillCart(page, 1)
		const sheet = await startCharge(page)
		await expect(sheet.getByText('Total due')).toBeVisible()
		await expect(sheet.getByText('$8.12').first()).toBeVisible()
		await confirmButton(sheet).click()
		await expect(paidScreen(page)).toBeVisible()
		await expect(dialog(page).getByText('Order #T1-0001')).toBeVisible()
		await expect(dialog(page).getByText('$8.12')).toBeVisible()
		await expect(dialog(page).getByText('Change due')).toHaveCount(0)
	})

	test('cash with a note larger than the bill shows the change to hand back', async ({
		demo: page,
	}) => {
		await fillCart(page, 1)
		const sheet = await startCharge(page)
		await typeKeypad(sheet, '2000')
		await expect(sheet.getByText('Change $11.88')).toBeVisible()
		await confirmButton(sheet).click()
		await expect(paidScreen(page)).toBeVisible()
		await expect(dialog(page).getByText('Change due')).toBeVisible()
		await expect(dialog(page).getByText('$11.88')).toBeVisible()
	})

	test('quick-cash buttons are round amounts above the bill; Exact resets', async ({
		demo: page,
	}) => {
		await fillCart(page, 1)
		const sheet = await startCharge(page)
		for (const label of ['$9.00', '$10.00', '$20.00', '$50.00']) {
			await expect(
				sheet.getByRole('button', { name: label, exact: true }),
			).toBeVisible()
		}
		await sheet.getByRole('button', { name: '$20.00', exact: true }).click()
		await expect(sheet.getByText('Change $11.88')).toBeVisible()
		await sheet.getByRole('button', { name: 'Exact' }).click()
		await expect(sheet.getByText(/^Change/)).toHaveCount(0)
		await expect(confirmButton(sheet)).toHaveText('Confirm $8.12')
	})

	test('cash short of the bill is refused and says by how much', async ({
		demo: page,
	}) => {
		await fillCart(page, 1)
		const sheet = await startCharge(page)
		await typeKeypad(sheet, '500')
		const button = sheet.getByRole('button', { name: '$3.12 short' })
		await expect(button).toBeVisible()
		await expect(button).toBeDisabled()
		await typeKeypad(sheet, '0')
		await expect(
			sheet.getByRole('button', { name: 'Confirm $8.12' }),
		).toBeEnabled()
	})

	test('keypad: delete removes a digit, C clears back to exact', async ({
		demo: page,
	}) => {
		await fillCart(page, 1)
		const sheet = await startCharge(page)
		await typeKeypad(sheet, '1000')
		await expect(
			sheet.getByRole('button', { name: /^Cash received/ }),
		).toContainText('$10.00')
		await sheet.getByRole('button', { name: 'Delete' }).click()
		await expect(
			sheet.getByRole('button', { name: /^Cash received/ }),
		).toContainText('$1.00')
		await sheet.getByRole('button', { name: 'Clear' }).click()
		await expect(
			sheet.getByRole('button', { name: /^Cash received/ }),
		).toContainText('$8.12')
	})

	test('card and other take the exact amount and explain what to do', async ({
		demo: page,
	}) => {
		await fillCart(page, 1)
		let sheet = await startCharge(page)
		await sheet.getByRole('radio', { name: 'Card' }).click()
		await expect(
			sheet.getByText(/Take the card on your card terminal first/),
		).toBeVisible()
		await expect(sheet.getByRole('group', { name: 'Keypad' })).toHaveCount(0)
		await confirmButton(sheet).click()
		await expect(paidScreen(page)).toBeVisible()
		await expect(dialog(page).getByText('Change due')).toHaveCount(0)
		await dialog(page).getByRole('button', { name: 'New order' }).click()

		await fillCart(page, 1)
		sheet = await startCharge(page)
		await sheet.getByRole('radio', { name: 'Other' }).click()
		await expect(sheet.getByText(/collected another way/)).toBeVisible()
		await confirmButton(sheet).click()
		await expect(paidScreen(page)).toBeVisible()
	})

	test('a tip is added to the total, and None takes it away', async ({
		demo: page,
	}) => {
		await fillCart(page, 1)
		const sheet = await startCharge(page)
		await sheet.getByRole('button', { name: '15%' }).click()
		// 15% of $7.50 = $1.125 → $1.13; total $8.12 + $1.13 = $9.25
		await expect(
			sheet.getByRole('term').filter({ hasText: /^Tip$/ }),
		).toBeVisible()
		await expect(sheet.getByText('$1.13')).toBeVisible()
		await expect(sheet.getByText('$9.25').first()).toBeVisible()
		await expect(confirmButton(sheet)).toHaveText('Confirm $9.25')
		await sheet.getByRole('button', { name: 'None' }).click()
		await expect(sheet.getByText('$1.13')).toHaveCount(0)
		await expect(confirmButton(sheet)).toHaveText('Confirm $8.12')
	})

	test('closing the payment sheet unpaid keeps the order and creates nothing', async ({
		demo: page,
	}) => {
		await fillCart(page, 1)
		await startCharge(page)
		await closeDialog(page)
		await expect(cart(page).getByText('Truffle Fries')).toBeVisible()
		const orders = await openOrders(page, 'today')
		await expect(orders.getByText(/No orders yet today/)).toBeVisible()
	})

	test('after payment the order is empty and the next order gets the next number', async ({
		demo: page,
	}) => {
		await fillCart(page, 1)
		let sheet = await startCharge(page)
		await confirmButton(sheet).click()
		await dialog(page).getByRole('button', { name: 'New order' }).click()
		await expect(page.getByRole('dialog')).toHaveCount(0)
		await expect(cart(page).getByText('No items yet')).toBeVisible()

		await openCategory(page, 'Starters')
		await addQuick(page, 'Buffalo Wings')
		sheet = await startCharge(page)
		await confirmButton(sheet).click()
		await expect(dialog(page).getByText('Order #T1-0002')).toBeVisible()
	})

	test('the paid screen cannot be dismissed by accident', async ({
		demo: page,
	}) => {
		await fillCart(page, 1)
		const sheet = await startCharge(page)
		await confirmButton(sheet).click()
		await expect(paidScreen(page)).toBeVisible()
		await page.keyboard.press('Escape')
		await expect(paidScreen(page)).toBeVisible()
		await expect(
			dialog(page).getByRole('button', { name: 'Close' }),
		).toHaveCount(0)
	})

	test('tapping confirm twice quickly still creates exactly one order', async ({
		demo: page,
	}) => {
		await fillCart(page, 1)
		const sheet = await startCharge(page)
		const button = confirmButton(sheet)
		await button.dblclick()
		await expect(paidScreen(page)).toBeVisible()
		await dialog(page).getByRole('button', { name: 'New order' }).click()
		const orders = await openOrders(page, 'today')
		await expect(orders.getByRole('heading', { name: 'Orders' })).toBeVisible()
		await expect(orders.getByRole('radio', { name: 'Today · 1' })).toBeVisible()
	})

	test('every dish, size, extra and note is on the stored order', async ({
		demo: page,
	}) => {
		await openCategory(page, 'Pizza')
		await page.getByRole('button', { name: /^Margherita,/ }).click()
		await dialog(page)
			.getByRole('button', { name: /^Large/ })
			.click()
		await dialog(page)
			.getByRole('button', { name: /^Extra cheese/ })
			.click()
		await dialog(page)
			.getByPlaceholder(/Allergies/)
			.fill('well done')
		await dialog(page)
			.getByRole('button', { name: /^Add ·/ })
			.click()
		const sheet = await startCharge(page)
		await confirmButton(sheet).click()
		await dialog(page).getByRole('button', { name: 'New order' }).click()
		const orders = await openOrders(page, 'today')
		await expect(orders.getByText('1 × Margherita')).toBeVisible()
		await expect(orders.getByText('Large')).toBeVisible()
		await expect(orders.getByText('Extra cheese')).toBeVisible()
	})
})

test.describe('receipts', () => {
	test('the receipt carries business, number, lines, totals and payment', async ({
		demo: page,
	}) => {
		await fillCart(page, 1)
		const sheet = await startCharge(page)
		await typeKeypad(sheet, '1000')
		await confirmButton(sheet).click()
		await expect(paidScreen(page)).toBeVisible()
		const receipt = page.locator('#receipt')
		await expect(receipt).toContainText('Demo Kitchen')
		await expect(receipt).toContainText('#T1-0001')
		await expect(receipt).toContainText('1 × Truffle Fries')
		await expect(receipt).toContainText('Subtotal')
		await expect(receipt).toContainText('$7.50')
		await expect(receipt).toContainText('Tax')
		await expect(receipt).toContainText('Paid · Cash')
		await expect(receipt).toContainText('$10.00')
		await expect(receipt).toContainText('Change')
		await expect(receipt).toContainText('$1.88')
	})

	test('the receipt lists each extra with its quantity and price', async ({
		demo: page,
	}) => {
		const burger = await (async () => {
			await page.getByRole('button', { name: /^Smash Burger,/ }).click()
			return dialog(page)
		})()
		await burger.getByRole('button', { name: /^Extra cheese/ }).click()
		await burger.getByRole('button', { name: /^Bacon/ }).click()
		await burger.getByRole('button', { name: 'More' }).click() // two burgers
		await burger.getByRole('button', { name: /^Add ·/ }).click()
		const sheet = await startCharge(page)
		await confirmButton(sheet).click()
		const receipt = page.locator('#receipt')
		await expect(receipt).toContainText('2 × Smash Burger')
		await expect(receipt).toContainText('+ Extra cheese')
		await expect(receipt).toContainText('$3.00') // 2 burgers × $1.50
		await expect(receipt).toContainText('+ Bacon')
		await expect(receipt).toContainText('$4.00') // 2 burgers × $2.00
	})

	test('Receipt asks the browser to print', async ({ demo: page }) => {
		await fillCart(page, 1)
		const sheet = await startCharge(page)
		await confirmButton(sheet).click()
		const prints = await trapPrint(page)
		await dialog(page).getByRole('button', { name: 'Receipt' }).click()
		expect(await prints()).toBe(1)
	})

	test('the receipt is only visible when printing', async ({ demo: page }) => {
		await fillCart(page, 1)
		const sheet = await startCharge(page)
		await confirmButton(sheet).click()
		await expect(page.locator('#receipt')).toBeHidden()
		await page.emulateMedia({ media: 'print' })
		await expect(page.locator('#receipt')).toBeVisible()
		await page.emulateMedia({ media: 'screen' })
	})

	test('orders can be reprinted from the Orders sheet', async ({
		demo: page,
	}) => {
		await fillCart(page, 1)
		const sheet = await startCharge(page)
		await confirmButton(sheet).click()
		await dialog(page).getByRole('button', { name: 'New order' }).click()
		const prints = await trapPrint(page)
		const orders = await openOrders(page, 'today')
		await orders.getByRole('button', { name: 'Print receipt' }).click()
		expect(await prints()).toBe(1)
		await expect(page.locator('#receipt')).toContainText('#T1-0001')
	})
})

test.describe("today's orders", () => {
	test("lists orders newest first with the day's total", async ({
		demo: page,
	}) => {
		for (const item of ['Truffle Fries', 'Buffalo Wings']) {
			await openCategory(page, 'Starters')
			await addQuick(page, item)
			const sheet = await startCharge(page)
			await confirmButton(sheet).click()
			await dialog(page).getByRole('button', { name: 'New order' }).click()
		}
		const orders = await openOrders(page, 'today')
		const rows = orders.locator('ul').first().getByRole('button')
		await expect(rows.nth(0)).toContainText('#T1-0002')
		await expect(rows.nth(1)).toContainText('#T1-0001')
		// $8.12 + $11.91 = $20.03
		await expect(orders.getByText('Taken today')).toBeVisible()
		await expect(orders.getByText('$20.03')).toBeVisible()
	})

	test('shows table, takeaway name and order details', async ({
		demo: page,
	}) => {
		await fillCart(page, 1)
		await cart(page)
			.getByRole('button', { name: /Add table/ })
			.click()
		await dialog(page)
			.getByPlaceholder(/e\.g\. 12/)
			.fill('9')
		await dialog(page).getByRole('button', { name: 'Done' }).click()
		const sheet = await startCharge(page)
		await confirmButton(sheet).click()
		await dialog(page).getByRole('button', { name: 'New order' }).click()
		const orders = await openOrders(page, 'today')
		await expect(orders.getByText(/Table 9/).first()).toBeVisible()
		await expect(orders.getByText('1 × Truffle Fries')).toBeVisible()
	})

	test('orders persist across a reload', async ({ demo: page }) => {
		await fillCart(page, 1)
		const sheet = await startCharge(page)
		await confirmButton(sheet).click()
		await dialog(page).getByRole('button', { name: 'New order' }).click()
		await page.reload()
		await expect(
			page.getByRole('heading', { name: 'Demo Kitchen' }),
		).toBeVisible()
		const orders = await openOrders(page, 'today')
		await expect(orders.getByText('#T1-0001').first()).toBeVisible()
	})
})
