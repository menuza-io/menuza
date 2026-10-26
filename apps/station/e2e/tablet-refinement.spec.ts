import {
	cart,
	closeDialog,
	expect,
	fillCart,
	openItem,
	selectStationApp,
	startCharge,
	test,
} from './helpers.ts'

test('tablet portrait keeps the menu and current order usable together', async ({
	demo: page,
}) => {
	for (const width of [768, 820, 1180]) {
		await page.setViewportSize({ width, height: 1024 })
		await expect(cart(page)).toBeVisible()
		await expect(
			page.getByRole('searchbox', { name: 'Search the menu' }),
		).toBeVisible()
		await fillCart(page, 1)
		const edit = cart(page).getByRole('button', { name: 'Edit Truffle Fries' })
		await expect(edit).toBeVisible()
		const box = await edit.boundingBox()
		expect(box!.height).toBeGreaterThanOrEqual(44)
		expect(box!.width).toBeGreaterThanOrEqual(44)
		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= innerWidth,
			),
		).toBe(true)
	}
})

test('task sheets restore focus on Escape, explicit close, and nested completion', async ({
	demo: page,
}) => {
	const settings = page.getByRole('button', { name: 'Settings', exact: true })
	await settings.click()
	await page.keyboard.press('Escape')
	await expect(settings).toBeFocused()
	await openItem(page, 'Smash Burger')
	await closeDialog(page)
	await expect(
		page.getByRole('button', { name: /^Smash Burger,/ }),
	).toBeFocused()
	await fillCart(page, 1)
	await startCharge(page)
	await page.keyboard.press('Escape')
	await expect(
		cart(page).getByRole('button', { name: /^Charge/ }),
	).toBeFocused()
	await cart(page)
		.getByRole('button', { name: 'Add table', exact: true })
		.click()
	const name = page.getByRole('dialog', { name: 'Table', exact: true })
	await name.getByRole('textbox').fill('Patio 3')
	await name.getByRole('button', { name: 'Done', exact: true }).click()
	await expect(
		cart(page).getByRole('button', { name: 'Table: Patio 3' }),
	).toBeFocused()
})

test('paired settings keep connection details available without crowding daily controls', async ({
	paired: page,
}) => {
	await page.getByRole('button', { name: 'Settings', exact: true }).click()
	const sheet = page.getByRole('dialog', { name: 'Terminal settings' })
	const details = sheet.locator('details')
	await expect(details).not.toHaveAttribute('open')
	await expect(sheet.getByText(/^Paired as/)).toBeVisible()
	await details.locator('summary').click()
	await expect(sheet.getByLabel('App URL', { exact: false })).toBeVisible()
	await expect(
		sheet.getByLabel('Orders server URL', { exact: false }),
	).toBeVisible()
	await closeDialog(page)
})

test('Kitchen retains three readable lanes in tablet portrait', async ({
	demo: page,
}) => {
	await page.setViewportSize({ width: 820, height: 1180 })
	await selectStationApp(page, 'Kitchen')
	const lanes = page.locator('.kitchen-lane')
	await expect(lanes).toHaveCount(3)
	const boxes = await lanes.evaluateAll((nodes) =>
		nodes.map((node) => {
			const r = node.getBoundingClientRect()
			return { x: r.x, y: r.y, width: r.width }
		}),
	)
	expect(boxes[0]!.x).toBeLessThan(boxes[1]!.x)
	expect(boxes[1]!.x).toBeLessThan(boxes[2]!.x)
	expect(boxes.every((b) => b.width >= 230 && b.y === boxes[0]!.y)).toBe(true)
})

test('the host date remains readable and tappable on narrow English and Arabic screens', async ({
	demo: page,
}) => {
	for (const locale of ['en', 'ar']) {
		await page.evaluate((locale) => {
			const key = 'pos.settings.v1'
			const settings = JSON.parse(localStorage.getItem(key) ?? '{}')
			localStorage.setItem(
				key,
				JSON.stringify({
					...settings,
					locale,
					activeApp: 'reservations',
					apps: { timeclock: true, reservations: true },
				}),
			)
		}, locale)
		await page.reload()
		await expect(page.locator('.bk-header')).toBeVisible()
		for (const width of [320, 390]) {
			await page.setViewportSize({ width, height: 844 })
			const date = page.locator('.bk-date input')
			const box = await date.boundingBox()
			expect(box!.width).toBeGreaterThanOrEqual(44)
			expect(box!.height).toBeGreaterThanOrEqual(44)
			expect(
				await page
					.locator('.bk-date-short')
					.evaluate((label) => label.scrollWidth <= label.clientWidth),
			).toBe(true)
			expect(
				await page.evaluate(
					() => document.documentElement.scrollWidth <= innerWidth,
				),
			).toBe(true)
		}
		const tabs = page.locator('.bk-tabs').first()
		await tabs.getByRole('radio').first().focus()
		await page.keyboard.press('End')
		await expect(tabs.getByRole('radio').last()).toBeFocused()
		await page.keyboard.press('Home')
		await expect(tabs.getByRole('radio').first()).toBeFocused()
	}
})
