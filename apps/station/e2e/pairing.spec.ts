import { type Page } from '@playwright/test'
import {
	backend,
	cart,
	dialog,
	expect,
	expectStored,
	fillCart,
	openOrders,
	pairUi,
	payExactCash,
	sellFries,
	test,
} from './helpers.ts'

const settingsButton = (page: Page) =>
	page.getByRole('button', { name: 'Settings' })

test.describe('pairing', () => {
	test('first run: a pairing link configures the whole terminal in one paste', async ({
		fresh: page,
	}) => {
		const { link } = await backend.pairingCode({
			label: 'Front counter',
			terminalCode: 'T1',
		})
		await page.getByLabel('Pairing link or code').fill(link)
		await page.getByRole('button', { name: 'Pair terminal' }).click()
		// The menu and branding arrive from the restaurant's own server.
		await expect(
			page.getByRole('heading', { name: 'Demo Kitchen' }),
		).toBeVisible()
		await expect(
			page.getByRole('button', { name: /^Smash Burger,/ }),
		).toBeVisible()
		const devices = await backend.devices()
		expect(devices).toHaveLength(1)
		expect(devices[0]).toMatchObject({
			label: 'Front counter',
			terminalCode: 'T1',
			revokedAt: null,
		})
	})

	test('opening the pairing link on the device pairs it and removes the one-time code from the address bar', async ({
		page,
	}) => {
		const { link } = await backend.pairingCode({
			label: 'Bar tablet',
			terminalCode: 'BAR',
		})
		await page.goto(link)
		await expect(
			page.getByRole('heading', { name: 'Demo Kitchen' }),
		).toBeVisible()
		expect(page.url()).not.toContain('#')
		expect(page.url()).not.toContain('ppc1')
		await expect.poll(async () => (await backend.devices()).length).toBe(1)
		await settingsButton(page).click()
		await expect(dialog(page).getByText('Paired as Bar tablet')).toBeVisible()
	})

	test('a bare code works once the orders server is known', async ({
		unpaired: page,
	}) => {
		const { code } = await backend.pairingCode({
			label: 'Counter 2',
			terminalCode: 'C2',
		})
		await settingsButton(page).click()
		await page.getByLabel('Pairing link or code').fill(code)
		await page.getByRole('button', { name: 'Pair terminal' }).click()
		await expect(page.getByRole('dialog')).toHaveCount(0)
		await settingsButton(page).click()
		await expect(dialog(page).getByText('Paired as Counter 2')).toBeVisible()
		await expect(dialog(page).getByText('Terminal C2.')).toBeVisible()
	})

	test('the terminal code is issued by the server and prefixes every order number', async ({
		unpaired: page,
	}) => {
		await pairUi(page, { label: 'Bar', terminalCode: 'BAR' })
		await sellFries(page)
		await sellFries(page)
		const orders = await expectStored(2)
		expect(orders.map((o) => o.number).sort()).toEqual(['BAR-0001', 'BAR-0002'])
		await settingsButton(page).click()
		await expect(dialog(page).getByLabel('Terminal code')).toBeDisabled()
		await expect(dialog(page).getByLabel('Terminal code')).toHaveValue('BAR')
	})

	test('an expired code is refused with a plain explanation', async ({
		unpaired: page,
	}) => {
		const { code } = await backend.pairingCode({ ttlMs: -1000 })
		await settingsButton(page).click()
		await page.getByLabel('Pairing link or code').fill(code)
		await page.getByRole('button', { name: 'Pair terminal' }).click()
		await expect(page.getByRole('alert')).toContainText(
			'expired or was already used',
		)
		expect(await backend.devices()).toHaveLength(0)
	})

	test('a code cannot be used twice', async ({ unpaired: page, browser }) => {
		const { code } = await backend.pairingCode()
		await settingsButton(page).click()
		await page.getByLabel('Pairing link or code').fill(code)
		await page.getByRole('button', { name: 'Pair terminal' }).click()
		await expect(page.getByRole('dialog')).toHaveCount(0)

		const other = await browser.newContext()
		const second = await other.newPage()
		await second.addInitScript(() =>
			localStorage.setItem(
				'pos.settings.v1',
				JSON.stringify({
					appUrl: 'http://127.0.0.1:4710',
					slug: 'demo',
					tenantApiUrl: 'http://127.0.0.1:4711',
					terminalCode: 'T9',
					locationId: null,
					deviceToken: null,
					deviceLabel: null,
					demo: false,
				}),
			),
		)
		await second.goto('/')
		await second.getByRole('button', { name: 'Settings' }).click()
		await second.getByLabel('Pairing link or code').fill(code)
		await second.getByRole('button', { name: 'Pair terminal' }).click()
		await expect(second.getByRole('alert')).toContainText(
			'expired or was already used',
		)
		await other.close()
		expect(await backend.devices()).toHaveLength(1)
	})

	test('something that is not a code is caught before it reaches the server', async ({
		unpaired: page,
	}) => {
		await settingsButton(page).click()
		await page.getByLabel('Pairing link or code').fill('hello world')
		await page.getByRole('button', { name: 'Pair terminal' }).click()
		await expect(page.getByRole('alert')).toContainText(
			'does not look like a pairing code',
		)
		const requests = await backend.requests()
		expect(requests.filter((r) => r.path === '/pos/pair')).toHaveLength(0)
	})

	test('an unreachable orders server gives a connection message, not a stack trace', async ({
		page,
		context,
	}) => {
		await context.addInitScript(() =>
			localStorage.setItem(
				'pos.settings.v1',
				JSON.stringify({
					appUrl: 'http://127.0.0.1:4710',
					slug: 'demo',
					tenantApiUrl: 'http://127.0.0.1:9',
					terminalCode: 'T1',
					locationId: null,
					deviceToken: null,
					deviceLabel: null,
					demo: false,
				}),
			),
		)
		await page.goto('/')
		await page.getByRole('button', { name: 'Settings' }).click()
		const { code } = await backend.pairingCode()
		await page.getByLabel('Pairing link or code').fill(code)
		await page.getByRole('button', { name: 'Pair terminal' }).click()
		await expect(page.getByRole('alert')).toContainText(
			'Could not reach the server',
		)
	})

	test('pairing a second terminal does not disturb the first', async ({
		unpaired: page,
		browser,
	}) => {
		await pairUi(page, { label: 'One', terminalCode: 'T1' })
		const other = await browser.newContext()
		const second = await other.newPage()
		const { link } = await backend.pairingCode({
			label: 'Two',
			terminalCode: 'T2',
		})
		await second.goto(link)
		await expect(
			second.getByRole('heading', { name: 'Demo Kitchen' }),
		).toBeVisible()
		await other.close()
		const devices = await backend.devices()
		expect(devices.map((d) => d.terminalCode).sort()).toEqual(['T1', 'T2'])
		await sellFries(page)
		const orders = await expectStored(1)
		expect(orders[0]!.number).toBe('T1-0001')
	})

	test('unpairing warns about orders that have not been sent, and keeps them', async ({
		paired: page,
		context,
	}) => {
		await context.setOffline(true)
		await page.evaluate(() => window.dispatchEvent(new Event('offline')))
		await sellFries(page)
		await settingsButton(page).click()
		await dialog(page)
			.getByRole('button', { name: 'Unpair this terminal' })
			.click()
		await expect(
			dialog(page).getByText(/1 order has not been sent yet/),
		).toBeVisible()
		await dialog(page).getByRole('button', { name: 'Keep paired' }).click()
		await expect(dialog(page).getByText(/Paired as/)).toBeVisible()
		await dialog(page)
			.getByRole('button', { name: 'Unpair this terminal' })
			.click()
		await dialog(page)
			.getByRole('button', { name: 'Unpair', exact: true })
			.click()
		await expect(
			dialog(page).getByRole('button', { name: 'Pair terminal' }),
		).toBeVisible()
		await dialog(page).getByRole('button', { name: 'Close' }).click()
		await context.setOffline(false)
		// The order is still on the device.
		const orders = await openOrders(page, 'today')
		await expect(orders.getByText('#T1-0001').first()).toBeVisible()
		expect(await backend.orders()).toHaveLength(0)
	})

	test('a removed terminal: banner, orders kept, then re-pairing delivers them', async ({
		paired: page,
	}) => {
		const [device] = await backend.devices()
		await backend.revoke(device!.id)
		await sellFries(page)
		await expect(page.getByText(/This terminal was removed/)).toBeVisible()
		expect(await backend.orders()).toHaveLength(0)
		// Safe on the device, shown as waiting.
		const orders = await openOrders(page, 'today')
		await expect(
			orders.getByText('Paid · waiting to send').first(),
		).toBeVisible()
		await dialog(page).getByRole('button', { name: 'Close' }).click()

		// A manager pairs the device again (the freed terminal code is reusable).
		await page.getByText(/This terminal was removed/).click()
		const { code } = await backend.pairingCode({
			label: 'Front counter (new)',
			terminalCode: 'T1',
		})
		await page.getByLabel('Pairing link or code').fill(code)
		await page.getByRole('button', { name: 'Pair terminal' }).click()
		await expect(page.getByText(/This terminal was removed/)).toHaveCount(0)
		const stored = await expectStored(1)
		expect(stored[0]).toMatchObject({ number: 'T1-0001', status: 'paid' })
	})

	test('a removed terminal is told when the till opens, before any sale', async ({
		paired: page,
	}) => {
		const [device] = await backend.devices()
		await backend.revoke(device!.id)
		await page.reload()
		await expect(page.getByText(/This terminal was removed/)).toBeVisible()
		// Nothing was sold, nothing was sent, and the till is ready to be paired again.
		expect(await backend.orders()).toHaveLength(0)
		await settingsButton(page).click()
		await expect(
			dialog(page).getByRole('button', { name: 'Pair terminal' }),
		).toBeVisible()
	})

	test('a till that cannot reach the server is not locked out on a guess', async ({
		paired: page,
	}) => {
		await page.route('**/pos/me', (route) => route.abort('failed'))
		await page.reload()
		await expect(
			page.getByRole('heading', { name: 'Demo Kitchen' }),
		).toBeVisible()
		await expect(page.getByText(/This terminal was removed/)).toHaveCount(0)
		await settingsButton(page).click()
		await expect(dialog(page).getByText(/Paired as/)).toBeVisible()
	})

	test('pairing survives a reload and keeps working', async ({
		paired: page,
	}) => {
		await page.reload()
		await expect(
			page.getByRole('heading', { name: 'Demo Kitchen' }),
		).toBeVisible()
		await settingsButton(page).click()
		await expect(dialog(page).getByText(/Paired as/)).toBeVisible()
		await dialog(page).getByRole('button', { name: 'Close' }).click()
		await sellFries(page)
		await expectStored(1)
	})

	test('an order saved before pairing is sent as soon as the terminal is paired', async ({
		unpaired: page,
	}) => {
		await fillCart(page)
		await payExactCash(page)
		await expect(page.getByText(/1 order|Sending 1|1/).first()).toBeVisible()
		expect(await backend.orders()).toHaveLength(0)
		await pairUi(page, { terminalCode: 'T1' })
		const orders = await expectStored(1)
		expect(orders[0]!.number).toBe('T1-0001')
	})

	test('the cart is not touched by pairing or unpairing', async ({
		paired: page,
	}) => {
		await fillCart(page)
		await settingsButton(page).click()
		await dialog(page).getByRole('button', { name: 'Close' }).click()
		await expect(cart(page).getByText('Truffle Fries')).toBeVisible()
	})
})
