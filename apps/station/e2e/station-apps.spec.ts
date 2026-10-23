import fs from 'node:fs'
import path from 'node:path'
import { type Page } from '@playwright/test'
import {
	backend,
	expect,
	lockScreen,
	pairUi,
	signInWithPin,
	test,
} from './helpers.ts'

/**
 * The Station apps beside the till: the time clock (also from the lock
 * screen) and the floor-first host stand, against the real tenant-api.
 *
 * `CAPTURE_DIR=<dir>` also saves a screenshot of each screen, for design review.
 */

const CAPTURE_DIR = process.env.CAPTURE_DIR
async function capture(page: Page, name: string) {
	if (!CAPTURE_DIR) return
	fs.mkdirSync(CAPTURE_DIR, { recursive: true })
	// Let entrance motion settle so nothing is caught half-faded.
	await page.waitForTimeout(700)
	await page.screenshot({ path: path.join(CAPTURE_DIR, `${name}.png`) })
}

async function typePin(scope: Page | ReturnType<Page['locator']>, pin: string) {
	for (const digit of pin)
		await scope
			.getByRole('group', { name: 'Keypad' })
			.getByRole('button', { name: digit, exact: true })
			.click()
}

const clock = (page: Page) => page.getByRole('dialog', { name: 'Time clock' })
/** The toast said this (as it was announced to screen readers). */
const expectToast = (page: Page, text: string) =>
	expect(page.getByRole('status').filter({ hasText: text })).toBeAttached()

test.describe('time clock', () => {
	test('clocks in from the lock screen with the PIN, recorded as a till punch', async ({
		unpaired: page,
	}) => {
		await backend.addStaff({ first: 'Rana', last: 'Saleh', pin: '4321' })
		await pairUi(page, { signInRequired: true, timeclockEnabled: true })
		const lock = lockScreen(page)
		await expect(
			lock.getByRole('button', { name: 'Clock in or out' }),
		).toBeVisible()
		await capture(page, 'lock-screen')
		await lock.getByRole('button', { name: 'Clock in or out' }).click()

		const tc = clock(page)
		await expect(
			tc.getByRole('heading', { name: 'Enter your PIN' }),
		).toBeVisible()
		await capture(page, 'timeclock-pin')
		await typePin(tc, '4321')
		await tc.getByRole('button', { name: 'Continue' }).click()
		await expect(tc.getByRole('heading', { name: 'Hi Rana' })).toBeVisible()
		await expect(tc.getByText('You are clocked out.')).toBeVisible()
		await capture(page, 'timeclock-actions')
		await tc.getByRole('button', { name: 'Clock in' }).click()
		await expect(
			tc.getByRole('heading', { name: 'Clocked in, Rana' }),
		).toBeVisible()
		await capture(page, 'timeclock-done')

		await expect
			.poll(async () =>
				(await backend.punches()).map((p) => [p.kind, p.source]),
			)
			.toEqual([['clock_in', 'pos']])

		// Done goes back to signing in: the till is still locked, and the lock's
		// button has the focus again, so a keyboard can carry on.
		await tc.getByRole('button', { name: 'Done' }).click()
		await expect(clock(page)).toHaveCount(0)
		await expect(lock).toBeVisible()
		await expect(
			lock.getByRole('button', { name: 'Clock in or out' }),
		).toBeFocused()
	})

	test('a wrong PIN is refused and the pad shakes clean', async ({
		unpaired: page,
	}) => {
		await backend.addStaff({ pin: '4321' })
		await pairUi(page, { signInRequired: true, timeclockEnabled: true })
		await lockScreen(page)
			.getByRole('button', { name: 'Clock in or out' })
			.click()
		const tc = clock(page)
		await typePin(tc, '1111')
		await tc.getByRole('button', { name: 'Continue' }).click()
		await expect(tc.getByRole('alert')).toContainText('That PIN is not right')
		await expect(await backend.punches()).toEqual([])
	})

	test('offline, the punch waits on the tablet and goes out once', async ({
		unpaired: page,
		context,
	}) => {
		await backend.addStaff({ first: 'Rana', pin: '4321' })
		await pairUi(page, { signInRequired: true, timeclockEnabled: true })
		await lockScreen(page)
			.getByRole('button', { name: 'Clock in or out' })
			.click()
		const tc = clock(page)
		await context.setOffline(true)
		await typePin(tc, '4321')
		await tc.getByRole('button', { name: 'Continue' }).click()
		// This till has never seen the PIN online: it says it cannot check it.
		await expect(
			tc.getByRole('heading', { name: 'What are you doing?' }),
		).toBeVisible()
		await expect(tc.getByText(/has not seen this PIN before/)).toBeVisible()
		await capture(page, 'timeclock-offline')
		await tc.getByRole('button', { name: 'Clock in' }).click()
		await expect(tc.getByText(/Saved on this terminal/)).toBeVisible()
		await expect(tc.getByText('1 punch waiting to send')).toBeVisible()
		await context.setOffline(false)
		await expect
			.poll(async () => (await backend.punches()).length, { timeout: 40_000 })
			.toBe(1)
		const [punch] = await backend.punches()
		expect(punch).toMatchObject({ kind: 'clock_in', source: 'pos' })
		expect(punch!.flags).toContain('offline_punch')
	})

	test('offline, a PIN this till has seen online is greeted by name, with its roles', async ({
		unpaired: page,
		context,
	}) => {
		await backend.addStaff({ first: 'Rana', pin: '4321' })
		await pairUi(page, { signInRequired: true, timeclockEnabled: true })
		await lockScreen(page)
			.getByRole('button', { name: 'Clock in or out' })
			.click()
		const tc = clock(page)
		// Online once: the till learns whose PIN it is.
		await typePin(tc, '4321')
		await tc.getByRole('button', { name: 'Continue' }).click()
		await expect(tc.getByRole('heading', { name: 'Hi Rana' })).toBeVisible()
		await tc.getByRole('button', { name: 'Not me' }).click()

		await context.setOffline(true)
		await typePin(tc, '4321')
		await tc.getByRole('button', { name: 'Continue' }).click()
		await expect(
			tc.getByRole('heading', { name: 'Hi Rana, what are you doing?' }),
		).toBeVisible()
		await tc.getByRole('button', { name: 'Clock in' }).click()
		await expect(
			tc.getByRole('heading', { name: 'Clocked in, Rana' }),
		).toBeVisible()
		await context.setOffline(false)
		await expect
			.poll(async () => (await backend.punches()).length, { timeout: 40_000 })
			.toBe(1)
	})

	test('signed in, choosing the clock locks the till and opens the clock over the lock', async ({
		unpaired: page,
	}) => {
		await backend.addStaff({ first: 'Rana', pin: '4321', manager: true })
		await pairUi(page, { signInRequired: true, timeclockEnabled: true })
		await signInWithPin(page, '4321')
		await page
			.getByRole('radiogroup', { name: 'Station app' })
			.getByRole('radio', { name: 'Time clock' })
			.click()
		// Nobody punches inside someone else's session.
		const tc = clock(page)
		await expect(
			tc.getByRole('heading', { name: 'Enter your PIN' }),
		).toBeVisible()
		await tc.getByRole('button', { name: 'Back to sign in' }).click()
		await expect(lockScreen(page)).toBeVisible()
		await signInWithPin(page, '4321')
		await expect(page.getByRole('button', { name: /^Orders/ })).toBeVisible()
	})

	test('a terminal without the clock shows neither the switch nor the button', async ({
		unpaired: page,
	}) => {
		await backend.addStaff({ pin: '4321' })
		await pairUi(page, { signInRequired: true })
		await expect(
			lockScreen(page).getByRole('button', { name: 'Clock in or out' }),
		).toHaveCount(0)
		await signInWithPin(page, '4321')
		await expect(
			page.getByRole('radiogroup', { name: 'Station app' }),
		).toHaveCount(0)
	})
})

test.describe('host stand', () => {
	async function openHostStand(page: Page, pin = '4321') {
		await backend.floor()
		await pairUi(page, {
			signInRequired: true,
			reservationsEnabled: true,
			timeclockEnabled: true,
			locationId: 'loc-1',
		})
		await signInWithPin(page, pin)
		await page
			.getByRole('radiogroup', { name: 'Station app' })
			.getByRole('radio', { name: 'Reservations' })
			.click()
		await expect(
			page.getByRole('region', { name: 'Parties to seat' }),
		).toBeVisible()
	}

	test('picks up a party at the stand and seats it on a table that fits, with undo', async ({
		unpaired: page,
	}) => {
		await backend.addStaff({ first: 'Lina', pin: '4321', host: true })
		await openHostStand(page)
		await capture(page, 'host-floor')
		const dock = page.getByRole('region', { name: 'Parties to seat' })
		await expect(dock.getByText('At the stand')).toBeVisible()
		await dock
			.getByRole('button', { name: /Maya H\./ })
			.first()
			.click()
		await expect(page.getByText(/Tap a table for Maya H\./)).toBeVisible()
		await capture(page, 'host-placing')
		await page.getByRole('button', { name: /^Table 1, open/ }).click()
		await expectToast(page, 'Seated Maya H. at 1.')
		await capture(page, 'host-seated-toast')
		await expect(
			page.getByRole('button', { name: /^Table 1, seated: Maya H\./ }),
		).toBeVisible()

		// Undo puts her back at the stand, still booked for table 2. A double
		// tap undoes once, not twice.
		await page.getByRole('button', { name: 'Undo' }).dblclick()
		await expectToast(page, 'Undone.')
		await expect(dock.getByText('At the stand')).toBeVisible()
		await expect(
			page.getByRole('button', { name: /^Table 1, (open|booked)/ }),
		).toBeVisible()
	})

	test('seats a walk-in from a table', async ({ unpaired: page }) => {
		await backend.addStaff({ pin: '4321', host: true })
		await openHostStand(page)
		await page.getByRole('button', { name: /^Table 9, open/ }).click()
		const sheet = page.getByRole('dialog', { name: 'Table 9' })
		await sheet.getByRole('button', { name: 'Seat 2 now' }).click()
		await expectToast(page, 'Seated a walk-in of 2 at 9.')
		await expect(
			page.getByRole('button', { name: /^Table 9, seated/ }),
		).toBeVisible()
	})

	test('a host sees that there is an allergy and the end of the number; guest details show the rest', async ({
		unpaired: page,
	}) => {
		await backend.addStaff({ first: 'Cash', pin: '1111', host: true })
		await backend.addStaff({ first: 'Lina', pin: '4321', host: 'guest' })
		await openHostStand(page, '1111')
		const dock = page.getByRole('region', { name: 'Parties to seat' })
		await dock.getByRole('button', { name: 'Details for Maya H.' }).click()
		const sheet = page.getByRole('dialog', { name: 'Maya Haddad' })
		await expect(
			sheet.getByText('Allergy noted. A manager can see the details.'),
		).toBeVisible()
		await expect(sheet.getByText('Peanuts')).toHaveCount(0)
		// The number is masked by the server, and is not a link to call.
		await expect(sheet.getByText(/^•••• \d{4}$/)).toBeVisible()
		await expect(sheet.locator('a[href^="tel:"]')).toHaveCount(0)
		await sheet.getByRole('button', { name: 'Close' }).click()

		await page.getByRole('button', { name: /^Lock the till/ }).click()
		await signInWithPin(page, '4321')
		await dock.getByRole('button', { name: 'Details for Maya H.' }).click()
		const full = page.getByRole('dialog', { name: 'Maya Haddad' })
		await expect(full.getByText('Peanuts')).toBeVisible()
		await expect(full.locator('a[href^="tel:+"]')).toBeVisible()
		await capture(page, 'host-party-sheet')
	})

	test('someone not on the host list is told so, and can switch user', async ({
		unpaired: page,
	}) => {
		await backend.addStaff({ first: 'Cash', pin: '1111' })
		await backend.floor()
		await pairUi(page, {
			signInRequired: true,
			reservationsEnabled: true,
			locationId: 'loc-1',
		})
		await signInWithPin(page, '1111')
		await page
			.getByRole('radiogroup', { name: 'Station app' })
			.getByRole('radio', { name: 'Reservations' })
			.click()
		await expect(
			page.getByRole('heading', {
				name: 'You are not on this terminal’s host list',
			}),
		).toBeVisible()
		await page.getByRole('button', { name: 'Switch user' }).click()
		await expect(lockScreen(page)).toBeVisible()
	})

	test('the waitlist sits in the dock and a party there is seated from it', async ({
		unpaired: page,
	}) => {
		await backend.addStaff({ pin: '4321', host: true })
		await openHostStand(page)
		const dock = page.getByRole('region', { name: 'Parties to seat' })
		await dock.getByRole('button', { name: /Rana/ }).first().click()
		await expect(page.getByText(/Tap a table for Rana Khalid/)).toBeVisible()
		await page.getByRole('button', { name: /^Table 9, open/ }).click()
		await expectToast(page, 'Seated Rana Khalid at 9.')
		await expect(dock.getByText('Rana')).toHaveCount(0)
	})

	test('a table too small for the party asks first, and the party stays picked up', async ({
		unpaired: page,
	}) => {
		await backend.addStaff({ pin: '4321', host: true })
		await openHostStand(page)
		const dock = page.getByRole('region', { name: 'Parties to seat' })
		await dock.getByRole('button', { name: /Tariq/ }).first().click()
		await page.getByRole('button', { name: /^Table 2,/ }).click()
		const ask = page.getByRole('dialog', { name: 'Table 2 is small for them' })
		await expect(ask).toBeVisible()
		await ask.getByRole('button', { name: 'Choose another' }).click()
		await expect(page.getByText(/Tap a table for Tariq/)).toBeVisible()
		await page.getByRole('button', { name: /^Table 7, open/ }).click()
		await expectToast(page, 'Seated Tariq Aziz at 7.')
	})

	test('a table booked before the party would be done steps back, and the host may still insist', async ({
		unpaired: page,
	}) => {
		await backend.addStaff({ pin: '4321', host: true })
		await openHostStand(page)
		const dock = page.getByRole('region', { name: 'Parties to seat' })
		await dock.getByRole('button', { name: /Rana/ }).first().click()
		// Table 1 holds a booking within the hour: it does not lift for this party.
		const busy = page.getByRole('button', { name: /^Table 1,/ })
		await expect(busy).toHaveAttribute('data-fits', 'false')
		await expect(
			page.getByRole('button', { name: /^Table 9,/ }),
		).toHaveAttribute('data-fits', 'true')
		await busy.click()
		await page.getByRole('button', { name: 'Seat anyway' }).click()
		await expectToast(page, 'Seated Rana Khalid at 1.')
	})

	test('a new booking takes its time from availability', async ({
		unpaired: page,
	}) => {
		await backend.addStaff({ pin: '4321', host: true })
		await openHostStand(page)
		await page.getByRole('button', { name: 'Booking' }).click()
		const sheet = page.getByRole('dialog', { name: 'New booking' })
		await sheet.getByRole('button', { name: '4', exact: true }).click()
		const slots = sheet.locator('button.tnum.min-w-20')
		await expect(slots.first()).toBeVisible()
		await capture(page, 'host-booking-sheet')
		const time = (await slots.last().textContent())!.trim()
		await slots.last().click()
		await sheet.getByLabel('First name').fill('Zaid')
		await sheet.getByLabel('Last name').fill('Omar')
		await sheet.getByRole('button', { name: `Book 4 at ${time}` }).click()
		await expectToast(page, `Booked Zaid for 4 at ${time}.`)
	})

	test('on a phone, the floor and the dock still fit', async ({
		unpaired: page,
	}) => {
		await page.setViewportSize({ width: 390, height: 844 })
		await backend.addStaff({ pin: '4321', host: true })
		await openHostStand(page)
		await capture(page, 'phone-host-floor')
		await page
			.getByRole('radiogroup', { name: 'Station app' })
			.getByRole('radio', { name: 'Time clock' })
			.click()
		await expect(
			clock(page).getByRole('heading', { name: 'Enter your PIN' }),
		).toBeVisible()
		await capture(page, 'phone-timeclock')
	})

	test('right to left, the floor and the dock read in Arabic', async ({
		unpaired: page,
	}) => {
		await backend.addStaff({ pin: '4321', host: true })
		await openHostStand(page)
		await page.evaluate(() => {
			const key = 'pos.settings.v1'
			const settings = JSON.parse(localStorage.getItem(key) ?? '{}')
			localStorage.setItem(key, JSON.stringify({ ...settings, locale: 'ar' }))
		})
		await page.reload()
		// A reload locks the till; the host stand reopens after the PIN.
		await expect(page.getByRole('dialog').first()).toBeVisible()
		await page.keyboard.type('4321')
		await page.keyboard.press('Enter')
		await expect(page.locator('html')).toHaveAttribute('dir', 'rtl')
		await expect(
			page.getByRole('region', { name: 'مجموعات بانتظار الجلوس' }),
		).toBeVisible()
		await capture(page, 'host-floor-ar')
	})
})
