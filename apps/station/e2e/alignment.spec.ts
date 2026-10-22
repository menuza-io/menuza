import { type Locator } from '@playwright/test'
import {
	cart,
	expect,
	fillCart,
	openOrders,
	test,
	typeKeypad,
} from './helpers.ts'

async function expectStackedReadout(sheet: Locator, label: string) {
	const geometry = await sheet
		.getByText(label, { exact: true })
		.evaluate((element) => {
			const amount = element.nextElementSibling!
			const labelBox = element.getBoundingClientRect()
			const amountBox = amount.getBoundingClientRect()
			return {
				labelBottom: labelBox.bottom,
				amountTop: amountBox.top,
				labelStart: labelBox.left,
				amountStart: amountBox.left,
				labelFont: getComputedStyle(element).fontFamily,
				amountFont: getComputedStyle(amount).fontFamily,
			}
		})
	expect(geometry.amountTop).toBeGreaterThanOrEqual(geometry.labelBottom)
	expect(geometry.amountStart).toBeCloseTo(geometry.labelStart, 0)
	expect(geometry.amountFont).toBe(geometry.labelFont)
}

for (const width of [1180, 390]) {
	test(`cash drawer labels sit above their amounts at ${width}px`, async ({
		demo: page,
	}) => {
		await page.setViewportSize({ width, height: 820 })
		await page.getByRole('button', { name: 'Shift', exact: true }).click()
		const open = page.getByRole('dialog', { name: 'Open a shift', exact: true })
		await expectStackedReadout(open, 'Cash in the drawer')
		await typeKeypad(open, '10000')
		await expect(open.getByText('$100.00', { exact: true })).toBeVisible()
		await expectStackedReadout(open, 'Cash in the drawer')
		await page.screenshot({
			path: `playwright-report/polish/drawer-alignment-${width}.png`,
			animations: 'disabled',
		})
		await open.getByRole('button', { name: 'Open shift with $100.00' }).click()
		const shift = page.getByRole('dialog', { name: 'Shift', exact: true })
		await shift.getByRole('button', { name: 'Cash in', exact: true }).click()
		const movement = page.getByRole('dialog', {
			name: 'Put cash in',
			exact: true,
		})
		await expectStackedReadout(movement, 'Amount')
		await movement.getByRole('button', { name: 'Close', exact: true }).click()
		await shift
			.getByRole('button', { name: 'Close shift', exact: true })
			.click()
		await expectStackedReadout(
			page.getByRole('dialog', { name: 'Close the shift', exact: true }),
			'Cash counted',
		)
	})

	test(`Orders actions share one height and align within each row at ${width}px`, async ({
		demo: page,
	}) => {
		await fillCart(page, 1)
		await cart(page)
			.getByRole('button', { name: 'Pay later', exact: true })
			.click()
		await expect(
			cart(page).getByRole('button', { name: 'Pay later', exact: true }),
		).toBeDisabled()
		await page.setViewportSize({ width, height: 820 })
		const orders = await openOrders(page)
		if (width < 768)
			await orders.getByRole('button', { name: /#T1-0001/ }).click()
		const details = orders.getByRole('region', {
			name: 'Order details',
			exact: true,
		})
		await expect(
			details.getByRole('button', { name: /^Pay / }),
		).toBeInViewport()
		const boxes = await details
			.getByRole('button', { name: /^Pay / })
			.evaluate((pay) =>
				Array.from(pay.parentElement!.children).map((element) => {
					const box = element.getBoundingClientRect()
					return { top: box.top, bottom: box.bottom, height: box.height }
				}),
			)
		expect(boxes).toHaveLength(5)
		for (const box of boxes) {
			expect(box.height).toBe(boxes[0]!.height)
			expect(box.height).toBeGreaterThanOrEqual(44)
			expect(box.bottom).toBeLessThanOrEqual(820)
			const row = boxes.filter(
				(other) => Math.abs(other.top - box.top) < box.height,
			)
			for (const other of row) expect(other.top).toBeCloseTo(box.top, 0)
		}
		await page.screenshot({
			path: `playwright-report/polish/order-action-alignment-${width}.png`,
			animations: 'disabled',
		})
	})
}
