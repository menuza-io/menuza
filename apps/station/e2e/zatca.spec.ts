import {
	addQuick,
	backend,
	confirmButton,
	dialog,
	expect,
	openCategory,
	startCharge,
	test,
	trapPrint,
} from './helpers.ts'

test.describe('ZATCA e-invoicing on the till', () => {
	test('an onboarded terminal signs each sale, prints the Phase 2 QR, and the server reports it', async ({
		paired: page,
	}) => {
		// A Saudi location: riyals, VAT 15% included in the menu prices.
		await backend.location({
			currency: 'SAR',
			taxRate: 15,
			taxInclusive: true,
			vatNumber: '399999999900003',
		})
		await backend.zatca()
		// The till learns it is a unit when it next checks in (going online does that).
		await page.context().setOffline(true)
		await page.context().setOffline(false)
		await page.getByRole('button', { name: 'Refresh menu' }).click()
		await expect
			.poll(
				() =>
					page.evaluate(async () => {
						const open = indexedDB.open('pos')
						const db = await new Promise<IDBDatabase>(
							(resolve) => (open.onsuccess = () => resolve(open.result)),
						)
						const row = await new Promise<unknown>((resolve) => {
							const request = db
								.transaction('meta')
								.objectStore('meta')
								.get('zatca:unit')
							request.onsuccess = () => resolve(request.result)
						})
						db.close()
						return Boolean(row)
					}),
				{ timeout: 15_000 },
			)
			.toBe(true)

		const prints = await trapPrint(page)
		await openCategory(page, 'Starters')
		await addQuick(page, 'Truffle Fries')
		const sheet = await startCharge(page)
		await expect(sheet.getByText('Includes tax')).toBeVisible()
		await confirmButton(sheet).click()
		await dialog(page).getByRole('button', { name: 'Receipt' }).click()
		expect(await prints()).toBe(1)
		const receipt = page.locator('#receipt')
		await expect(receipt).toContainText('Simplified tax invoice')
		await expect(receipt).toContainText(/Invoice T1-0001-\d{8}/)
		await expect(receipt.locator('img')).toHaveAttribute(
			'src',
			/^data:image\/png/,
		)
		await dialog(page).getByRole('button', { name: 'New order' }).click()

		await expect
			.poll(async () => (await backend.zatcaSubmissions())[0]?.status, {
				timeout: 20_000,
			})
			.toBe('reported')
		expect((await backend.zatcaSubmissions())[0]).toMatchObject({
			kind: 'invoice',
			counter: 1,
		})
	})
})
