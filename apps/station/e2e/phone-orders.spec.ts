import { type Page } from '@playwright/test'
import { pickupLocalValue } from '../src/lib/pickup.ts'
import {
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
	openOrders,
	test,
} from './helpers.ts'

async function enterPhone(page: Page, scheduled = false) {
	await cart(page)
		.getByRole('button', { name: 'Phone order', exact: true })
		.click()
	const sheet = page.getByRole('dialog', { name: 'Phone order', exact: true })
	await sheet.getByLabel('Customer name').fill('Sam Test')
	await sheet.getByLabel('Callback number').fill('+966 (50) 123-4567')
	let pickupAt: number | null = null
	if (scheduled) {
		await sheet.getByRole('radio', { name: 'Scheduled', exact: true }).click()
		pickupAt = Math.ceil((Date.now() + 86_400_000) / 60_000) * 60_000
		await sheet
			.getByLabel('Pickup date and time')
			.fill(pickupLocalValue(pickupAt, 'Asia/Riyadh'))
	}
	await sheet.getByRole('button', { name: 'Use these details' }).click()
	await expect(sheet).toHaveCount(0)
	return pickupAt
}

test('scheduled phone pickup survives offline save, reload, sync, edits and payment at pickup', async ({
	paired: page,
	context,
}) => {
	await backend.location({ timezone: 'Asia/Riyadh' })
	await page.getByRole('button', { name: 'Refresh menu' }).click()
	await fillCart(page, 1)
	const uploads = captureUploads(page)
	const pickupAt = await enterPhone(page, true)
	await expect(
		cart(page).getByText('Phone · Pickup', { exact: true }),
	).toBeVisible()
	await expect(
		cart(page).getByRole('radiogroup', { name: 'Order type' }),
	).toHaveCount(0)
	await goOffline(context, page)
	await cart(page).getByRole('button', { name: 'Pay at pickup' }).click()
	await expect(
		cart(page).getByRole('button', { name: 'Pay later', exact: true }),
	).toBeDisabled()
	await page.reload()
	const orders = await openOrders(page)
	await expect(
		orders.getByRole('region', { name: 'Order details' }),
	).toContainText('+966501234567')
	await closeDialog(page)
	await goOnline(context, page)
	const [stored] = await expectStored(1)
	expect(stored).toMatchObject({
		orderSource: 'phone',
		orderType: 'takeaway',
		customerPhone: '+966501234567',
		guestName: 'Sam Test',
		pickupAt,
		pickupTimeZone: 'Asia/Riyadh',
		status: 'open',
	})
	expect(uploads.some((u) => new URL(u.url).pathname === '/pos/orders')).toBe(
		true,
	)
	const saved = await openOrders(page)
	await saved.getByRole('button', { name: 'Add items' }).click()
	await expect(
		cart(page).getByRole('button', { name: 'Edit phone order details' }),
	).toContainText('Sam Test')
	await cart(page).getByRole('button', { name: 'Pay now' }).click()
	await expect(
		dialog(page).getByText('Phone · Pickup', { exact: true }),
	).toBeVisible()
	await confirmButton(dialog(page)).click()
	await expect(
		dialog(page).getByRole('heading', { name: 'Paid', exact: true }),
	).toBeVisible()
	await expect(page.locator('#receipt')).toContainText('•••• 4567')
	await expect(page.locator('#receipt')).not.toContainText('+966501234567')
	await dialog(page).getByRole('button', { name: 'New order' }).click()
	await expect(
		cart(page).getByRole('button', { name: 'Phone order', exact: true }),
	).toBeVisible()
	await expect
		.poll(async () => (await backend.orders())[0]?.status)
		.toBe('paid')
})

test('pay now preserves ASAP details and prepaid pickups remain in Phone orders on later days', async ({
	paired: page,
}) => {
	await fillCart(page, 1)
	await enterPhone(page)
	await cart(page).getByRole('button', { name: 'Pay now' }).click()
	await confirmButton(dialog(page)).click()
	await dialog(page).getByRole('button', { name: 'New order' }).click()
	const [stored] = await expectStored(1)
	expect(stored).toMatchObject({
		orderSource: 'phone',
		pickupAt: null,
		status: 'paid',
	})
	await page.evaluate(async () => {
		const db = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open('pos')
			request.onsuccess = () => resolve(request.result)
			request.onerror = () => reject(request.error)
		})
		await new Promise<void>((resolve, reject) => {
			const tx = db.transaction('orders', 'readwrite')
			const store = tx.objectStore('orders')
			const request = store.openCursor()
			request.onsuccess = () => {
				const cursor = request.result
				if (!cursor) return
				cursor.update({ ...cursor.value, businessDate: '2000-01-01' })
				cursor.continue()
			}
			tx.oncomplete = () => resolve()
			tx.onerror = () => reject(tx.error)
		})
		db.close()
	})
	const orders = await openOrders(page)
	await orders.getByRole('radio', { name: 'Phone orders', exact: true }).click()
	await expect(
		orders.getByRole('region', { name: 'Order details' }),
	).toContainText('Pickup ASAP')
	await orders
		.getByRole('searchbox', { name: 'Search orders' })
		.fill('501234567')
	await expect(
		orders.getByRole('region', { name: 'Order details' }),
	).toContainText('Sam Test')
	await page.screenshot({
		path: 'playwright-report/polish/phone-orders-desktop.png',
	})
})

test('phone details validate and cancel without altering the counter order', async ({
	demo: page,
}) => {
	await fillCart(page, 1)
	await cart(page)
		.getByRole('button', { name: 'Phone order', exact: true })
		.click()
	const sheet = page.getByRole('dialog', { name: 'Phone order', exact: true })
	await sheet.getByLabel('Customer name').fill('Sam')
	await sheet.getByLabel('Callback number').fill('123')
	await sheet.getByRole('button', { name: 'Use these details' }).click()
	await expect(sheet.getByRole('alert')).toHaveText(
		'Enter a valid callback number',
	)
	await sheet.getByLabel('Callback number').fill('0501234567')
	await sheet.getByRole('radio', { name: 'Scheduled', exact: true }).click()
	await sheet.getByLabel('Pickup date and time').fill('2000-01-01T18:00')
	await sheet.getByRole('button', { name: 'Use these details' }).click()
	await expect(sheet.getByRole('alert')).toContainText('future pickup time')
	await sheet.getByRole('button', { name: 'Cancel', exact: true }).click()
	await expect(cart(page).getByRole('radio', { name: 'Dine in' })).toBeChecked()
	await expect(
		cart(page).getByText('Truffle Fries', { exact: true }),
	).toBeVisible()
	await enterPhone(page)
	await cart(page).getByRole('button', { name: 'Switch to counter' }).click()
	await expect(cart(page)).not.toContainText('+966501234567')
	await expect(
		cart(page).getByText('Truffle Fries', { exact: true }),
	).toBeVisible()
})

for (const locale of ['en', 'ar']) {
	test(`phone pickup form fits narrow screens and keeps actions reachable (${locale})`, async ({
		demo: page,
	}) => {
		await page.setViewportSize({ width: 320, height: 700 })
		if (locale === 'ar') {
			await page.evaluate(() => {
				const settings = JSON.parse(localStorage.getItem('pos.settings.v1')!)
				localStorage.setItem(
					'pos.settings.v1',
					JSON.stringify({ ...settings, locale: 'ar' }),
				)
			})
			await page.reload()
			await page.getByRole('button', { name: /الطلب فارغ/ }).click()
		} else await page.getByRole('button', { name: /Order is empty/ }).click()
		await page
			.getByRole('button', {
				name: locale === 'ar' ? 'طلب هاتفي' : 'Phone order',
				exact: true,
			})
			.click()
		const sheet = page.getByRole('dialog', {
			name: locale === 'ar' ? 'طلب هاتفي' : 'Phone order',
			exact: true,
		})
		await sheet
			.getByRole('radio', {
				name: locale === 'ar' ? 'موعد محدد' : 'Scheduled',
				exact: true,
			})
			.click()
		await expect(
			sheet.getByRole('radio', {
				name: locale === 'ar' ? 'موعد محدد' : 'Scheduled',
				exact: true,
			}),
		).toBeChecked()
		await sheet
			.getByLabel(locale === 'ar' ? 'اسم العميل' : 'Customer name')
			.fill(locale === 'ar' ? 'سارة' : 'Sam Test')
		await sheet
			.getByLabel(locale === 'ar' ? 'رقم التواصل' : 'Callback number')
			.fill('0501234567')
		const action = sheet.getByRole('button', {
			name: locale === 'ar' ? 'استخدام هذه التفاصيل' : 'Use these details',
		})
		await expect(action).toBeInViewport()
		expect(
			await sheet.evaluate(
				(element) => element.scrollWidth <= element.clientWidth,
			),
		).toBe(true)
		await page.screenshot({
			path: `playwright-report/polish/phone-order-form-${locale}.png`,
			animations: 'disabled',
		})
	})
}
