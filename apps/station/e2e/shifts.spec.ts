import {
	backend,
	cart,
	expect,
	openCategory,
	addQuick,
	pairUi,
	payExactCash,
	test,
	trapPrint,
	typeKeypad,
} from './helpers.ts'

test.describe('cash drawer shifts', () => {
	test('a till that needs a shift will not sell until one is open; the close shows over or short and prints a Z report', async ({
		unpaired: page,
	}) => {
		await pairUi(page, { shiftsRequired: true })
		await expect(
			page.getByRole('button', { name: /No shift is open/ }),
		).toBeVisible()

		// Trying to sell opens the drawer instead.
		await openCategory(page, 'Starters')
		await addQuick(page, 'Truffle Fries')
		await cart(page)
			.getByRole('button', { name: /^Charge/ })
			.click()
		const open = page.getByRole('dialog', { name: 'Open a shift' })
		await expect(open).toBeVisible()
		await typeKeypad(open, '10000')
		await open.getByRole('button', { name: 'Open shift with $100.00' }).click()
		await expect(
			page.getByRole('button', { name: /No shift is open/ }),
		).toHaveCount(0)
		// The sheet now shows the open shift; close it and take the sale.
		await page
			.getByRole('dialog', { name: 'Shift' })
			.getByRole('button', { name: 'Close' })
			.first()
			.click()
		await payExactCash(page) // $8.12 in cash

		// $5.00 taken out for ice.
		await page.getByRole('button', { name: 'Shift (open)' }).click()
		const shift = page.getByRole('dialog', { name: 'Shift' })
		await shift.getByRole('button', { name: 'Cash out' }).click()
		const out = page.getByRole('dialog', { name: 'Take cash out' })
		await typeKeypad(out, '500')
		await out.getByLabel('What is it for?').fill('Ice from the shop')
		await out.getByRole('button', { name: 'Record $5.00 out' }).click()

		// Expected: 100.00 + 8.12 - 5.00 = 103.12. Counted 103.00: 12 cents short.
		await page
			.getByRole('dialog', { name: 'Shift' })
			.getByRole('button', { name: 'Close shift' })
			.click()
		const close = page.getByRole('dialog', { name: 'Close the shift' })
		await expect(close.getByText('103.12')).toHaveCount(0) // a blind count: the expected figure is not shown
		await typeKeypad(close, '10300')
		await close.getByRole('button', { name: 'Close shift' }).click()
		const closed = page.getByRole('dialog', { name: 'Shift closed' })
		await expect(closed.getByRole('status')).toContainText('Short')
		await expect(closed.getByRole('status')).toContainText('$0.12')
		const prints = await trapPrint(page)
		await closed.getByRole('button', { name: 'Print Z report' }).click()
		expect(await prints()).toBe(1)
		await expect(page.locator('#receipt')).toContainText('Z report')

		await expect
			.poll(async () => (await backend.shifts())[0]?.shift.status, {
				timeout: 15_000,
			})
			.toBe('closed')
		const [stored] = await backend.shifts()
		expect(stored!.shift).toMatchObject({
			countedCashCents: 10_300,
			tillExpectedCashCents: 10_312,
		})
		expect(stored!.shift.movements).toEqual([
			expect.objectContaining({
				kind: 'pay_out',
				amountCents: 500,
				note: 'Ice from the shop',
			}),
		])
		expect(stored!.summary.cash.expectedCents).toBe(10_312)
		expect(stored!.overShortCents).toBe(-12)
	})
})
