import fs from 'node:fs'
import path from 'node:path'
import { type Page } from '@playwright/test'
import {
	backend,
	cart,
	expect,
	fillCart,
	goOffline,
	pairUi,
	selectStationApp,
	signInWithPin,
	test,
} from './helpers.ts'

const launcher = (page: Page) =>
	page.getByRole('button', { name: 'Apps', exact: true })
const apps = (page: Page) => page.getByRole('dialog', { name: 'Station apps' })
const header = (page: Page) =>
	page
		.getByRole('banner')
		.filter({ has: page.locator('button[aria-haspopup="dialog"]') })

async function expectBalancedHeader(page: Page) {
	const geometry = await header(page).evaluate((el) => {
		const rect = el.getBoundingClientRect()
		const style = getComputedStyle(el)
		const buttons = Array.from(el.querySelectorAll('button'))
			.map((button) => button.getBoundingClientRect())
			.filter((button) => button.width > 0 && button.height > 0)
		return {
			paddingTop: parseFloat(style.paddingTop),
			paddingBottom: parseFloat(style.paddingBottom),
			leftInset: Math.min(...buttons.map((button) => button.left)) - rect.left,
			rightInset:
				rect.right - Math.max(...buttons.map((button) => button.right)),
			topInset: Math.min(...buttons.map((button) => button.top)) - rect.top,
			bottomInset:
				rect.bottom - Math.max(...buttons.map((button) => button.bottom)),
			touchSized: buttons.every(
				(button) => button.width >= 44 && button.height >= 44,
			),
			fits: buttons.every(
				(button) => button.left >= 0 && button.right <= window.innerWidth,
			),
		}
	})
	expect(geometry.paddingTop).toBe(geometry.paddingBottom)
	expect(
		Math.abs(geometry.leftInset - geometry.rightInset),
	).toBeLessThanOrEqual(1)
	// The visible business identity wraps above utilities on the smallest screen.
	// Both single- and two-row headers must keep symmetric vertical gutters.
	expect(
		Math.abs(geometry.topInset - geometry.bottomInset),
	).toBeLessThanOrEqual(1)
	expect(geometry.touchSized).toBe(true)
	expect(geometry.fits).toBe(true)
}

async function capture(page: Page, name: string) {
	if (!process.env.CAPTURE_DIR) return
	fs.mkdirSync(process.env.CAPTURE_DIR, { recursive: true })
	await page.emulateMedia({ reducedMotion: 'reduce' })
	await page.screenshot({
		path: path.join(process.env.CAPTURE_DIR, `${name}.png`),
		fullPage: true,
	})
}

test('one launcher shows only available apps, retains business identity and switches without losing an order', async ({
	paired: page,
}) => {
	await fillCart(page)
	await expectBalancedHeader(page)
	await capture(page, 'header-desktop')
	await launcher(page).click()
	await expect(apps(page)).toContainText('Demo Kitchen')
	await expect(apps(page).getByRole('button')).toHaveCount(2)
	await expect(
		apps(page).getByRole('button', { name: 'Register' }),
	).toHaveAttribute('aria-current', 'page')
	await capture(page, 'header-launcher')
	await apps(page).getByRole('button', { name: 'Kitchen', exact: true }).click()
	await expect(apps(page)).toHaveCount(0)
	await expect(
		page.getByRole('main', { name: 'Kitchen display' }),
	).toBeVisible()
	await selectStationApp(page, 'Register')
	await expect(cart(page).getByText('Subtotal · 2 items')).toBeVisible()
	await expect(launcher(page)).toBeFocused()
})

test('launcher supports keyboard, Escape, outside click, tab dismissal and quick reopening', async ({
	demo: page,
}) => {
	await launcher(page).focus()
	await page.keyboard.press('ArrowDown')
	await expect(
		apps(page).getByRole('button', { name: 'Register' }),
	).toBeFocused()
	await page.keyboard.press('ArrowRight')
	await expect(
		apps(page).getByRole('button', { name: 'Kitchen', exact: true }),
	).toBeFocused()
	await page.keyboard.press('Escape')
	await expect(apps(page)).toHaveCount(0)
	await expect(launcher(page)).toBeFocused()
	await launcher(page).click()
	await expect(apps(page)).toBeVisible()
	await header(page)
		.getByRole('button', { name: 'Orders', exact: true })
		.click()
	await expect(apps(page)).toHaveCount(0)
	await page
		.getByRole('dialog', { name: 'Orders' })
		.getByRole('button', { name: 'Close', exact: true })
		.click()
	await launcher(page).click()
	await page.keyboard.press('End')
	await page.keyboard.press('Tab')
	await expect(apps(page)).toHaveCount(0)
})

test('phone header keeps orders, staff lock and warnings reachable at 320px', async ({
	unpaired: page,
	context,
}) => {
	await backend.addStaff({ first: 'Rana', pin: '4321', manager: true })
	await pairUi(page, {
		signInRequired: true,
		locationId: 'loc-1',
		timeclockEnabled: true,
		reservationsEnabled: true,
	})
	await signInWithPin(page, '4321')
	await page.setViewportSize({ width: 320, height: 740 })
	await goOffline(context, page)
	await expectBalancedHeader(page)
	await capture(page, 'header-mobile-offline')
	for (const width of [360, 390]) {
		await page.setViewportSize({ width, height: 740 })
		await expectBalancedHeader(page)
	}
	await page.setViewportSize({ width: 320, height: 740 })
	await fillCart(page)
	await page.getByRole('button', { name: /View order/ }).click()
	await cart(page).getByRole('button', { name: 'Pay later' }).click()
	await expectBalancedHeader(page)
	for (const button of [
		launcher(page),
		header(page).getByRole('button', { name: /^Orders/ }),
		header(page).getByRole('button', { name: 'Settings', exact: true }),
		header(page).getByRole('button', { name: /^Lock the till/ }),
	]) {
		const box = await button.boundingBox()
		expect(box).not.toBeNull()
		expect(box!.x).toBeGreaterThanOrEqual(0)
		expect(box!.x + box!.width).toBeLessThanOrEqual(320)
		expect(box!.height).toBeGreaterThanOrEqual(44)
	}
	await expect(header(page).getByRole('status')).toContainText('1')
	await capture(page, 'header-mobile')
	await launcher(page).click()
	await expect(apps(page).getByRole('button')).toHaveCount(4)
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= window.innerWidth,
		),
	).toBe(true)
	await capture(page, 'header-mobile-launcher')
})

test('Arabic launcher mirrors its origin and stays within a narrow viewport with reduced motion', async ({
	demo: page,
}) => {
	await page.setViewportSize({ width: 390, height: 844 })
	await page.emulateMedia({ reducedMotion: 'reduce' })
	await page.evaluate(() => {
		const key = 'pos.settings.v1'
		localStorage.setItem(
			key,
			JSON.stringify({
				...JSON.parse(localStorage.getItem(key) ?? '{}'),
				locale: 'ar',
			}),
		)
	})
	await page.reload()
	await expectBalancedHeader(page)
	const trigger = page.getByRole('button', { name: 'التطبيقات', exact: true })
	await trigger.click()
	const panel = page.getByRole('dialog', { name: 'تطبيقات Station' })
	await expect(panel).toBeVisible()
	await expect(panel).toHaveAttribute('data-origin', 'top-right')
	await expect
		.poll(() => panel.evaluate((el) => getComputedStyle(el).transitionDuration))
		.toBe('0s')
	const box = await panel.boundingBox()
	expect(box!.x).toBeGreaterThanOrEqual(0)
	expect(box!.x + box!.width).toBeLessThanOrEqual(390)
	await capture(page, 'header-arabic')
	await page.keyboard.press('Escape')
	await expect(trigger).toBeFocused()
})

test('dark header keeps the launcher and all available apps legible', async ({
	unpaired: page,
}) => {
	await backend.theme({
		css: ':root{--background:oklch(.16 0 0);--foreground:oklch(.96 0 0);--card:oklch(.19 0 0);--card-foreground:oklch(.96 0 0);--popover:oklch(.22 0 0);--popover-foreground:oklch(.96 0 0);--accent:oklch(.28 0 0);--border:oklch(.32 0 0);--muted:oklch(.24 0 0);--muted-foreground:oklch(.76 0 0)}',
		mode: 'dark',
	})
	await header(page).getByRole('button', { name: 'Refresh menu' }).click()
	await expect
		.poll(() =>
			page.evaluate(() => document.documentElement.classList.contains('dark')),
		)
		.toBe(true)
	await capture(page, 'header-dark')
	await launcher(page).click()
	await capture(page, 'header-dark-launcher')
})
