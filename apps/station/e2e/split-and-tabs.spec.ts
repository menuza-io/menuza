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
	typeKeypad,
	giveReason,
} from './helpers.ts'

// Two fries: $15.00 + $1.24 tax = $16.24 (1624 cents).
const TOTAL = '$16.24'
const paid = (page: Page) => dialog(page).getByRole('heading', { name: 'Paid' })

test.describe('split payments', () => {
	test('split two ways: each share is half, the bill stays open until both are in', async ({
		demo: page,
	}) => {
		await fillCart(page)
		const sheet = await startCharge(page)
		await sheet.getByRole('button', { name: 'Split 2' }).click()
		await expect(sheet.getByText('Each share is $8.12')).toBeVisible()
		await expect(confirmButton(sheet)).toHaveText('Take $8.12 · $8.12 left')
		await confirmButton(sheet).click()

		// Still paying: the first payment is recorded and the balance is halved.
		await expect(sheet.getByText('Paid · Cash')).toBeVisible()
		await expect(sheet.getByText('Balance')).toBeVisible()
		await expect(paid(page)).toHaveCount(0)
		await sheet.getByRole('radio', { name: 'Card' }).click()
		await expect(confirmButton(sheet)).toHaveText('Confirm $8.12')
		await confirmButton(sheet).click()

		await expect(paid(page)).toBeVisible()
		await expect(dialog(page).getByText('Cash', { exact: true })).toBeVisible()
		await expect(dialog(page).getByText('Card', { exact: true })).toBeVisible()
		await dialog(page).getByRole('button', { name: 'New order' }).click()

		const orders = await openOrders(page, 'today')
		await expect(orders.getByText('Paid · Cash')).toBeVisible()
		await expect(orders.getByText('Paid · Card')).toBeVisible()
	})

	test('split three ways: the last share takes whatever is left, to the cent', async ({
		demo: page,
	}) => {
		await fillCart(page)
		const sheet = await startCharge(page)
		await sheet.getByRole('button', { name: 'Split 3' }).click()
		await expect(sheet.getByText('Each share is $5.42')).toBeVisible()
		await confirmButton(sheet).click()
		await expect(confirmButton(sheet)).toHaveText('Take $5.42 · $5.40 left')
		await confirmButton(sheet).click()
		// 16.24 - 5.42 - 5.42 = 5.40: below a full share, so this one closes the bill.
		await expect(confirmButton(sheet)).toHaveText('Confirm $5.40')
		await confirmButton(sheet).click()
		await expect(paid(page)).toBeVisible()
	})

	test('a custom amount, then the rest', async ({ demo: page }) => {
		await fillCart(page)
		const sheet = await startCharge(page)
		await sheet.getByRole('button', { name: 'Amount' }).click()
		await typeKeypad(sheet, '1000')
		await expect(
			sheet.getByRole('button', { name: /^Paying now/ }),
		).toContainText('$10.00')
		await expect(confirmButton(sheet)).toHaveText('Take $10.00 · $6.24 left')
		await confirmButton(sheet).click()
		await expect(
			sheet.getByRole('button', { name: /^Paying now/ }),
		).toContainText('$6.24')
		await expect(confirmButton(sheet)).toHaveText('Confirm $6.24')
		await confirmButton(sheet).click()
		await expect(paid(page)).toBeVisible()
	})

	test('a custom amount can never exceed what is owed', async ({
		demo: page,
	}) => {
		await fillCart(page)
		const sheet = await startCharge(page)
		await sheet.getByRole('button', { name: 'Amount' }).click()
		await typeKeypad(sheet, '99999')
		await expect(
			sheet.getByRole('button', { name: /^Paying now/ }),
		).toContainText(TOTAL)
		await expect(confirmButton(sheet)).toHaveText(`Confirm ${TOTAL}`)
	})

	test('"Enter an amount" blocks a custom payment of nothing', async ({
		demo: page,
	}) => {
		await fillCart(page)
		const sheet = await startCharge(page)
		await sheet.getByRole('button', { name: 'Amount' }).click()
		const button = sheet.getByRole('button', { name: 'Enter an amount' })
		await expect(button).toBeDisabled()
	})

	test('part cash with change, then card: change belongs to the cash payment only', async ({
		demo: page,
	}) => {
		await fillCart(page)
		const sheet = await startCharge(page)
		await sheet.getByRole('button', { name: 'Amount' }).click()
		await typeKeypad(sheet, '1000') // pay $10.00 toward the bill…
		await sheet.getByRole('button', { name: /^Cash received/ }).click()
		await typeKeypad(sheet, '2000') // …with a $20 note
		await expect(sheet.getByText('Change $10.00')).toBeVisible()
		await confirmButton(sheet).click()
		await expect(sheet.getByText('Paid · Cash')).toBeVisible()
		// The change is owed now, for that payment, while the guest is standing there.
		await expect(
			sheet
				.getByRole('status')
				.filter({ hasText: 'Give $10.00 change for that payment' }),
		).toBeVisible()
		await sheet.getByRole('radio', { name: 'Card' }).click()
		await confirmButton(sheet).click()
		await expect(paid(page)).toBeVisible()
		// Paying the rest by card owes nothing: the $10.00 was already handed back, not twice.
		await expect(dialog(page).getByText('Change due')).toHaveCount(0)
	})

	test('the tip is chosen once, before the first payment, and then locked', async ({
		demo: page,
	}) => {
		await fillCart(page)
		const sheet = await startCharge(page)
		await sheet.getByRole('button', { name: '10%' }).click() // 10% of $15.00 = $1.50 → total $17.74
		await sheet.getByRole('button', { name: 'Split 2' }).click()
		await expect(confirmButton(sheet)).toHaveText('Take $8.87 · $8.87 left')
		await confirmButton(sheet).click()
		// The tip choices are gone: shares can no longer drift.
		await expect(sheet.getByRole('button', { name: '20%' })).toHaveCount(0)
		await expect(
			sheet.getByRole('term').filter({ hasText: /^Tip$/ }),
		).toBeVisible()
		await expect(sheet.getByText('$1.50')).toBeVisible()
		await confirmButton(sheet).click()
		await expect(paid(page)).toBeVisible()
		await expect(page.locator('#receipt')).toContainText('Tip')
	})

	test('closing part-way leaves a part-paid tab with the balance, and the cart is free', async ({
		demo: page,
	}) => {
		await fillCart(page)
		const sheet = await startCharge(page)
		await sheet.getByRole('button', { name: 'Split 2' }).click()
		await confirmButton(sheet).click()
		await expect(
			sheet.getByText('Closing now leaves $8.12 open on the tab'),
		).toBeVisible()
		await closeDialog(page)
		await expect(cart(page).getByText('No items yet')).toBeVisible()

		const orders = await openOrders(page, 'open')
		await expect(orders.getByText('Part paid').first()).toBeVisible()
		await expect(orders.getByText('Balance due')).toBeVisible()
		await expect(orders.getByText('$8.12').first()).toBeVisible()
		// Money already taken freezes the bill: no editing, no cancelling.
		await expect(orders.getByRole('button', { name: 'Add items' })).toHaveCount(
			0,
		)
		await expect(
			orders.getByRole('button', { name: 'Cancel tab' }),
		).toHaveCount(0)
	})

	test('finishing a part-paid tab from Orders takes only the balance', async ({
		demo: page,
	}) => {
		await fillCart(page)
		const sheet = await startCharge(page)
		await sheet.getByRole('button', { name: 'Split 2' }).click()
		await confirmButton(sheet).click()
		await closeDialog(page)

		const orders = await openOrders(page, 'open')
		await orders.getByRole('button', { name: 'Pay $8.12' }).click()
		const pay = dialog(page)
		await expect(
			pay.getByRole('heading', { name: 'Pay · #T1-0001' }),
		).toBeVisible()
		await expect(pay.getByText('Balance')).toBeVisible()
		await expect(confirmButton(pay)).toHaveText('Confirm $8.12')
		await confirmButton(pay).click()
		await expect(paid(page)).toBeVisible()
		await dialog(page).getByRole('button', { name: 'New order' }).click()
		const after = await openOrders(page, 'open')
		await expect(after.getByText(/No open tabs/)).toBeVisible()
	})
})

test.describe('pay later (open tabs)', () => {
	async function leaveTab(page: Page, item = 'Truffle Fries') {
		await openCategory(page, 'Starters')
		await addQuick(page, item)
		await cart(page).getByRole('button', { name: 'Pay later' }).click()
		await expect(cart(page).getByText('No items yet')).toBeVisible()
	}

	test('"Pay later" saves the order as a tab and frees the till', async ({
		demo: page,
	}) => {
		await leaveTab(page)
		await expect(page.getByRole('button', { name: /1 open tab/ })).toBeVisible()
		const orders = await openOrders(page, 'open')
		await expect(orders.getByText('#T1-0001').first()).toBeVisible()
		await expect(orders.getByText('Open tab').first()).toBeVisible()
		await expect(orders.getByText('Balance due')).toBeVisible()
		await expect(
			orders.getByRole('button', { name: 'Pay $8.12' }),
		).toBeVisible()
	})

	test('Pay later is not offered for an empty order', async ({
		demo: page,
	}) => {
		await expect(
			cart(page).getByRole('button', { name: 'Pay later' }),
		).toBeDisabled()
	})

	test('the table or name travels with the tab', async ({ demo: page }) => {
		await openCategory(page, 'Starters')
		await addQuick(page, 'Truffle Fries')
		await cart(page)
			.getByRole('button', { name: /Add table/ })
			.click()
		await dialog(page)
			.getByPlaceholder(/e\.g\. 12/)
			.fill('14')
		await dialog(page).getByRole('button', { name: 'Done' }).click()
		await cart(page).getByRole('button', { name: 'Pay later' }).click()
		const orders = await openOrders(page, 'open')
		await expect(orders.getByText(/Table 14/).first()).toBeVisible()
	})

	test('add items to a tab: same order number, updated total, one tab', async ({
		demo: page,
	}) => {
		await leaveTab(page)
		let orders = await openOrders(page, 'open')
		await orders.getByRole('button', { name: 'Add items' }).click()
		await expect(page.getByRole('dialog')).toHaveCount(0)
		await expect(cart(page).getByText('Adding to tab #T1-0001')).toBeVisible()
		await expect(cart(page).getByText('Truffle Fries')).toBeVisible()
		await openCategory(page, 'Starters')
		await addQuick(page, 'Buffalo Wings')
		await expect(
			cart(page).getByRole('button', { name: 'Save tab' }),
		).toBeVisible()
		await cart(page).getByRole('button', { name: 'Save tab' }).click()
		await expect(cart(page).getByText('No items yet')).toBeVisible()

		orders = await openOrders(page, 'open')
		await expect(
			orders.getByRole('radio', { name: 'Open tabs · 1' }),
		).toBeVisible()
		await expect(orders.getByText('1 × Truffle Fries')).toBeVisible()
		await expect(orders.getByText('1 × Buffalo Wings')).toBeVisible()
		// $7.50 + $11.00 = $18.50; tax 8.25% = $1.53; total $20.03
		await expect(
			orders.getByRole('button', { name: 'Pay $20.03' }),
		).toBeVisible()
	})

	test('charging a tab you are adding to pays that same order', async ({
		demo: page,
	}) => {
		await leaveTab(page)
		const orders = await openOrders(page, 'open')
		await orders.getByRole('button', { name: 'Add items' }).click()
		await addQuick(page, 'Truffle Fries')
		const sheet = await startCharge(page)
		await expect(
			sheet.getByRole('heading', { name: 'Pay · #T1-0001' }),
		).toBeVisible()
		await confirmButton(sheet).click()
		await expect(dialog(page).getByText('Order #T1-0001')).toBeVisible()
		await dialog(page).getByRole('button', { name: 'New order' }).click()
		const today = await openOrders(page, 'today')
		await expect(today.getByRole('radio', { name: 'Today · 1' })).toBeVisible()
		await expect(today.getByText('2 × Truffle Fries')).toBeVisible()
	})

	test('pay a tab straight from the Orders sheet', async ({ demo: page }) => {
		await leaveTab(page)
		const orders = await openOrders(page, 'open')
		await orders.getByRole('button', { name: 'Pay $8.12' }).click()
		const pay = dialog(page)
		await expect(
			pay.getByRole('heading', { name: 'Pay · #T1-0001' }),
		).toBeVisible()
		await confirmButton(pay).click()
		await expect(paid(page)).toBeVisible()
		await dialog(page).getByRole('button', { name: 'New order' }).click()
		await expect(page.getByRole('button', { name: /open tab/ })).toHaveCount(0)
	})

	test('a tip chosen while paying a saved tab is applied to the bill', async ({
		demo: page,
	}) => {
		await leaveTab(page)
		const orders = await openOrders(page, 'open')
		await orders.getByRole('button', { name: 'Pay $8.12' }).click()
		const pay = dialog(page)
		await pay.getByRole('button', { name: '15%' }).click()
		// 15% of $7.50 = $1.125 → $1.13; total $8.12 + $1.13 = $9.25
		await expect(
			pay.getByRole('term').filter({ hasText: /^Tip$/ }),
		).toBeVisible()
		await expect(pay.getByText('$1.13')).toBeVisible()
		await expect(confirmButton(pay)).toHaveText('Confirm $9.25')
		await confirmButton(pay).click()
		await expect(paid(page)).toBeVisible()
		await expect(page.locator('#receipt')).toContainText('$1.13')
		await expect(page.locator('#receipt')).toContainText('$9.25')
	})

	test('a tip also applies when you add to a tab and charge it from the cart', async ({
		demo: page,
	}) => {
		await leaveTab(page)
		const orders = await openOrders(page, 'open')
		await orders.getByRole('button', { name: 'Add items' }).click()
		await addQuick(page, 'Truffle Fries')
		const pay = await startCharge(page)
		await pay.getByRole('button', { name: '20%' }).click()
		// Two fries: $15.00 → tip $3.00; total $16.24 + $3.00 = $19.24
		await expect(confirmButton(pay)).toHaveText('Confirm $19.24')
		await confirmButton(pay).click()
		await expect(paid(page)).toBeVisible()
	})

	test('cancel an unpaid tab: it leaves the open list and is kept as cancelled', async ({
		demo: page,
	}) => {
		await leaveTab(page)
		const orders = await openOrders(page, 'open')
		await orders.getByRole('button', { name: 'Cancel tab' }).click()
		await giveReason(page, {
			title: /^Cancel tab/,
			confirm: /^Cancel the tab$/,
		})
		await expect(orders.getByText(/No open tabs/)).toBeVisible()
		await orders.getByRole('radio', { name: /^Today/ }).click()
		await expect(orders.getByText('Cancelled').first()).toBeVisible()
	})

	test('several tabs stay independent, in the order they were opened', async ({
		demo: page,
	}) => {
		await leaveTab(page, 'Truffle Fries')
		await leaveTab(page, 'Buffalo Wings')
		const orders = await openOrders(page, 'open')
		await expect(
			orders.getByRole('radio', { name: 'Open tabs · 2' }),
		).toBeVisible()
		const rows = orders.locator('ul').first().getByRole('button')
		await expect(rows.nth(0)).toContainText('#T1-0001')
		await expect(rows.nth(1)).toContainText('#T1-0002')
		await rows.nth(1).click()
		await expect(orders.getByText('1 × Buffalo Wings')).toBeVisible()
		await orders.getByRole('button', { name: /^Pay / }).click()
		await confirmButton(dialog(page)).click()
		await dialog(page).getByRole('button', { name: 'New order' }).click()
		const after = await openOrders(page, 'open')
		await expect(
			after.getByRole('radio', { name: 'Open tabs · 1' }),
		).toBeVisible()
		await expect(after.getByText('#T1-0001').first()).toBeVisible()
	})

	test('an open tab survives a reload (and a tab left yesterday would too)', async ({
		demo: page,
	}) => {
		await leaveTab(page)
		await page.reload()
		await expect(
			page.getByRole('heading', { name: 'Demo Kitchen' }),
		).toBeVisible()
		await expect(page.getByRole('button', { name: /1 open tab/ })).toBeVisible()
		const orders = await openOrders(page, 'open')
		await expect(orders.getByText('1 × Truffle Fries')).toBeVisible()
	})

	test('a tab can be edited down as well as up', async ({ demo: page }) => {
		await openCategory(page, 'Starters')
		await addQuick(page, 'Truffle Fries')
		await addQuick(page, 'Buffalo Wings')
		await cart(page).getByRole('button', { name: 'Pay later' }).click()
		const orders = await openOrders(page, 'open')
		await orders.getByRole('button', { name: 'Add items' }).click()
		await cart(page).getByText('Remove').first().click()
		await cart(page).getByRole('button', { name: 'Save tab' }).click()
		// Taking something off a saved tab is recorded with a reason.
		await giveReason(page, {
			title: 'Take items off this tab?',
			confirm: 'Take them off',
			reason: 'Guest changed their mind',
		})
		const after = await openOrders(page, 'open')
		await expect(after.getByText('1 × Buffalo Wings')).toBeVisible()
		await expect(after.getByText('Taken off')).toBeVisible()
		await expect(after.getByText(/Guest changed their mind/)).toBeVisible()
	})

	test('a tab can be emptied only by cancelling it, not by saving nothing', async ({
		demo: page,
	}) => {
		await leaveTab(page)
		const orders = await openOrders(page, 'open')
		await orders.getByRole('button', { name: 'Add items' }).click()
		await cart(page)
			.getByRole('button', { name: 'Fewer Truffle Fries' })
			.click()
		await expect(
			cart(page).getByRole('button', { name: 'Save tab' }),
		).toBeDisabled()
	})
})
