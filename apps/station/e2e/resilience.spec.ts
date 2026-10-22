import { type Locator } from '@playwright/test'
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
	openItem,
	openOrders,
	payExactCash,
	sellFries,
	startCharge,
	test,
} from './helpers.ts'

test.describe('resilience', () => {
	test('a full shift of activity raises no console errors or crashes', async ({
		paired: page,
	}) => {
		const problems: string[] = []
		page.on('pageerror', (error) =>
			problems.push(`pageerror: ${error.message}`),
		)
		page.on('console', (message) => {
			if (message.type() === 'error')
				problems.push(`console: ${message.text()}`)
		})
		await sellFries(page)
		await openCategory(page, 'Starters')
		await addQuick(page, 'Buffalo Wings')
		await cart(page).getByRole('button', { name: 'Pay later' }).click()
		const orders = await openOrders(page, 'open')
		await orders.getByRole('button', { name: /^Pay / }).click()
		const sheet = dialog(page)
		await sheet.getByRole('button', { name: 'Split 2' }).click()
		await confirmButton(sheet).click()
		await confirmButton(sheet).click()
		await dialog(page).getByRole('button', { name: 'New order' }).click()
		await page.getByRole('button', { name: 'Refresh menu' }).click()
		await expectStored(2)
		expect(problems).toEqual([])
	})

	test('corrupt saved settings do not brick the till: it starts at setup', async ({
		page,
		context,
	}) => {
		await context.addInitScript(() =>
			localStorage.setItem('pos.settings.v1', '{not json'),
		)
		await page.goto('/')
		await expect(
			page.getByRole('heading', { name: 'Set up this terminal' }),
		).toBeVisible()
	})

	test('hostile text is shown as text and stored as text', async ({
		paired: page,
	}) => {
		const evil =
			'"><img src=x onerror="window.__xss=1"><script>window.__xss=2</script>'
		const sheet = await openItem(page, 'Smash Burger')
		await sheet.getByPlaceholder(/Allergies/).fill(evil)
		await sheet.getByRole('button', { name: /^Add ·/ }).click()
		await cart(page)
			.getByRole('button', { name: /Add table/ })
			.click()
		await dialog(page)
			.getByPlaceholder(/e\.g\. 12/)
			.fill('<b>9</b>')
		await dialog(page).getByRole('button', { name: 'Done' }).click()
		await expect(cart(page).getByText(`“${evil}”`)).toBeVisible()
		await payExactCash(page)
		const [order] = await expectStored(1)
		expect(order!.lines[0]!.instructions).toBe(evil.slice(0, 280))
		expect(order!.tableLabel).toBe('<b>9</b>')
		expect(
			await page.evaluate(
				() => (window as unknown as { __xss?: number }).__xss,
			),
		).toBeUndefined()
		const orders = await openOrders(page, 'today')
		await expect(orders.getByText('Table <b>9</b>').first()).toBeVisible()
	})

	test('kitchen notes keep non-English text, emoji and are capped at 280 characters', async ({
		paired: page,
	}) => {
		const sheet = await openItem(page, 'Smash Burger')
		const note = 'بدون بصل 🌶️ sin cebolla — 少辣'
		await sheet.getByPlaceholder(/Allergies/).fill(note)
		await sheet.getByRole('button', { name: /^Add ·/ }).click()
		await expect(cart(page).getByText(`“${note}”`)).toBeVisible()
		await cart(page).getByRole('button', { name: 'Edit Smash Burger' }).click()
		await dialog(page)
			.getByPlaceholder(/Allergies/)
			.fill('x'.repeat(400))
		await expect(dialog(page).getByPlaceholder(/Allergies/)).toHaveValue(
			'x'.repeat(280),
		)
		await dialog(page)
			.getByRole('button', { name: /^Update ·/ })
			.click()
		await payExactCash(page)
		const [order] = await expectStored(1)
		expect(order!.lines[0]!.instructions).toHaveLength(280)
	})

	test('quantity is capped at 50 per line', async ({ demo: page }) => {
		const sheet = await openItem(page, 'Smash Burger')
		for (let i = 0; i < 60; i++)
			await sheet
				.getByRole('button', { name: 'More' })
				.click({ noWaitAfter: true })
		await expect(sheet.getByText('50', { exact: true })).toBeVisible()
		await expect(sheet.getByRole('button', { name: 'More' })).toBeEnabled() // clamps rather than errors
		await expect(
			sheet.getByRole('button', { name: 'Add · $675.00' }),
		).toBeVisible()
	})

	test('a late service stays on one business day; numbers restart at the turnover (04:00), not at midnight', async ({
		paired: page,
	}) => {
		await page.clock.install({
			time: new Date(
				'2026-10-21T23:58:00-04:00',
			) /* 23:58 in the restaurant's zone, whatever the laptop's */,
		})
		await sellFries(page) // T1-0001, 21 Oct
		await openCategory(page, 'Starters')
		await addQuick(page, 'Buffalo Wings')
		await cart(page).getByRole('button', { name: 'Pay later' }).click() // T1-0002, 21 Oct, left open
		await expectStored(2)

		// After midnight, still the same service: the numbers carry on.
		await page.clock.setSystemTime(new Date('2026-10-22T00:10:00-04:00'))
		await sellFries(page) // T1-0003, still 21 Oct
		// After the turnover, a new business day.
		await page.clock.setSystemTime(new Date('2026-10-22T04:10:00-04:00'))
		await sellFries(page) // T1-0001, 22 Oct
		const stored = await expectStored(4)
		const byNumber = stored.map((o) => `${o.number} ${o.businessDate}`).sort()
		expect(byNumber).toEqual([
			'T1-0001 2026-10-21',
			'T1-0001 2026-10-22',
			'T1-0002 2026-10-21',
			'T1-0003 2026-10-21',
		])
		const status = new Map(stored.map((o) => [o.id, o.status]))
		expect([...status.values()].sort()).toEqual([
			'open',
			'paid',
			'paid',
			'paid',
		])
		expect((await backend.requests()).filter((r) => r.status === 409)).toEqual(
			[],
		)

		// "Today" shows only today's sale; the open tab from yesterday is still there to settle.
		const sheet = await openOrders(page, 'today')
		await expect(sheet.getByRole('radio', { name: 'Today · 1' })).toBeVisible()
		await sheet.getByRole('radio', { name: /^Open tabs · 1/ }).click()
		await expect(sheet.getByText('1 × Buffalo Wings')).toBeVisible()
	})

	test('rapid tapping on the keypad and chips never produces an invalid payment', async ({
		demo: page,
	}) => {
		await fillCart(page)
		const sheet = await startCharge(page)
		const keypad = sheet.getByRole('group', { name: 'Keypad' })
		for (let i = 0; i < 12; i++)
			await keypad
				.getByRole('button', { name: '9', exact: true })
				.click({ noWaitAfter: true })
		await expect(
			sheet.getByRole('button', { name: /^Cash received/ }),
		).toContainText('$')
		await sheet.getByRole('button', { name: 'Split 4' }).click()
		await sheet.getByRole('button', { name: 'Split 2' }).click()
		await sheet.getByRole('button', { name: 'Amount' }).click()
		await sheet.getByRole('button', { name: 'Full · $16.24' }).click()
		await expect(
			sheet.getByRole('button', { name: /^Paying now/ }),
		).toContainText('$16.24')
	})

	test('a second browser tab on the same till shares the saved orders', async ({
		paired: page,
		context,
	}) => {
		await sellFries(page)
		const other = await context.newPage()
		await other.goto('/')
		await expect(
			other.getByRole('heading', { name: 'Demo Kitchen' }),
		).toBeVisible()
		const orders = await openOrders(other, 'today')
		await expect(orders.getByText('#T1-0001').first()).toBeVisible()
		await orders.getByRole('button', { name: 'Close' }).click()
		// Selling from both tabs never reuses a number.
		await sellFries(other)
		await sellFries(page)
		const stored = await expectStored(3)
		expect(new Set(stored.map((o) => o.number)).size).toBe(3)
	})

	test('two tabs flushing the queue at once send each order once', async ({
		paired: page,
		context,
		browser,
	}) => {
		void browser
		await backend.outage(503)
		await sellFries(page)
		await sellFries(page)
		const other = await context.newPage()
		await other.goto('/')
		await expect(
			other.getByRole('heading', { name: 'Demo Kitchen' }),
		).toBeVisible()
		await backend.clearOutage()
		// Whichever tab sends first makes the other's button go away: that is the
		// race under test, so a click that finds nothing left to send is fine.
		const sendNow = (sheet: Locator) =>
			sheet
				.getByRole('button', { name: 'Send now' })
				.first()
				.click({ timeout: 5_000 })
				.catch(() => undefined)
		await Promise.all([
			openOrders(page, 'today').then(sendNow),
			openOrders(other, 'today').then(sendNow),
		])
		const stored = await expectStored(2)
		expect(new Set(stored.map((o) => o.id)).size).toBe(2)
		const created = (await backend.requests()).filter(
			(r) => r.path === '/pos/orders' && r.status === 201,
		)
		expect(created).toHaveLength(2)
	})

	test('sold-out items never enter an order even if a stale card is tapped', async ({
		demo: page,
	}) => {
		await menuItem(page, 'Smoked Ribs').click({ force: true })
		await expect(page.getByText('No items yet')).toBeVisible()
	})

	test('the orders list copes with a busy day (60 orders)', async ({
		demo: page,
	}) => {
		await page.evaluate(async () => {
			const open = indexedDB.open('pos')
			await new Promise<void>((resolve, reject) => {
				open.onsuccess = () => {
					const db = open.result
					const tx = db.transaction('orders', 'readwrite')
					const store = tx.objectStore('orders')
					const now = Date.now()
					const d = new Date(now)
					const businessDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
					for (let i = 0; i < 60; i++) {
						store.put({
							id: crypto.randomUUID(),
							number: `T1-${String(i + 1).padStart(4, '0')}`,
							businessDate,
							createdAt: now - i * 1000,
							orderType: 'dine_in',
							customerName: '',
							tableLabel: String(i),
							locationId: 'loc-1',
							currency: 'USD',
							taxRatePercent: 8.25,
							lines: [
								{
									id: 'l',
									itemId: 'i-fries',
									name: 'Truffle Fries',
									variantId: null,
									variantLabel: null,
									quantity: 1,
									baseCents: 750,
									instructions: '',
									options: [],
								},
							],
							adjustments: [],
							totals: {
								subtotalCents: 750,
								adjustmentCents: 0,
								taxCents: 62,
								tipCents: 0,
								totalCents: 812,
							},
							status: 'paid',
							payments: [
								{
									id: crypto.randomUUID(),
									method: 'cash',
									amountCents: 812,
									tenderedCents: 812,
									changeCents: 0,
									at: now,
								},
							],
							revision: 1,
							updatedAt: now,
							sync: 'synced',
							attempts: 0,
							nextAttemptAt: 0,
							lastError: null,
							syncedAt: now,
							serverNumber: null,
						})
					}
					tx.oncomplete = () => resolve()
					tx.onerror = () => reject(tx.error)
				}
				open.onerror = () => reject(open.error)
			})
		})
		await page.reload()
		const orders = await openOrders(page, 'today')
		await expect(
			orders.getByRole('radio', { name: 'Today · 60' }),
		).toBeVisible()
		await expect(orders.getByText('$487.20')).toBeVisible() // 60 × $8.12
	})
})
