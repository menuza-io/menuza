import { type Page } from '@playwright/test'
import {
	ANA,
	backend,
	expect,
	LINA,
	pairUi,
	selectStationApp,
	signInWithPin,
	test,
	trapPrint,
} from './helpers.ts'

type Stored = {
	orders: Array<{
		number: string
		status: string
		paymentStatus: string
		refundedCents: number
	}>
	events: Array<{
		action: string
		staffId: string | null
		reason: string | null
		amountCents: number | null
	}>
}
const stored = () => backend.get<Stored>('/__test/online-orders')
const storedOrder = async (number: string) =>
	(await stored()).orders.find((order) => order.number === number)!

const screen = (page: Page) => page.getByRole('main', { name: 'Online orders' })
const card = (page: Page, number: string) =>
	screen(page).getByRole('article', { name: `Order ${number}`, exact: true })
const sheet = (page: Page, number: string) =>
	page.getByRole('dialog', { name: `Order ${number}` })

/** A signed-in counter at loc-1 with the Orders app switched on, and two online orders waiting. */
async function counter(page: Page) {
	const ids = {
		ana: await backend.addStaff(ANA),
		lina: await backend.addStaff(LINA),
	}
	const code = await pairUi(page, {
		signInRequired: true,
		locationId: 'loc-1',
	})
	const device = (await backend.devices()).find(
		(entry) => entry.terminalCode === code && entry.revokedAt === null,
	)!
	await backend.post('/__test/terminal', {
		id: device.id,
		ordersEnabled: true,
	})
	await backend.post('/__test/online-orders')
	// The till learns its apps when it checks in again.
	await page.reload()
	return ids
}

test('a cashier sees new orders with an alert, opens one, marks ready and hands over after taking payment', async ({
	unpaired: page,
}) => {
	const ids = await counter(page)
	await signInWithPin(page, ANA.pin)
	await selectStationApp(page, 'Online orders')
	await expect(screen(page)).toBeVisible()

	// A new order rings and shows until someone opens it.
	const alert = page.getByRole('region', { name: 'New orders waiting' })
	await expect(alert).toContainText('WEB-0100')
	await expect(card(page, 'WEB-0101')).toContainText('Delivery')
	await expect(screen(page)).not.toContainText('+15555550199')

	await alert.getByRole('button', { name: 'Open WEB-0100' }).click()
	const order = sheet(page, 'WEB-0100')
	await expect(order).toContainText('No onion')
	await expect(order).toContainText('•••• 0199')
	await expect(order).not.toContainText('5555550199')
	// A cashier has no contact, cancel or refund actions.
	await expect(order.getByRole('button', { name: 'Show contact' })).toHaveCount(
		0,
	)
	await expect(order.getByRole('button', { name: 'Cancel order' })).toHaveCount(
		0,
	)
	await expect(alert).toHaveCount(0)

	await order.getByRole('button', { name: 'Mark ready' }).click()
	await expect
		.poll(async () => (await storedOrder('WEB-0100')).status)
		.toBe('ready')
	// Pay at handoff: handing over waits for the payment.
	const handOver = order.getByRole('button', { name: 'Hand over' })
	await expect(handOver).toBeDisabled()
	await order.getByText('I have received payment at handoff').click()
	await handOver.click()
	await expect
		.poll(async () => storedOrder('WEB-0100'))
		.toMatchObject({ status: 'completed', paymentStatus: 'paid' })
	const actions = (await stored()).events
	expect(actions.map((event) => event.action).sort()).toEqual([
		'handed_over',
		'opened',
		'paid',
		'ready',
	])
	expect(actions.every((event) => event.staffId === ids.ana)).toBe(true)

	// Reprinting the kitchen ticket prints here and is recorded.
	const prints = await trapPrint(page)
	await order.getByRole('button', { name: 'Kitchen ticket' }).click()
	await expect.poll(prints).toBe(1)
	await expect
		.poll(async () =>
			(await stored()).events.some((event) => event.action === 'reprinted'),
		)
		.toBe(true)
})

test('a manager shows the contact, records a partial refund and cancels with a reason', async ({
	unpaired: page,
}) => {
	const ids = await counter(page)
	await signInWithPin(page, LINA.pin)
	await selectStationApp(page, 'Online orders')

	await card(page, 'WEB-0101').getByRole('button', { name: 'Open' }).click()
	const delivery = sheet(page, 'WEB-0101')
	await expect(delivery).toContainText('Ring the side door')
	await delivery.getByRole('button', { name: 'Show contact' }).click()
	await expect(delivery).toContainText('+15555550199')

	await delivery.getByRole('button', { name: 'Record refund' }).click()
	const refund = page.getByRole('dialog', {
		name: 'Record a refund for WEB-0101',
	})
	await refund.getByRole('radio', { name: 'Part of it' }).click()
	await refund.getByLabel('Amount').fill('5')
	await refund.getByLabel('Reason').fill('Cold fries')
	await refund.getByRole('button', { name: /Record .*5\.00 refund/ }).click()
	await expect(refund).toHaveCount(0)
	await expect
		.poll(async () => (await storedOrder('WEB-0101')).refundedCents)
		.toBe(500)
	expect(
		(await stored()).events.find((event) => event.action === 'refunded'),
	).toMatchObject({ amountCents: 500, staffId: ids.lina })
	await delivery.getByRole('button', { name: 'Close' }).click()

	await card(page, 'WEB-0100').getByRole('button', { name: 'Open' }).click()
	const pickup = sheet(page, 'WEB-0100')
	await pickup.getByRole('button', { name: 'Cancel order' }).click()
	const cancel = page.getByRole('dialog', { name: 'Cancel order WEB-0100?' })
	await cancel.getByRole('button', { name: 'Out of stock' }).click()
	await cancel.getByRole('button', { name: 'Cancel order' }).click()
	await expect
		.poll(async () => (await storedOrder('WEB-0100')).status)
		.toBe('cancelled')
	expect(
		(await stored()).events.find((event) => event.action === 'cancelled'),
	).toMatchObject({ reason: 'out_of_stock', staffId: ids.lina })
})

test('searches today’s and recent orders by name, and by phone digits only with the contact permission', async ({
	unpaired: page,
}) => {
	await counter(page)
	await signInWithPin(page, ANA.pin)
	await selectStationApp(page, 'Online orders')
	await expect(card(page, 'WEB-0101')).toBeVisible()
	// Handed over two days ago: not in the inbox.
	await expect(card(page, 'WEB-0090')).toHaveCount(0)

	await page.getByRole('button', { name: 'Search orders' }).click()
	const search = page.getByRole('dialog', { name: 'Search orders' })
	// A cashier has no phone search.
	await expect(search.getByRole('radio', { name: 'Phone' })).toHaveCount(0)
	await search.getByLabel('Order number or guest name').fill('maya')
	await search.getByRole('button', { name: 'Search' }).click()
	const results = search.getByRole('region', { name: 'Search results' })
	await expect(results).toContainText('WEB-0100')
	await expect(results).toContainText('WEB-0090')
	await expect(results).not.toContainText('0199')

	await results.getByRole('button', { name: /WEB-0090/ }).click()
	const old = sheet(page, 'WEB-0090')
	await expect(old).toContainText('shown for reference')
	await expect(old.getByRole('button', { name: 'Hand over' })).toHaveCount(0)
	await old.getByRole('button', { name: 'Close' }).click()

	// A manager may search by the phone's last digits.
	await page.getByRole('button', { name: /^Lock the till/ }).click()
	await signInWithPin(page, LINA.pin)
	await selectStationApp(page, 'Online orders')
	await page.getByRole('button', { name: 'Search orders' }).click()
	const managerSearch = page.getByRole('dialog', { name: 'Search orders' })
	await managerSearch.getByRole('radio', { name: 'Phone' }).click()
	await managerSearch
		.getByLabel('Last digits of the guest’s phone')
		.fill('0123')
	await managerSearch.getByRole('button', { name: 'Search' }).click()
	const found = managerSearch.getByRole('region', { name: 'Search results' })
	await expect(found).toContainText('WEB-0090')
	await expect(found).not.toContainText('WEB-0100')
})

test('a manager pauses online ordering here and marks a dish sold out; a cashier has no such controls', async ({
	unpaired: page,
}) => {
	const ids = await counter(page)
	await signInWithPin(page, ANA.pin)
	await selectStationApp(page, 'Online orders')
	await expect(screen(page)).toBeVisible()
	await expect(
		page.getByRole('button', { name: 'Pause and sold out' }),
	).toHaveCount(0)

	await page.getByRole('button', { name: /^Lock the till/ }).click()
	await signInWithPin(page, LINA.pin)
	await selectStationApp(page, 'Online orders')
	await page.getByRole('button', { name: 'Pause and sold out' }).click()
	const controls = page.getByRole('dialog', { name: 'Pause and sold out' })
	await expect(controls).toContainText('Taking orders')
	await controls.getByRole('button', { name: '15 minutes' }).click()
	await expect(controls).toContainText('Paused until')

	await controls.getByLabel('Find a dish or option').fill('Truffle')
	await controls
		.getByRole('button', { name: 'Mark Truffle Fries sold out' })
		.click()
	await expect
		.poll(
			async () =>
				(
					await backend.get<{ asked: Array<Record<string, unknown>> }>(
						'/__test/station-controls',
					)
				).asked,
		)
		.toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: 'pause',
					duration: '15m',
					locationId: 'loc-1',
					actor: expect.objectContaining({ staffId: ids.lina }),
				}),
				expect.objectContaining({
					kind: 'availability',
					entityType: 'item',
					entityId: 'i-fries',
					available: false,
				}),
			]),
		)
})
