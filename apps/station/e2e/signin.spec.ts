import { type Page } from '@playwright/test'
import {
	ANA,
	LINA,
	OMAR,
	addQuick,
	backend,
	cart,
	confirmButton,
	dialog,
	expect,
	expectStored,
	fillCart,
	goOffline,
	goOnline,
	lockScreen,
	openCategory,
	openOrders,
	pairLocked,
	sellFries,
	signInWithPin,
	staffChip,
	startCharge,
	test,
	typeKeypad,
	giveReason,
} from './helpers.ts'

const menuVisible = (page: Page) =>
	page.getByRole('button', { name: /^Smash Burger,/ })
/** Playwright's role queries ignore `inert`, so check the real property: the menu is inside an inert container. */
const isInert = (page: Page) =>
	menuVisible(page).evaluate((el) => el.closest('[inert]') !== null)
async function expectBehindLock(page: Page) {
	await expect(lockScreen(page)).toBeVisible()
	expect(await isInert(page)).toBe(true)
}
async function expectUsable(page: Page) {
	await expect(lockScreen(page)).toHaveCount(0)
	await expect(menuVisible(page)).toBeVisible()
	expect(await isInert(page)).toBe(false)
}
const settingsButton = (page: Page) =>
	page.getByRole('button', { name: 'Settings' })

/** Time-based tests: install the fake clock, then reload so the app's timers use it. */
async function withClock(page: Page) {
	await page.clock.install()
	await page.reload()
	await expect(lockScreen(page)).toBeVisible()
}

test.describe('the till locks until a staff member signs in', () => {
	test('a paired till that requires sign-in starts locked, and nothing behind the lock can be reached', async ({
		unpaired: page,
	}) => {
		await pairLocked(page)
		await expect(
			lockScreen(page).getByText('Enter your PIN to start'),
		).toBeVisible()
		await expectBehindLock(page)
		// It cannot even be reached with the keyboard.
		await page.keyboard.press('Tab')
		expect(
			await page.evaluate(
				() => document.activeElement?.closest('[inert]') === null,
			),
		).toBe(true)
	})

	test('the right PIN opens it and the till shows who is signed in', async ({
		unpaired: page,
	}) => {
		await pairLocked(page)
		await signInWithPin(page, ANA.pin)
		await expectUsable(page)
		await expect(staffChip(page, ANA.name)).toBeVisible()
	})

	test('a physical keyboard works too: digits, backspace and Enter', async ({
		unpaired: page,
	}) => {
		await pairLocked(page)
		await lockScreen(page).focus()
		await page.keyboard.type('4329')
		await page.keyboard.press('Backspace')
		await page.keyboard.type('1')
		await page.keyboard.press('Enter')
		await expect(staffChip(page, ANA.name)).toBeVisible()
	})

	test('Sign in waits for at least four digits, and Escape does not get past the lock', async ({
		unpaired: page,
	}) => {
		await pairLocked(page)
		const lock = lockScreen(page)
		await expect(lock.getByRole('button', { name: 'Sign in' })).toBeDisabled()
		await typeKeypad(lock, '432')
		await expect(lock.getByRole('button', { name: 'Sign in' })).toBeDisabled()
		await page.keyboard.press('Escape')
		await expect(lock).toBeVisible()
		await typeKeypad(lock, '1')
		await expect(lock.getByRole('button', { name: 'Sign in' })).toBeEnabled()
	})

	test('a wrong PIN says so, clears the digits, and stays locked', async ({
		unpaired: page,
	}) => {
		await pairLocked(page)
		await signInWithPin(page, '1111')
		const lock = lockScreen(page)
		await expect(lock.getByRole('alert')).toContainText(
			'That PIN is not right.',
		)
		await expect(
			lock.getByRole('img', { name: '0 digits entered' }),
		).toBeVisible()
		await expectBehindLock(page)
	})

	test('repeated wrong PINs make the till wait, and the right PIN waits too', async ({
		unpaired: page,
	}) => {
		await pairLocked(page)
		for (let i = 0; i < 5; i++) await signInWithPin(page, '0000')
		const lock = lockScreen(page)
		await expect(lock.getByRole('alert')).toContainText(
			/Try again in \d+ seconds?/,
		)
		await expect(lock.getByRole('button', { name: 'Sign in' })).toBeDisabled()
		await typeKeypad(lock, ANA.pin)
		await expect(lock.getByRole('button', { name: 'Sign in' })).toBeDisabled()
		await expectBehindLock(page)
	})

	test('people who are not active are turned away', async ({
		unpaired: page,
	}) => {
		await pairLocked(page)
		await backend.addStaff({
			first: 'Gone',
			last: 'Away',
			pin: '1357',
			status: 'terminated',
		})
		await signInWithPin(page, '1357')
		await expect(lockScreen(page).getByRole('alert')).toContainText('not right')
	})

	test('reloading the page locks the till again: a session is never kept across a reload', async ({
		unpaired: page,
	}) => {
		await pairLocked(page)
		await signInWithPin(page, ANA.pin)
		await expect(staffChip(page, ANA.name)).toBeVisible()
		await page.reload()
		await expect(lockScreen(page)).toBeVisible()
		await expectBehindLock(page)
	})
})

test.describe('locking and switching user', () => {
	test('the lock button locks at once, keeps the order on screen, and the next person can carry on', async ({
		unpaired: page,
	}) => {
		await pairLocked(page)
		await signInWithPin(page, ANA.pin)
		await fillCart(page, 1)
		await staffChip(page, ANA.name).click()
		await expect(lockScreen(page)).toBeVisible()
		await signInWithPin(page, OMAR.pin)
		await expect(staffChip(page, OMAR.name)).toBeVisible()
		await expect(cart(page).getByText('Truffle Fries')).toBeVisible()
		// The order is Omar's: it is placed while he is signed in.
		await cart(page).getByRole('button', { name: 'Pay later' }).click()
		const [order] = await expectStored(1)
		expect(order!.staff).toMatchObject({ name: OMAR.name })
	})

	test('goes idle: locks by itself after the set time, not before', async ({
		unpaired: page,
	}) => {
		await pairLocked(page)
		await withClock(page)
		await signInWithPin(page, ANA.pin)
		await expect(staffChip(page, ANA.name)).toBeVisible()
		await page.clock.runFor(110_000)
		await expect(lockScreen(page)).toHaveCount(0)
		await page.clock.runFor(15_000)
		await expect(lockScreen(page)).toBeVisible()
	})

	test('touching the screen keeps it awake', async ({ unpaired: page }) => {
		await pairLocked(page)
		await withClock(page)
		await signInWithPin(page, ANA.pin)
		await page.clock.runFor(100_000)
		await page.mouse.click(300, 400) // any touch counts
		await page.clock.runFor(100_000)
		await expect(lockScreen(page)).toHaveCount(0)
		await page.clock.runFor(30_000)
		await expect(lockScreen(page)).toBeVisible()
	})

	test('locking over an open payment sheet covers it, and it is still there, as left, after sign-in', async ({
		unpaired: page,
	}) => {
		await pairLocked(page)
		await withClock(page)
		await signInWithPin(page, ANA.pin)
		await fillCart(page, 1)
		const sheet = await startCharge(page)
		await typeKeypad(sheet, '2000')
		await expect(sheet.getByText('Change $11.88')).toBeVisible()
		await page.clock.runFor(125_000)
		await expect(lockScreen(page)).toBeVisible()
		// The payment sheet is underneath and cannot be touched.
		await expect(
			sheet
				.getByRole('button', { name: /^Confirm/ })
				.click({ trial: true, timeout: 1500 }),
		).rejects.toThrow()
		await signInWithPin(page, LINA.pin)
		await expect(dialog(page).getByText('Change $11.88')).toBeVisible()
		await confirmButton(dialog(page)).click()
		await dialog(page).getByRole('button', { name: 'New order' }).click()
		// Rung up by Ana, paid at the till by Lina.
		const [order] = await expectStored(1)
		expect(order!.staff).toMatchObject({ name: ANA.name })
		expect(order!.payments[0]!.staff).toMatchObject({ name: LINA.name })
	})

	test('a manager can choose how long, including never', async ({
		unpaired: page,
	}) => {
		await pairLocked(page)
		await withClock(page)
		await signInWithPin(page, LINA.pin)
		await settingsButton(page).click()
		await dialog(page).getByLabel('Lock after').selectOption('0')
		await dialog(page).getByRole('button', { name: 'Save' }).click()
		await expect(page.getByRole('dialog')).toHaveCount(0)
		await page.clock.runFor(30 * 60_000)
		await expect(lockScreen(page)).toHaveCount(0)
		await expect(staffChip(page, LINA.name)).toBeVisible()
	})

	test('orders still go to the server while the till is locked', async ({
		unpaired: page,
	}) => {
		await pairLocked(page)
		await signInWithPin(page, ANA.pin)
		await sellFries(page)
		await staffChip(page, ANA.name).click()
		await expect(lockScreen(page)).toBeVisible()
		await expectStored(1)
	})
})

test.describe('without a connection', () => {
	test('someone who has signed in here before can sign in offline, and it is recorded as such', async ({
		unpaired: page,
		context,
	}) => {
		await pairLocked(page)
		await signInWithPin(page, ANA.pin) // online, remembered
		await staffChip(page, ANA.name).click()
		await goOffline(context, page)
		await expect(
			lockScreen(page).getByText(
				/Offline: people who have signed in here before/,
			),
		).toBeVisible()
		await signInWithPin(page, ANA.pin)
		await expect(staffChip(page, ANA.name)).toBeVisible()
		await sellFries(page)
		await goOnline(context, page)
		const [order] = await expectStored(1)
		expect(order).toMatchObject({
			staff: { name: ANA.name },
			signIn: 'offline',
		})
		// The server flags nothing: she is a real member of staff.
		expect(order!.status).toBe('paid')
	})

	test('the very first sign-in on a device needs a connection, and says so', async ({
		unpaired: page,
		context,
	}) => {
		await pairLocked(page)
		await goOffline(context, page)
		await signInWithPin(page, ANA.pin)
		await expect(lockScreen(page).getByRole('alert')).toContainText(
			'first sign-in on this device needs a connection',
		)
		await expectBehindLock(page)
	})

	test("a stranger's PIN is refused offline, and repeated guesses slow the till down", async ({
		unpaired: page,
		context,
	}) => {
		await pairLocked(page)
		await signInWithPin(page, ANA.pin)
		await staffChip(page, ANA.name).click()
		await goOffline(context, page)
		for (let i = 0; i < 5; i++) await signInWithPin(page, '0000')
		const lock = lockScreen(page)
		await expect(lock.getByRole('alert')).toContainText(
			/Try again in \d+ seconds?/,
		)
		await typeKeypad(lock, ANA.pin)
		await expect(lock.getByRole('button', { name: 'Sign in' })).toBeDisabled()
	})

	test('the offline wait survives a reload', async ({
		unpaired: page,
		context,
	}) => {
		await pairLocked(page)
		await signInWithPin(page, ANA.pin)
		await staffChip(page, ANA.name).click()
		await goOffline(context, page)
		for (let i = 0; i < 5; i++) await signInWithPin(page, '0000')
		await expect(lockScreen(page).getByRole('alert')).toContainText(/Try again/)
		await context.setOffline(false)
		await page.reload()
		await goOffline(context, page)
		await signInWithPin(page, ANA.pin)
		await expect(lockScreen(page).getByRole('alert')).toContainText(
			/Try again in \d+ seconds?/,
		)
		await expectBehindLock(page)
	})
})

test.describe('the server stays in charge when it can be reached', () => {
	test('someone who has left cannot sign in, even though the till remembered them', async ({
		unpaired: page,
		context,
	}) => {
		const ids = await pairLocked(page)
		await signInWithPin(page, ANA.pin)
		await staffChip(page, ANA.name).click()
		await signInWithPin(page, OMAR.pin)
		await staffChip(page, OMAR.name).click()
		await backend.updateStaff({ id: ids.omar, status: 'terminated' })
		await signInWithPin(page, OMAR.pin)
		await expect(lockScreen(page).getByRole('alert')).toContainText('not right')
		// And the till forgot them: offline does not let them in either.
		await goOffline(context, page)
		await signInWithPin(page, OMAR.pin)
		await expect(lockScreen(page).getByRole('alert')).toContainText('not right')
		await expectBehindLock(page)
	})

	test('a changed PIN: the old one stops working, the new one works', async ({
		unpaired: page,
	}) => {
		const ids = await pairLocked(page)
		await signInWithPin(page, ANA.pin)
		await staffChip(page, ANA.name).click()
		await backend.updateStaff({ id: ids.ana, pin: '5555' })
		await signInWithPin(page, ANA.pin)
		await expect(lockScreen(page).getByRole('alert')).toContainText('not right')
		await signInWithPin(page, '5555')
		await expect(staffChip(page, ANA.name)).toBeVisible()
	})

	test('a server problem (not a wrong PIN) falls back to the people the till remembers', async ({
		unpaired: page,
	}) => {
		await pairLocked(page)
		await signInWithPin(page, ANA.pin)
		await staffChip(page, ANA.name).click()
		await page.route('**/pos/sign-in', (route) =>
			route.fulfill({ status: 503, json: { error: 'service_unavailable' } }),
		)
		await signInWithPin(page, ANA.pin)
		await expect(staffChip(page, ANA.name)).toBeVisible()
	})
})

test.describe('who took the order', () => {
	test('the server records who rang it up and who took the payment', async ({
		unpaired: page,
	}) => {
		await pairLocked(page)
		await signInWithPin(page, ANA.pin)
		await sellFries(page)
		const [order] = await expectStored(1)
		expect(order).toMatchObject({
			staff: { name: ANA.name },
			signIn: 'online',
			reviewReason: null,
		})
		expect(order!.payments[0]!.staff).toMatchObject({ name: ANA.name })
	})

	test('a tab one person opens and another settles keeps both names, on the till and on the server', async ({
		unpaired: page,
	}) => {
		await pairLocked(page)
		await signInWithPin(page, ANA.pin)
		await openCategory(page, 'Starters')
		await addQuick(page, 'Truffle Fries')
		await cart(page).getByRole('button', { name: 'Pay later' }).click()
		await staffChip(page, ANA.name).click()
		await signInWithPin(page, LINA.pin)
		const orders = await openOrders(page, 'open')
		await expect(orders.getByText(/Taken by/)).toContainText('Ana K.')
		await orders.getByRole('button', { name: /^Pay / }).click()
		await confirmButton(dialog(page)).click()
		await dialog(page).getByRole('button', { name: 'New order' }).click()
		const today = await openOrders(page, 'today')
		await expect(today.getByText(/Taken by/)).toContainText('Ana K.')
		await expect(today.getByText('Paid · Cash · Lina M.')).toBeVisible()
		await expect
			.poll(async () => (await backend.orders())[0]?.status)
			.toBe('paid')
		const [order] = await backend.orders()
		expect(order!.staff).toMatchObject({ name: ANA.name })
		expect(order!.payments[0]!.staff).toMatchObject({ name: LINA.name })
	})

	test('a cancellation records who cancelled, apart from who opened the tab', async ({
		unpaired: page,
	}) => {
		await pairLocked(page)
		await signInWithPin(page, ANA.pin)
		await openCategory(page, 'Starters')
		await addQuick(page, 'Truffle Fries')
		await cart(page).getByRole('button', { name: 'Pay later' }).click()
		await staffChip(page, ANA.name).click()
		await signInWithPin(page, LINA.pin)
		const orders = await openOrders(page, 'open')
		await orders.getByRole('button', { name: 'Cancel tab' }).click()
		// Lina manages the till, so no one else has to approve.
		await giveReason(page, {
			title: /^Cancel tab/,
			confirm: /^Cancel the tab$/,
		})
		await orders.getByRole('radio', { name: /^Today/ }).click()
		await expect(orders.getByText(/Cancelled by/)).toContainText('Lina M.')
		await expect
			.poll(async () => (await backend.orders())[0]?.status)
			.toBe('void')
		const [order] = await backend.orders()
		expect(order).toMatchObject({
			staff: { name: ANA.name },
			voidedBy: { name: LINA.name },
			voidReason: 'mistake',
			voidApprovedBy: null,
		})
	})

	test('the receipt says who served', async ({ unpaired: page }) => {
		await pairLocked(page)
		await signInWithPin(page, OMAR.pin)
		await fillCart(page, 1)
		const sheet = await startCharge(page)
		await confirmButton(sheet).click()
		await expect(page.locator('#receipt')).toContainText('Served by Omar R.')
	})

	test('the order list shows who took each order', async ({
		unpaired: page,
	}) => {
		await pairLocked(page)
		await signInWithPin(page, ANA.pin)
		await sellFries(page)
		await staffChip(page, ANA.name).click()
		await signInWithPin(page, OMAR.pin)
		await sellFries(page)
		const orders = await openOrders(page, 'today')
		const rows = orders.locator('ul').first().getByRole('button')
		await expect(rows.nth(0)).toContainText('Omar R.')
		await expect(rows.nth(1)).toContainText('Ana K.')
	})

	test('a till without sign-in records no staff and shows no lock or chip', async ({
		paired: page,
	}) => {
		await sellFries(page)
		const [order] = await expectStored(1)
		expect(order).toMatchObject({ staff: null, signIn: null })
		await expect(lockScreen(page)).toHaveCount(0)
		await expect(
			page.getByRole('button', { name: /^Lock the till/ }),
		).toHaveCount(0)
	})
})

test.describe('settings are for managers', () => {
	test('a cashier is stopped at Settings and can switch user', async ({
		unpaired: page,
	}) => {
		await pairLocked(page)
		await signInWithPin(page, ANA.pin)
		await settingsButton(page).click()
		const ask = dialog(page).filter({ hasText: 'Settings are for managers' })
		await expect(ask).toBeVisible()
		await expect(page.getByLabel('Pairing link or code')).toHaveCount(0)
		await ask.getByRole('button', { name: 'Switch user' }).click()
		await expect(lockScreen(page)).toBeVisible()
	})

	test('a manager gets in, sees the sign-in setting, and can unpair', async ({
		unpaired: page,
	}) => {
		await pairLocked(page)
		await signInWithPin(page, LINA.pin)
		await settingsButton(page).click()
		const sheet = dialog(page).filter({ hasText: 'Terminal settings' })
		await expect(
			sheet.getByText('On: staff sign in with their PIN'),
		).toBeVisible()
		await sheet.getByRole('button', { name: 'Unpair this terminal' }).click()
		await sheet.getByRole('button', { name: 'Unpair', exact: true }).click()
		await expect(
			sheet.getByRole('button', { name: 'Pair terminal' }),
		).toBeVisible()
		// An unpaired till has nobody to check PINs against: it is no longer locked.
		await sheet.getByRole('button', { name: 'Close' }).click()
		await expect(lockScreen(page)).toHaveCount(0)
	})

	test('Settings opened by a manager are closed when the till locks, so a cashier never inherits them', async ({
		unpaired: page,
	}) => {
		await pairLocked(page)
		await signInWithPin(page, LINA.pin)
		await settingsButton(page).click()
		await expect(
			dialog(page).filter({ hasText: 'Terminal settings' }),
		).toBeVisible()
		await staffChip(page, 'Lina M.').evaluate((el) =>
			(el as HTMLElement).click(),
		)
		await expect(lockScreen(page)).toBeVisible()
		await signInWithPin(page, ANA.pin)
		await expect(
			dialog(page).filter({ hasText: 'Terminal settings' }),
		).toHaveCount(0)
	})

	test('a till that does not require sign-in keeps Settings open to everyone, as before', async ({
		paired: page,
	}) => {
		await settingsButton(page).click()
		await expect(dialog(page).getByText(/Paired as/)).toBeVisible()
	})
})

test.describe('a manager changes it in the Menuza app', () => {
	test('switching sign-in off unlocks the till the next time it checks in', async ({
		unpaired: page,
	}) => {
		await pairLocked(page)
		const [device] = await backend.devices()
		await backend.setSignIn(device!.id, false)
		await page.reload()
		await expect(menuVisible(page)).toBeVisible()
		await expect(lockScreen(page)).toHaveCount(0)
		await expect(
			page.getByRole('button', { name: /^Lock the till/ }),
		).toHaveCount(0)
	})

	test('switching it on locks a till that was open', async ({
		paired: page,
	}) => {
		const [device] = await backend.devices()
		await backend.setSignIn(device!.id, true)
		await page.evaluate(() => window.dispatchEvent(new Event('online')))
		await expect(lockScreen(page)).toBeVisible()
		await expectBehindLock(page)
	})

	test('a removed terminal is not left locked: it can be paired again', async ({
		unpaired: page,
	}) => {
		await pairLocked(page)
		const [device] = await backend.devices()
		await backend.revoke(device!.id)
		await page.reload()
		await expect(page.getByText(/This terminal was removed/)).toBeVisible()
		await expect(lockScreen(page)).toHaveCount(0)
		await page.getByText(/This terminal was removed/).click()
		await expect(
			dialog(page).getByRole('button', { name: 'Pair terminal' }),
		).toBeVisible()
	})
})

test.describe('demo mode', () => {
	test('Settings can switch on staff sign-in, and the demo PIN opens the till', async ({
		demo: page,
	}) => {
		await page.getByRole('button', { name: 'Settings' }).click()
		await page.getByRole('checkbox', { name: /Try staff sign-in/ }).check()
		await page.getByRole('button', { name: 'Save' }).click()
		await expect(lockScreen(page)).toBeVisible()
		await signInWithPin(page, '1234')
		await expect(lockScreen(page)).toHaveCount(0)
	})
})
