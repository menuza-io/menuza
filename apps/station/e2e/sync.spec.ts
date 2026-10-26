import { type Page } from '@playwright/test'
import {
	addQuick,
	assertWireContract,
	backend,
	captureUploads,
	cart,
	closeDialog,
	confirmButton,
	dialog,
	expect,
	expectStored,
	fillCart,
	goOffline,
	goOnline,
	openCategory,
	openOrders,
	openPairingLink,
	pairUi,
	payExactCash,
	sellFries,
	startCharge,
	test,
	typeKeypad,
	giveReason,
} from './helpers.ts'

const status = (page: Page, text: string | RegExp) =>
	page.getByText(text).first()

test.describe("orders reach the restaurant's server", () => {
	test('a paid order arrives complete: lines, totals, payment, table', async ({
		paired: page,
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
		await cart(page)
			.getByRole('button', { name: /Add table/ })
			.click()
		await dialog(page)
			.getByPlaceholder(/e\.g\. 12/)
			.fill('21')
		await dialog(page).getByRole('button', { name: 'Done' }).click()
		const sheet = await startCharge(page)
		await typeKeypad(sheet, '5000')
		await confirmButton(sheet).click()
		await dialog(page).getByRole('button', { name: 'New order' }).click()

		const [order] = await expectStored(1)
		expect(order).toMatchObject({
			number: 'T1-0001',
			status: 'paid',
			orderType: 'dine_in',
			tableLabel: '21',
			currency: 'USD',
			reviewReason: null,
			revision: 1,
		})
		// $19.00 large + $1.50 cheese = $20.50; tax 8.25% = $1.69; total $22.19
		expect(order!.subtotalCents).toBe(2050)
		expect(order!.taxCents).toBe(169)
		expect(order!.totalCents).toBe(2219)
		expect(order!.lines).toHaveLength(1)
		expect(order!.lines[0]).toMatchObject({
			name: 'Margherita',
			variantLabel: 'Large',
			instructions: 'well done',
			quantity: 1,
		})
		expect(order!.lines[0]!.options.map((o) => o.optionName)).toContain(
			'Extra cheese',
		)
		// Paid $50.00 cash for a $22.19 bill: the bill is settled for what it cost, not the note.
		expect(order!.payments).toEqual([
			expect.objectContaining({
				method: 'cash',
				amountCents: 2219,
				tenderedCents: 5000,
			}),
		])
	})

	test('each upload carries an idempotency key equal to the order id, and matches the shared contract', async ({
		paired: page,
	}) => {
		const uploads = captureUploads(page)
		await sellFries(page)
		const [stored] = await expectStored(1)
		expect(uploads.length).toBeGreaterThanOrEqual(1)
		for (const upload of uploads) {
			expect(upload.key).toBe(stored!.id)
			assertWireContract(upload.body)
		}
		const requests = (await backend.requests()).filter(
			(r) => r.path === '/pos/orders',
		)
		expect(requests.map((r) => r.status)).toEqual([201])
	})

	test('the till shows it is all sent, and the order is marked sent', async ({
		paired: page,
	}) => {
		await sellFries(page)
		await expectStored(1)
		await expect(status(page, 'Online · all sent')).toBeVisible()
		const orders = await openOrders(page, 'today')
		await expect(orders.getByText('Paid · sent').first()).toBeVisible()
	})

	test("a tab's whole life reaches the server as revisions of one order", async ({
		paired: page,
	}) => {
		await openCategory(page, 'Starters')
		await addQuick(page, 'Truffle Fries')
		await cart(page).getByRole('button', { name: 'Pay later' }).click()
		let [order] = await expectStored(1)
		expect(order).toMatchObject({ status: 'open', revision: 1, payments: [] })
		const id = order!.id

		// Guest orders wings: revision 2, same order.
		let orders = await openOrders(page, 'open')
		await orders.getByRole('button', { name: 'Add items' }).click()
		await addQuick(page, 'Buffalo Wings')
		await cart(page).getByRole('button', { name: 'Save tab' }).click()
		await expect.poll(async () => (await backend.orders())[0]?.revision).toBe(2)
		order = (await backend.orders())[0]!
		expect(order.id).toBe(id)
		expect(order.lines.map((l) => l.name).sort()).toEqual([
			'Buffalo Wings',
			'Truffle Fries',
		])

		// Part paid by card, then the rest in cash.
		orders = await openOrders(page, 'open')
		await orders.getByRole('button', { name: /^Pay / }).click()
		let pay = dialog(page)
		await pay.getByRole('button', { name: 'Split 2' }).click()
		await pay.getByRole('radio', { name: 'Card' }).click()
		await confirmButton(pay).click()
		await expect
			.poll(async () => (await backend.orders())[0]?.payments.length)
			.toBe(1)
		expect((await backend.orders())[0]).toMatchObject({ status: 'open', id })
		await pay.getByRole('radio', { name: 'Cash' }).click()
		await confirmButton(pay).click()
		await expect(
			dialog(page).getByRole('heading', { name: 'Paid' }),
		).toBeVisible()
		await dialog(page).getByRole('button', { name: 'New order' }).click()

		await expect
			.poll(async () => (await backend.orders())[0]?.status)
			.toBe('paid')
		order = (await backend.orders())[0]!
		expect(await backend.orders()).toHaveLength(1)
		expect(order.payments.map((p) => p.method).sort()).toEqual(['card', 'cash'])
		expect(order.payments.reduce((s, p) => s + p.amountCents, 0)).toBe(
			order.totalCents,
		)
		expect(order.id).toBe(id)
	})

	test('a cancelled tab is recorded as cancelled, not forgotten', async ({
		paired: page,
	}) => {
		await openCategory(page, 'Starters')
		await addQuick(page, 'Truffle Fries')
		await cart(page).getByRole('button', { name: 'Pay later' }).click()
		await expectStored(1)
		const orders = await openOrders(page, 'open')
		await orders.getByRole('button', { name: 'Cancel tab' }).click()
		await giveReason(page, {
			title: /^Cancel tab/,
			confirm: /^Cancel the tab$/,
			reason: 'Guest changed their mind',
		})
		await expect
			.poll(async () => (await backend.orders())[0]?.status)
			.toBe('void')
		expect(await backend.orders()).toHaveLength(1)
		expect((await backend.orders())[0]).toMatchObject({
			voidReason: 'guest_request',
		})
	})

	test('split payments are stored one by one, in the right amounts', async ({
		paired: page,
	}) => {
		await fillCart(page)
		const sheet = await startCharge(page)
		await sheet.getByRole('button', { name: 'Split 3' }).click()
		await confirmButton(sheet).click()
		await confirmButton(sheet).click()
		await confirmButton(sheet).click()
		await dialog(page).getByRole('button', { name: 'New order' }).click()
		await expect
			.poll(async () => (await backend.orders())[0]?.payments.length)
			.toBe(3)
		const [order] = await backend.orders()
		expect(order!.status).toBe('paid')
		expect(
			order!.payments.map((p) => p.amountCents).sort((a, b) => a - b),
		).toEqual([540, 542, 542])
		expect(order!.totalCents).toBe(1624)
	})

	test("takeaway orders keep the guest's name", async ({ paired: page }) => {
		await fillCart(page, 1)
		await cart(page).getByRole('radio', { name: 'Takeaway' }).click()
		await cart(page)
			.getByRole('button', { name: /Add name/ })
			.click()
		await dialog(page).getByPlaceholder('Name for the order').fill('Priya')
		await dialog(page).getByRole('button', { name: 'Done' }).click()
		await payExactCash(page)
		const [order] = await expectStored(1)
		expect(order).toMatchObject({ orderType: 'takeaway', guestName: 'Priya' })
	})

	test('tips are recorded on the order', async ({ paired: page }) => {
		await fillCart(page, 1)
		const sheet = await startCharge(page)
		await sheet.getByRole('button', { name: '20%' }).click()
		await confirmButton(sheet).click()
		await dialog(page).getByRole('button', { name: 'New order' }).click()
		const [order] = await expectStored(1)
		expect(order!.tipCents).toBe(150) // 20% of $7.50
		expect(order!.totalCents).toBe(812 + 150)
	})
})

test.describe('offline first', () => {
	test('selling offline: nothing is lost, everything arrives in order when the connection returns', async ({
		paired: page,
		context,
	}) => {
		await goOffline(context, page)
		await expect(status(page, 'Offline · selling normally')).toBeVisible()

		await sellFries(page, 1)
		await expect(status(page, 'Offline · 1 saved')).toBeVisible()
		await sellFries(page, 2)
		// A tab opened offline, too.
		await openCategory(page, 'Starters')
		await addQuick(page, 'Buffalo Wings')
		await cart(page).getByRole('button', { name: 'Pay later' }).click()
		await expect(status(page, 'Offline · 3 saved')).toBeVisible()
		expect(await backend.orders()).toHaveLength(0)

		// The orders are visible and numbered on the device meanwhile.
		const orders = await openOrders(page, 'today')
		await expect(orders.getByText('#T1-0001').first()).toBeVisible()
		await expect(orders.getByText('#T1-0003').first()).toBeVisible()
		await closeDialog(page)

		const uploads = captureUploads(page)
		await goOnline(context, page)
		const stored = await expectStored(3)
		expect(stored.map((o) => o.number).sort()).toEqual([
			'T1-0001',
			'T1-0002',
			'T1-0003',
		])
		expect(stored.map((o) => o.status).sort()).toEqual(['open', 'paid', 'paid'])
		await expect(status(page, 'Online · all sent')).toBeVisible()
		for (const upload of uploads) assertWireContract(upload.body)
		// Oldest first.
		const requests = (await backend.requests()).filter(
			(r) => r.path === '/pos/orders' && r.status === 201,
		)
		expect(requests).toHaveLength(3)
	})

	test('the app opens and sells with no network at all, after a reload', async ({
		paired: page,
		context,
	}) => {
		// Let the service worker install and take control, as it does on the second visit.
		await page.evaluate(async () => {
			await navigator.serviceWorker.ready
		})
		await page.reload()
		await expect
			.poll(() =>
				page.evaluate(() => navigator.serviceWorker.controller !== null),
			)
			.toBe(true)

		await goOffline(context, page)
		await page.reload()
		await expect(
			page.getByRole('heading', { name: 'Demo Kitchen' }),
		).toBeVisible()
		await expect(
			page.getByRole('button', { name: /^Smash Burger,/ }),
		).toBeVisible()

		await sellFries(page)
		await expect(status(page, 'Offline · 1 saved')).toBeVisible()
		await goOnline(context, page)
		const [order] = await expectStored(1)
		expect(order!.number).toBe('T1-0001')
	})

	test('order numbers carry on across a reload while offline', async ({
		paired: page,
		context,
	}) => {
		await page.evaluate(async () => {
			await navigator.serviceWorker.ready
		})
		await page.reload()
		await expect
			.poll(() =>
				page.evaluate(() => navigator.serviceWorker.controller !== null),
			)
			.toBe(true)
		await goOffline(context, page)
		await sellFries(page)
		await page.reload()
		await expect(
			page.getByRole('heading', { name: 'Demo Kitchen' }),
		).toBeVisible()
		await sellFries(page)
		await goOnline(context, page)
		const orders = await expectStored(2)
		expect(orders.map((o) => o.number).sort()).toEqual(['T1-0001', 'T1-0002'])
	})

	test('a reload loses only the cart: saved tabs stay, and are sent exactly once', async ({
		paired: page,
		context,
	}) => {
		await goOffline(context, page)
		await openCategory(page, 'Starters')
		await addQuick(page, 'Truffle Fries')
		await cart(page).getByRole('button', { name: 'Pay later' }).click()
		// The cart clears only once the tab is safely saved.
		await expect(cart(page).getByText('No items yet')).toBeVisible()
		await goOnline(context, page)
		await expectStored(1)
		await page.reload()
		await expect(page.getByRole('button', { name: /1 open tab/ })).toBeVisible()
		// The reload did not send it a second time.
		await page.waitForTimeout(1500)
		expect(await backend.orders()).toHaveLength(1)
		const created = (await backend.requests()).filter(
			(r) => r.path === '/pos/orders' && r.status === 201,
		)
		expect(created).toHaveLength(1)
	})

	test('a menu refresh that fails keeps selling from the saved menu and says so', async ({
		paired: page,
	}) => {
		await page.route('**/resources/sites/menu**', (route) =>
			route.abort('failed'),
		)
		await page.getByRole('button', { name: 'Refresh menu' }).click()
		await expect(page.getByText(/Couldn’t update the menu/)).toBeVisible()
		await expect(
			page.getByText(/Selling from the copy saved on this device/),
		).toBeVisible()
		await sellFries(page)
		await expectStored(1)
	})

	test('refreshing the menu picks up what the manager changed', async ({
		paired: page,
	}) => {
		await backend.liveMenu({
			prices: { 'i-fries': 9 },
			remove: ['i-wings'],
			publish: true,
		})
		await page.getByRole('button', { name: 'Refresh menu' }).click()
		await openCategory(page, 'Starters')
		await expect(
			page.getByRole('button', { name: 'Truffle Fries, $9.00' }),
		).toBeVisible()
		await expect(
			page.getByRole('button', { name: /^Buffalo Wings,/ }),
		).toHaveCount(0)
		await sellFries(page)
		const [order] = await expectStored(1)
		// Till and server agree, so there is nothing to review.
		expect(order!.reviewReason).toBeNull()
		expect(order!.subtotalCents).toBe(900)
	})
})

test.describe('a running till stays current', () => {
	test('picks up a sold-out item on its own, with nobody tapping refresh', async ({
		paired: page,
	}) => {
		await page.clock.install()
		// Timers only follow the fake clock if the app registers them after it is installed.
		await page.reload()
		await expect(
			page.getByRole('heading', { name: 'Demo Kitchen' }),
		).toBeVisible()
		await openCategory(page, 'Starters')
		await expect(
			page.getByRole('button', { name: /^Buffalo Wings,/ }),
		).toBeVisible()
		await backend.liveMenu({ remove: ['i-wings'], publish: true })
		await page.clock.runFor(6 * 60_000 + 2_000)
		await expect(
			page.getByRole('button', { name: /^Buffalo Wings,/ }),
		).toHaveCount(0)
		await expect(
			page.getByRole('button', { name: /^Truffle Fries,/ }),
		).toBeVisible()
	})

	test('refreshes when the tablet is picked up again after a while', async ({
		paired: page,
	}) => {
		await page.clock.install()
		await openCategory(page, 'Starters')
		await backend.liveMenu({ prices: { 'i-fries': 9.5 }, publish: true })
		await page.clock.fastForward(3 * 60_000) // stale, but not yet at the 5 minute timer
		await page.evaluate(() =>
			document.dispatchEvent(new Event('visibilitychange')),
		)
		await expect(
			page.getByRole('button', { name: 'Truffle Fries, $9.50' }),
		).toBeVisible()
	})

	test('a fresh menu is not downloaded again on every glance', async ({
		paired: page,
	}) => {
		await page.clock.install()
		const before = (await backend.requests()).length
		const menuFetches: string[] = []
		page.on(
			'request',
			(r) =>
				r.url().includes('/resources/sites/menu') && menuFetches.push(r.url()),
		)
		await page.evaluate(() =>
			document.dispatchEvent(new Event('visibilitychange')),
		)
		await page.clock.fastForward(30_000)
		await page.evaluate(() =>
			document.dispatchEvent(new Event('visibilitychange')),
		)
		await page.waitForTimeout(300)
		expect(menuFetches).toHaveLength(0)
		void before
	})

	test('an order in progress is untouched by a background menu refresh', async ({
		paired: page,
	}) => {
		await page.clock.install()
		// Timers only follow the fake clock if the app registers them after it is installed.
		await page.reload()
		await expect(
			page.getByRole('heading', { name: 'Demo Kitchen' }),
		).toBeVisible()
		await openCategory(page, 'Starters')
		await page.getByRole('button', { name: /^Buffalo Wings,/ }).click()
		await backend.liveMenu({ remove: ['i-wings'], publish: true })
		await page.clock.runFor(6 * 60_000 + 2_000)
		await expect(
			page.getByRole('button', { name: /^Buffalo Wings,/ }),
		).toHaveCount(0)
		// The wings already on the order are still there and still payable.
		await expect(cart(page).getByText('Buffalo Wings')).toBeVisible()
		await payExactCash(page)
		const [order] = await expectStored(1)
		expect(order!.lines[0]!.name).toBe('Buffalo Wings')
	})
})

test.describe("tips follow the restaurant's own setting", () => {
	test('no tip choices when dine-in tips are off for the location', async ({
		paired: page,
	}) => {
		await backend.location({
			inHouseTips: { dineInTips: false, pickupTips: true, deliveryTips: true },
		})
		await page.getByRole('button', { name: 'Refresh menu' }).click()
		await fillCart(page, 1)
		const sheet = await startCharge(page)
		await expect(sheet.getByRole('button', { name: '15%' })).toHaveCount(0)
		await expect(confirmButton(sheet)).toHaveText('Confirm $8.12')
		await confirmButton(sheet).click()
		await dialog(page).getByRole('button', { name: 'New order' }).click()
		const [order] = await expectStored(1)
		expect(order!.tipCents).toBe(0)
	})

	test('takeaway follows the pickup setting instead', async ({
		paired: page,
	}) => {
		await backend.location({
			inHouseTips: { dineInTips: false, pickupTips: true, deliveryTips: true },
		})
		await page.getByRole('button', { name: 'Refresh menu' }).click()
		await fillCart(page, 1)
		await cart(page).getByRole('radio', { name: 'Takeaway' }).click()
		const sheet = await startCharge(page)
		await expect(sheet.getByRole('button', { name: '15%' })).toBeVisible()
	})
})

test.describe('flaky networks and servers', () => {
	test('a server outage: the sale is safe, retries are spaced, and it arrives once the server is back', async ({
		paired: page,
	}) => {
		await backend.outage(503)
		await sellFries(page)
		await expect
			.poll(
				async () =>
					(await backend.requests()).filter((r) => r.status === 503).length,
			)
			.toBeGreaterThanOrEqual(1)
		expect(await backend.orders()).toHaveLength(0)
		await expect(status(page, /Sending 1|1/)).toBeVisible()
		const orders = await openOrders(page, 'today')
		await expect(
			orders.getByText('Paid · waiting to send').first(),
		).toBeVisible()
		await expect(orders.getByText(/Will retry automatically/)).toBeVisible()

		await backend.clearOutage()
		// "Upload now" overrides the retry wait.
		await orders.getByRole('button', { name: 'Upload now' }).click()
		const [stored] = await expectStored(1)
		expect(stored!.number).toBe('T1-0001')
		await expect(orders.getByText('Paid · sent').first()).toBeVisible()
	})

	test('the server answers once, the answer is lost: the retry does not create a second order', async ({
		paired: page,
	}) => {
		let first = true
		await page.route('**/pos/orders', async (route) => {
			if (route.request().method() === 'POST' && first) {
				first = false
				await route.fetch() // the server really handles it…
				await route.abort('failed') // …but the till never hears back
				return
			}
			await route.continue()
		})
		await sellFries(page)
		await expectStored(1)
		const orders = await openOrders(page, 'today')
		await expect(
			orders.getByText('Paid · waiting to send').first(),
		).toBeVisible()
		await orders.getByRole('button', { name: 'Upload now' }).click()
		await expect(orders.getByText('Paid · sent').first()).toBeVisible()
		const all = await backend.orders()
		expect(all).toHaveLength(1)
		const posts = (await backend.requests()).filter(
			(r) => r.path === '/pos/orders',
		)
		expect(posts.map((r) => r.status)).toEqual([201, 200]) // created, then recognised as a replay
		expect(new Set(posts.map((r) => r.idempotencyKey)).size).toBe(1)
	})

	test('a brief outage during a long shift does not reorder or duplicate anything', async ({
		paired: page,
	}) => {
		await sellFries(page)
		await expectStored(1)
		await backend.outage(503, 2)
		await sellFries(page)
		await sellFries(page)
		const orders = await openOrders(page, 'today')
		await orders
			.getByRole('button', { name: 'Upload now' })
			.first()
			.click()
			.catch(() => undefined)
		await closeDialog(page)
		await page.getByRole('button', { name: /^Orders/ }).click()
		await expect
			.poll(async () => (await backend.orders()).length, { timeout: 25_000 })
			.toBe(3)
		const stored = await backend.orders()
		expect(new Set(stored.map((o) => o.id)).size).toBe(3)
		expect(stored.map((o) => o.number).sort()).toEqual([
			'T1-0001',
			'T1-0002',
			'T1-0003',
		])
	})

	test('a revision that changes while an older one is in flight is never lost', async ({
		paired: page,
	}) => {
		// Hold the first upload of the tab open while the guest adds a dish.
		let release!: () => void
		const gate = new Promise<void>((resolve) => (release = resolve))
		let held = false
		await page.route('**/pos/orders', async (route) => {
			if (!held && route.request().method() === 'POST') {
				held = true
				await gate
			}
			await route.continue()
		})
		await openCategory(page, 'Starters')
		await addQuick(page, 'Truffle Fries')
		await cart(page).getByRole('button', { name: 'Pay later' }).click()
		await expect.poll(() => held).toBe(true)
		const orders = await openOrders(page, 'open')
		await orders.getByRole('button', { name: 'Add items' }).click()
		await addQuick(page, 'Buffalo Wings')
		await cart(page).getByRole('button', { name: 'Save tab' }).click()
		release()
		await expect
			.poll(async () => (await backend.orders())[0]?.revision, {
				timeout: 20_000,
			})
			.toBe(2)
		const [order] = await backend.orders()
		expect(order!.lines.map((l) => l.name).sort()).toEqual([
			'Buffalo Wings',
			'Truffle Fries',
		])
		expect(await backend.orders()).toHaveLength(1)
	})
})

test.describe('menu drift: what was collected is kept, a person is told', () => {
	test('the price changed since the till loaded the menu', async ({
		paired: page,
	}) => {
		await backend.liveMenu({ prices: { 'i-fries': 9 } }) // server moves on; the till still has $7.50
		await sellFries(page)
		const [order] = await expectStored(1)
		expect(order).toMatchObject({
			status: 'paid',
			reviewReason: 'price_mismatch',
			totalCents: 812,
		})
		// The server kept its own figure beside it for whoever reviews it.
		expect(order!.serverTotalCents).toBe(900 + 74)
		expect(order!.payments[0]!.amountCents).toBe(812)
	})

	test('a dish left the menu after it was sold (offline, say)', async ({
		paired: page,
	}) => {
		await backend.liveMenu({ remove: ['i-fries'] })
		await sellFries(page)
		const [order] = await expectStored(1)
		expect(order).toMatchObject({
			status: 'paid',
			reviewReason: 'catalog:unknown_item',
		})
		expect(order!.lines[0]!.name).toBe('Truffle Fries')
	})

	test('a clean sale carries no flag', async ({ paired: page }) => {
		await sellFries(page)
		const [order] = await expectStored(1)
		expect(order!.reviewReason).toBeNull()
		expect(order!.serverTotalCents).toBe(order!.subtotalCents + order!.taxCents)
	})

	test('a sale rung up while online ordering is closed is still accepted', async ({
		paired: page,
	}) => {
		// The harness menu has online ordering closed all week: walk-in must not care.
		await sellFries(page)
		const [order] = await expectStored(1)
		expect(order!.status).toBe('paid')
		expect(order!.reviewReason).toBeNull()
	})
})

test.describe('a terminal whose counter was lost', () => {
	test('collides, is offered the next free number, renumbers and says so', async ({
		paired: page,
	}) => {
		await sellFries(page)
		await sellFries(page)
		await expectStored(2)
		// Site data was cleared mid-day: the till forgets how far it had counted.
		await page.evaluate(
			() =>
				new Promise<void>((resolve, reject) => {
					const open = indexedDB.open('pos')
					open.onsuccess = () => {
						const tx = open.result.transaction('meta', 'readwrite')
						tx.objectStore('meta').clear()
						tx.oncomplete = () => resolve()
						tx.onerror = () => reject(tx.error)
					}
				}),
		)
		await page.reload()
		await expect(
			page.getByRole('heading', { name: 'Demo Kitchen' }),
		).toBeVisible()
		await sellFries(page) // the till numbers it T1-0001 again
		const stored = await expectStored(3)
		expect(stored.map((o) => o.number).sort()).toEqual([
			'T1-0001',
			'T1-0002',
			'T1-0003',
		])
		expect(
			(await backend.requests()).filter((r) => r.status === 409),
		).toHaveLength(1)
		const orders = await openOrders(page, 'today')
		await expect(
			orders.getByText(/renumbered because that number was already taken/),
		).toBeVisible()
		await expect(orders.getByText(/first shown as #T1-0001/)).toBeVisible()
		await closeDialog(page)
		// And the next sale carries on from the new count.
		await sellFries(page)
		const after = await expectStored(4)
		expect(after.map((o) => o.number).sort()).toEqual([
			'T1-0001',
			'T1-0002',
			'T1-0003',
			'T1-0004',
		])
	})
})

test.describe('location overrides: the till and the server agree', () => {
	test('an option price override is charged on the till and not flagged by the server', async ({
		paired: page,
	}) => {
		await backend.overrides([
			{ entityType: 'option', entityId: 'o-cheese', price: 3 },
		])
		await page.getByRole('button', { name: 'Refresh menu' }).click()
		const sheet = await (async () => {
			await page.getByRole('button', { name: /^Smash Burger,/ }).click()
			return dialog(page)
		})()
		await sheet.getByRole('button', { name: /^Extra cheese/ }).click()
		await expect(
			sheet.getByRole('button', { name: 'Add · $16.50' }),
		).toBeVisible() // 13.50 + 3.00
		await sheet.getByRole('button', { name: /^Add ·/ }).click()
		await payExactCash(page)
		const [order] = await expectStored(1)
		expect(order!.subtotalCents).toBe(1650)
		expect(order!.reviewReason).toBeNull()
	})

	test('a hidden item leaves the till, a disabled option disappears, a $0 override changes nothing', async ({
		paired: page,
	}) => {
		await backend.overrides([
			{
				entityType: 'item',
				entityId: 'i-chicken',
				availabilityStatus: 'hidden',
			},
			{ entityType: 'option', entityId: 'o-bacon', isEnabled: false },
			{ entityType: 'item', entityId: 'i-salmon', price: 0 },
		])
		await page.getByRole('button', { name: 'Refresh menu' }).click()
		await expect(
			page.getByRole('button', { name: /^Crispy Chicken Sandwich,/ }),
		).toHaveCount(0)
		await expect(
			page.getByRole('button', { name: 'Seared Salmon, $19.00' }),
		).toBeVisible()
		await page.getByRole('button', { name: /^Smash Burger,/ }).click()
		const sheet = dialog(page)
		await expect(
			sheet.getByRole('button', { name: /^Extra cheese/ }),
		).toBeVisible()
		await expect(sheet.getByRole('button', { name: /^Bacon/ })).toHaveCount(0)
	})

	test('selling an item the server now treats as unavailable is flagged, not refused', async ({
		paired: page,
	}) => {
		// The till still has the old menu; the server's live menu has since hidden the item.
		await backend.overrides(
			[
				{
					entityType: 'item',
					entityId: 'i-fries',
					availabilityStatus: 'hidden',
				},
			],
			false,
		)
		await sellFries(page)
		const [order] = await expectStored(1)
		expect(order).toMatchObject({ status: 'paid' })
		expect(order!.reviewReason).toMatch(/^catalog:/)
	})
})

test.describe('several terminals', () => {
	test('two tablets sell at once: separate numbers, nothing crossed', async ({
		browser,
		unpaired: first,
	}) => {
		await pairUi(first, { label: 'Counter', terminalCode: 'T1' })
		const context = await browser.newContext()
		const second = await context.newPage()
		const { link } = await backend.pairingCode({
			label: 'Bar',
			terminalCode: 'T2',
		})
		await openPairingLink(second, link)
		await expect(
			second.getByRole('heading', { name: 'Demo Kitchen' }),
		).toBeVisible()

		await Promise.all([sellFries(first, 1), sellFries(second, 2)])
		await sellFries(first, 1)
		const orders = await expectStored(3)
		expect(orders.map((o) => o.number).sort()).toEqual([
			'T1-0001',
			'T1-0002',
			'T2-0001',
		])
		const devices = await backend.devices()
		expect(devices).toHaveLength(2)
		await context.close()
	})
})
