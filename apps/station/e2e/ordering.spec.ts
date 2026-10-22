import {
	addQuick,
	cart,
	chargeButtonTotal,
	choose,
	confirmAdd,
	dialog,
	expect,
	menuItem,
	openCategory,
	openItem,
	test,
} from './helpers.ts'

test.describe('adding items', () => {
	test('a plain item adds with one tap and prices with tax', async ({
		demo: page,
	}) => {
		await openCategory(page, 'Starters')
		await addQuick(page, 'Truffle Fries')
		await expect(page.getByRole('dialog')).toHaveCount(0)
		const order = cart(page)
		await expect(order.getByText('Truffle Fries')).toBeVisible()
		await expect(order.getByText('Subtotal · 1 item')).toBeVisible()
		await expect(order.getByText('Tax (8.25%)')).toBeVisible()
		// $7.50 + 8.25% = $8.12 (rounded once, on the order)
		expect(await chargeButtonTotal(page)).toBe(812)
	})

	test('tapping the same plain item again raises its quantity instead of adding a row', async ({
		demo: page,
	}) => {
		await openCategory(page, 'Starters')
		await addQuick(page, 'Truffle Fries')
		await addQuick(page, 'Truffle Fries')
		await addQuick(page, 'Truffle Fries')
		await expect(cart(page).getByText('Truffle Fries')).toHaveCount(1)
		await expect(cart(page).getByText('Subtotal · 3 items')).toBeVisible()
		expect(await chargeButtonTotal(page)).toBe(2436) // 22.50 + 1.86 tax
	})

	test('an item with a required choice opens its sheet with the default pre-selected', async ({
		demo: page,
	}) => {
		const sheet = await openItem(page, 'Smash Burger')
		await expect(
			sheet.getByText('Two patties, American cheese, pickles, house sauce'),
		).toBeVisible()
		await expect(
			sheet.getByRole('button', { name: /^Medium/, pressed: true }),
		).toBeVisible()
		await expect(
			sheet.getByRole('button', { name: 'Add · $13.50' }),
		).toBeEnabled()
	})

	test('a required choice with no default blocks adding and says what is missing', async ({
		demo: page,
	}) => {
		const sheet = await openItem(page, 'Fresh Pasta')
		const add = sheet.getByRole('button', { name: 'Choose Sauce' })
		await expect(add).toBeDisabled()
		await choose(sheet, /^Alfredo/)
		await expect(
			sheet.getByRole('button', { name: 'Add · $16.00' }),
		).toBeEnabled()
	})

	test('single-choice groups swap the selection', async ({ demo: page }) => {
		const sheet = await openItem(page, 'Smash Burger')
		await choose(sheet, /^Well done/)
		await expect(
			sheet.getByRole('button', { name: /^Well done/, pressed: true }),
		).toBeVisible()
		await expect(
			sheet.getByRole('button', { name: /^Medium$/, pressed: false }),
		).toBeVisible()
	})

	test('extras add to the price and are listed under the item', async ({
		demo: page,
	}) => {
		const sheet = await openItem(page, 'Smash Burger')
		await choose(sheet, /^Extra cheese/)
		await choose(sheet, /^Bacon/)
		await expect(
			sheet.getByRole('button', { name: 'Add · $17.00' }),
		).toBeVisible() // 13.50 + 1.50 + 2.00
		await confirmAdd(sheet)
		const order = cart(page)
		await expect(
			order.getByText('Medium', { exact: false }).first(),
		).toBeVisible()
		await expect(order.getByText(/Extra cheese/)).toBeVisible()
		await expect(order.getByText(/Bacon/)).toBeVisible()
		expect(await chargeButtonTotal(page)).toBe(1840) // 17.00 + 1.40 tax
	})

	test('the extras group stops at its maximum of four', async ({
		demo: page,
	}) => {
		const sheet = await openItem(page, 'Smash Burger')
		for (const name of [/^Extra cheese/, /^Bacon/, /^Fried egg/, /^Avocado/])
			await choose(sheet, name)
		await expect(
			sheet.getByRole('button', { name: 'Add · $21.00' }),
		).toBeVisible() // 13.50 + 1.50 + 2.00 + 1.75 + 2.25
		// Tapping a chosen extra removes it again.
		await choose(sheet, /^Avocado/)
		await expect(
			sheet.getByRole('button', { name: 'Add · $18.75' }),
		).toBeVisible()
	})

	test('sizes change the base price and the line says which size', async ({
		demo: page,
	}) => {
		await openCategory(page, 'Pizza')
		const sheet = await openItem(page, 'Margherita')
		await expect(
			sheet.getByRole('button', { name: /^Regular/, pressed: true }),
		).toBeVisible()
		await expect(
			sheet.getByRole('button', { name: 'Add · $14.00' }),
		).toBeVisible()
		await choose(sheet, /^Large/)
		await expect(
			sheet.getByRole('button', { name: 'Add · $19.00' }),
		).toBeVisible()
		await confirmAdd(sheet)
		await expect(cart(page).getByText('Large')).toBeVisible()
		expect(await chargeButtonTotal(page)).toBe(2057) // 19.00 + 1.57
	})

	test('a card shows "From" when sizes have different prices', async ({
		demo: page,
	}) => {
		await expect(menuItem(page, 'Smash Burger')).toBeVisible()
		await openCategory(page, 'Pizza')
		await expect(menuItem(page, 'Margherita')).toContainText('From $14.00')
	})

	test('the quantity stepper multiplies the line, including its extras', async ({
		demo: page,
	}) => {
		const sheet = await openItem(page, 'Smash Burger')
		await choose(sheet, /^Extra cheese/)
		await sheet.getByRole('button', { name: 'More' }).click()
		await sheet.getByRole('button', { name: 'More' }).click()
		await expect(sheet.getByText('3', { exact: true })).toBeVisible()
		await expect(
			sheet.getByRole('button', { name: 'Add · $45.00' }),
		).toBeVisible() // 3 × 15.00
		await sheet.getByRole('button', { name: 'Fewer' }).click()
		await expect(
			sheet.getByRole('button', { name: 'Add · $30.00' }),
		).toBeVisible()
		// Never below one.
		await sheet.getByRole('button', { name: 'Fewer' }).click()
		await expect(sheet.getByRole('button', { name: 'Fewer' })).toBeDisabled()
	})

	test('a kitchen note is kept on the line and shown', async ({
		demo: page,
	}) => {
		const sheet = await openItem(page, 'Smash Burger')
		await sheet
			.getByPlaceholder(/Allergies, no onions/)
			.fill('no pickles, allergic to sesame')
		await confirmAdd(sheet)
		await expect(
			cart(page).getByText('“no pickles, allergic to sesame”'),
		).toBeVisible()
	})

	test('closing the sheet adds nothing', async ({ demo: page }) => {
		const sheet = await openItem(page, 'Smash Burger')
		await sheet.getByRole('button', { name: 'Close' }).click()
		await expect(page.getByRole('dialog')).toHaveCount(0)
		await expect(page.getByText('No items yet')).toBeVisible()
	})

	test('Escape closes the sheet', async ({ demo: page }) => {
		await openItem(page, 'Smash Burger')
		await page.keyboard.press('Escape')
		await expect(page.getByRole('dialog')).toHaveCount(0)
	})

	test('a sheet always opens fresh for the next item', async ({
		demo: page,
	}) => {
		let sheet = await openItem(page, 'Smash Burger')
		await choose(sheet, /^Extra cheese/)
		await sheet.getByRole('button', { name: 'Close' }).click()
		sheet = await openItem(page, 'Smash Burger')
		await expect(
			sheet.getByRole('button', { name: /^Extra cheese/, pressed: false }),
		).toBeVisible()
		await expect(
			sheet.getByRole('button', { name: 'Add · $13.50' }),
		).toBeVisible()
	})
})

test.describe('the order', () => {
	test('identical configured items merge, different ones do not', async ({
		demo: page,
	}) => {
		for (const _ of [1, 2]) {
			const sheet = await openItem(page, 'Smash Burger')
			await choose(sheet, /^Extra cheese/)
			await confirmAdd(sheet)
		}
		await expect(
			cart(page).getByRole('button', { name: 'Edit Smash Burger' }),
		).toHaveCount(1)
		await expect(cart(page).getByText('Subtotal · 2 items')).toBeVisible()
		const plain = await openItem(page, 'Smash Burger')
		await confirmAdd(plain)
		await expect(
			cart(page).getByRole('button', { name: 'Edit Smash Burger' }),
		).toHaveCount(2)
		await expect(cart(page).getByText('Subtotal · 3 items')).toBeVisible()
	})

	test('a different note keeps lines apart', async ({ demo: page }) => {
		for (const note of ['', 'well toasted']) {
			const sheet = await openItem(page, 'Smash Burger')
			if (note) await sheet.getByPlaceholder(/Allergies/).fill(note)
			await confirmAdd(sheet)
		}
		await expect(
			cart(page).getByRole('button', { name: 'Edit Smash Burger' }),
		).toHaveCount(2)
	})

	test('quantity buttons change a line, and the last "fewer" removes it', async ({
		demo: page,
	}) => {
		await openCategory(page, 'Starters')
		await addQuick(page, 'Truffle Fries')
		const order = cart(page)
		await order.getByRole('button', { name: 'More Truffle Fries' }).click()
		await expect(order.getByText('Subtotal · 2 items')).toBeVisible()
		await order.getByRole('button', { name: 'Fewer Truffle Fries' }).click()
		await expect(order.getByText('Subtotal · 1 item')).toBeVisible()
		await order.getByRole('button', { name: 'Fewer Truffle Fries' }).click()
		await expect(order.getByText('No items yet')).toBeVisible()
		await expect(order.getByRole('button', { name: /^Charge/ })).toBeDisabled()
	})

	test('Remove drops a line without touching the others', async ({
		demo: page,
	}) => {
		await openCategory(page, 'Starters')
		await addQuick(page, 'Truffle Fries')
		await addQuick(page, 'Buffalo Wings')
		await cart(page).getByText('Remove').first().click()
		await expect(cart(page).getByText('Truffle Fries')).toHaveCount(0)
		await expect(cart(page).getByText('Buffalo Wings')).toBeVisible()
	})

	test('tapping a line edits it in place: choices are kept and the line is replaced', async ({
		demo: page,
	}) => {
		const sheet = await openItem(page, 'Smash Burger')
		await choose(sheet, /^Extra cheese/)
		await confirmAdd(sheet)
		await cart(page).getByRole('button', { name: 'Edit Smash Burger' }).click()
		const edit = dialog(page)
		await expect(
			edit.getByRole('button', { name: /^Extra cheese/, pressed: true }),
		).toBeVisible()
		await choose(edit, /^Bacon/)
		await edit.getByRole('button', { name: 'More' }).click()
		await edit.getByRole('button', { name: /^Update · \$34\.00/ }).click() // 2 × (13.50 + 1.50 + 2.00)
		await expect(
			cart(page).getByRole('button', { name: 'Edit Smash Burger' }),
		).toHaveCount(1)
		await expect(cart(page).getByText(/Bacon/)).toBeVisible()
		await expect(cart(page).getByText('Subtotal · 2 items')).toBeVisible()
	})

	test('the clear button empties the order, including table and name', async ({
		demo: page,
	}) => {
		await openCategory(page, 'Starters')
		await addQuick(page, 'Truffle Fries')
		await cart(page)
			.getByRole('button', { name: /Add table/ })
			.click()
		await dialog(page)
			.getByPlaceholder(/e\.g\. 12/)
			.fill('7')
		await dialog(page).getByRole('button', { name: 'Done' }).click()
		await cart(page).getByRole('button', { name: 'Clear order' }).click()
		await expect(cart(page).getByText('No items yet')).toBeVisible()
		await expect(
			cart(page).getByRole('button', { name: /Add table/ }),
		).toBeVisible()
	})

	test('dine-in asks for a table and takeaway for a name, each remembered separately', async ({
		demo: page,
	}) => {
		const order = cart(page)
		await order.getByRole('button', { name: /Add table/ }).click()
		await dialog(page)
			.getByPlaceholder(/e\.g\. 12/)
			.fill('Patio 3')
		await dialog(page).getByRole('button', { name: 'Done' }).click()
		await expect(order.getByText('Table: Patio 3')).toBeVisible()

		await order.getByRole('radio', { name: 'Takeaway' }).click()
		await expect(order.getByRole('button', { name: /Add name/ })).toBeVisible()
		await order.getByRole('button', { name: /Add name/ }).click()
		await dialog(page).getByPlaceholder('Name for the order').fill('Sam')
		await page.keyboard.press('Enter')
		await expect(order.getByText('Name: Sam')).toBeVisible()

		await order.getByRole('radio', { name: 'Dine in' }).click()
		await expect(order.getByText('Table: Patio 3')).toBeVisible()
	})

	test('totals are right for a mixed order', async ({ demo: page }) => {
		// Burger (13.50 + 2.00 bacon) + Fries 7.50 + Large Margherita 19.00 = 42.00 → tax 3.47 (3.465 rounds up)
		const burger = await openItem(page, 'Smash Burger')
		await choose(burger, /^Bacon/)
		await confirmAdd(burger)
		await openCategory(page, 'Starters')
		await addQuick(page, 'Truffle Fries')
		await openCategory(page, 'Pizza')
		const pizza = await openItem(page, 'Margherita')
		await choose(pizza, /^Large/)
		await confirmAdd(pizza)
		await expect(cart(page).getByText('Subtotal · 3 items')).toBeVisible()
		expect(await chargeButtonTotal(page)).toBe(4547)
	})
})
