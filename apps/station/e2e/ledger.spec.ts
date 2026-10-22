import {
	ANA,
	LINA,
	addQuick,
	backend,
	cart,
	dialog,
	expect,
	giveReason,
	openCategory,
	openOrders,
	pairLocked,
	signInWithPin,
	startCharge,
	confirmButton,
	test,
	trapPrint,
	typeKeypad,
} from './helpers.ts'

test.describe('nothing comes off a bill without a trace', () => {
	test('a cashier takes an item off a saved tab: a manager approves, and the server keeps who, why and who approved', async ({
		unpaired: page,
	}) => {
		await pairLocked(page)
		await signInWithPin(page, ANA.pin)
		await openCategory(page, 'Starters')
		await addQuick(page, 'Truffle Fries')
		await addQuick(page, 'Buffalo Wings')
		await cart(page).getByRole('button', { name: 'Pay later' }).click()
		const orders = await openOrders(page, 'open')
		await orders.getByRole('button', { name: 'Add items' }).click()
		await cart(page).getByText('Remove').first().click()
		await cart(page).getByRole('button', { name: 'Save tab' }).click()

		const sheet = page.getByRole('dialog', { name: 'Take items off this tab?' })
		await sheet.getByRole('button', { name: 'Out of stock' }).click()
		// A cashier cannot confirm alone, and a cashier's PIN does not approve.
		await expect(
			sheet.getByRole('button', { name: 'Take them off' }),
		).toBeDisabled()
		await typeKeypad(sheet, ANA.pin)
		await sheet.getByRole('button', { name: 'Approve' }).click()
		await expect(sheet.getByText(/is not a manager/)).toBeVisible()
		await giveReason(page, {
			title: 'Take items off this tab?',
			confirm: 'Take them off',
			reason: 'Out of stock',
			managerPin: LINA.pin,
		})

		await expect
			.poll(async () => (await backend.orders())[0]?.lineVoids?.length ?? 0, {
				timeout: 15_000,
			})
			.toBe(1)
		const [order] = await backend.orders()
		expect(order!.lineVoids![0]).toMatchObject({
			name: 'Truffle Fries',
			quantity: 1,
			reason: 'out_of_stock',
			by: { name: ANA.name },
			approvedBy: { name: LINA.name },
		})
		// Still signed in as the cashier: approving does not switch who is at the till.
		await expect(
			page.getByRole('button', { name: /signed in as Ana K\./ }),
		).toBeVisible()
	})
})

test.describe('refunds', () => {
	test('a card sale with its approval code is refunded in full, with a reason, and the server records both', async ({
		paired: page,
	}) => {
		await openCategory(page, 'Starters')
		await addQuick(page, 'Truffle Fries')
		const sheet = await startCharge(page)
		await sheet.getByRole('radio', { name: 'Card' }).click()
		await sheet
			.getByLabel('Approval code from the card terminal (optional)')
			.fill('AUTH 4411')
		await confirmButton(sheet).click()
		await dialog(page).getByRole('button', { name: 'New order' }).click()
		await expect
			.poll(
				async () => (await backend.orders())[0]?.payments[0]?.reference ?? null,
				{ timeout: 15_000 },
			)
			.toBe('AUTH 4411')

		const orders = await openOrders(page, 'today')
		await orders.getByRole('button', { name: 'Refund', exact: true }).click()
		const refund = page.getByRole('dialog', { name: /^Refund #/ })
		// The amount starts empty; "Full amount" fills it, and it cannot go without a reason.
		await refund.getByRole('button', { name: /^Full amount/ }).click()
		await expect(
			refund.getByRole('button', { name: /^Refund \$/ }),
		).toBeDisabled()
		await giveReason(page, {
			title: /^Refund #/,
			confirm: /^Refund \$/,
			reason: 'Problem with the food',
		})
		await expect(
			orders.getByText('Refunded', { exact: true }).first(),
		).toBeVisible()

		await expect
			.poll(async () => (await backend.orders())[0]?.status, {
				timeout: 15_000,
			})
			.toBe('refunded')
		const [order] = await backend.orders()
		expect(order!.refunds).toMatchObject([
			{ method: 'card', amountCents: order!.totalCents, reason: 'quality' },
		])
		expect(order!.reviewReason).toBeNull()
	})

	test('a refund for part of the bill keeps the sale paid, and only the rest can still go back', async ({
		demo: page,
	}) => {
		await openCategory(page, 'Starters')
		await addQuick(page, 'Truffle Fries')
		await addQuick(page, 'Truffle Fries')
		const sheet = await startCharge(page)
		await confirmButton(sheet).click()
		await dialog(page).getByRole('button', { name: 'New order' }).click()
		const orders = await openOrders(page, 'today')
		await orders.getByRole('button', { name: 'Refund', exact: true }).click()
		const refund = page.getByRole('dialog', { name: /^Refund #/ })
		await refund
			.getByRole('group', { name: 'Keypad' })
			.getByRole('button', { name: 'Clear' })
			.click()
		await typeKeypad(refund, '500')
		await giveReason(page, {
			title: /^Refund #/,
			confirm: 'Refund $5.00',
			reason: 'Charged the wrong amount',
		})
		await expect(orders.getByText('Part refunded').first()).toBeVisible()
		await orders.getByRole('button', { name: 'Refund', exact: true }).click()
		await expect(
			page
				.getByRole('dialog', { name: /^Refund #/ })
				.getByText(/up to \$11\.24/),
		).toBeVisible()
	})
})

test.describe('simplified tax invoice', () => {
	test('with a VAT number, the receipt shows it, the invoice number and the ZATCA QR code', async ({
		paired: page,
	}) => {
		await backend.location({
			vatNumber: '310122393500003',
			taxInclusive: true,
			taxRate: 15,
		})
		await page.getByRole('button', { name: 'Refresh menu' }).click()
		const prints = await trapPrint(page)
		await openCategory(page, 'Starters')
		await addQuick(page, 'Truffle Fries')
		const sheet = await startCharge(page)
		// The price already includes VAT: nothing is added on top.
		await expect(sheet.getByText('Includes tax')).toBeVisible()
		await confirmButton(sheet).click()
		await dialog(page).getByRole('button', { name: 'Receipt' }).click()
		expect(await prints()).toBe(1)
		const receipt = page.locator('#receipt')
		await expect(receipt).toContainText('VAT No. 310122393500003')
		await expect(receipt).toContainText('Simplified tax invoice')
		await expect(receipt).toContainText('Invoice 1')
		await expect(receipt.locator('img')).toHaveAttribute(
			'src',
			/^data:image\/png/,
		)
	})
})
