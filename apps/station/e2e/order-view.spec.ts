import {
	addQuick,
	cart,
	dialog,
	expect,
	fillCart,
	openCategory,
	openOrders,
	startCharge,
	test,
} from './helpers.ts'

test.describe('order presentation', () => {
	test('cash readouts always place the label above the value', async ({
		demo: page,
	}) => {
		await fillCart(page)
		const payment = await startCharge(page)
		for (const label of ['Paying now', 'Cash received']) {
			const readout = payment.getByRole('button', {
				name: new RegExp(`^${label}`),
			})
			const geometry = await readout.evaluate((element) => {
				const [labelElement, valueElement] = element.querySelectorAll('span')
				return {
					labelBottom: labelElement!.getBoundingClientRect().bottom,
					valueTop: valueElement!.getBoundingClientRect().top,
				}
			})
			expect(geometry.valueTop).toBeGreaterThanOrEqual(geometry.labelBottom)
		}
	})

	test('an added menu item has one border, not an overlapping selection ring', async ({
		demo: page,
	}) => {
		await fillCart(page, 1)
		const item = page.getByRole('button', { name: /^Truffle Fries,/ })
		await item.hover()
		expect(
			await item.evaluate((element) => getComputedStyle(element).boxShadow),
		).toBe('none')
	})

	test('bill amounts use the interface font, not slashed-zero monospace', async ({
		demo: page,
	}) => {
		await fillCart(page, 1)
		const payment = await startCharge(page)
		const bill = payment.getByRole('region', { name: 'Bill' })
		const price = bill.getByText('$7.50', { exact: true }).first()
		expect(
			await price.evaluate((element) => getComputedStyle(element).fontFamily),
		).toBe(
			await bill.evaluate((element) => getComputedStyle(element).fontFamily),
		)
	})

	test('Orders has a searchable list and a separate detail region with reachable actions', async ({
		demo: page,
	}) => {
		await fillCart(page, 1)
		await cart(page).getByRole('button', { name: 'Pay later' }).click()
		await fillCart(page, 2)
		await cart(page).getByRole('button', { name: 'Pay later' }).click()
		const orders = await openOrders(page)
		await expect.poll(async () => (await orders.boundingBox())?.y).toBe(0)
		const bounds = await orders.boundingBox()
		expect(bounds!.height).toBe(page.viewportSize()!.height)
		const filterLabel = await orders
			.getByRole('radio', { name: /^Open tabs/ })
			.getByText('Open tabs · 2', { exact: true })
			.boundingBox()
		expect(filterLabel!.height).toBeLessThanOrEqual(24)
		const search = orders.getByRole('searchbox', { name: 'Search orders' })
		await search.fill('T1-0002')
		await expect(orders.getByRole('button', { name: /#T1-0001/ })).toHaveCount(
			0,
		)
		const details = orders.getByRole('region', { name: 'Order details' })
		await expect(
			details.getByRole('heading', { name: '#T1-0002' }),
		).toBeVisible()
		await expect(
			details.getByRole('button', { name: /^Pay / }),
		).toBeInViewport()
	})

	test('phone order details keep their actions visible while the bill scrolls', async ({
		demo: page,
	}) => {
		await openCategory(page, 'Starters')
		for (const name of ['Truffle Fries', 'Buffalo Wings', 'Tomato Soup'])
			await addQuick(page, name)
		await openCategory(page, 'Drinks')
		await addQuick(page, 'Sparkling Water')
		await cart(page).getByRole('button', { name: 'Pay later' }).click()
		await page.setViewportSize({ width: 390, height: 700 })
		const orders = await openOrders(page)
		await orders.getByRole('button', { name: /#T1-0001/ }).click()
		const details = orders.getByRole('region', { name: 'Order details' })
		await details
			.getByText('1 × Sparkling Water', { exact: true })
			.scrollIntoViewIfNeeded()
		await expect(
			details.getByRole('button', { name: /^Pay / }),
		).toBeInViewport()
		expect(
			await dialog(page).evaluate(
				(element) => element.scrollWidth <= element.clientWidth,
			),
		).toBe(true)
	})
})
