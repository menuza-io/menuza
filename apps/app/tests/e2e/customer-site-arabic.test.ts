import path from 'node:path'
import { db, eq, Organization, OrganizationLocation } from '@repo/database'
import { expect, test } from '#tests/playwright-utils.ts'

const SCREENSHOTS_DIR =
	'/Users/zama/.gemini/antigravity/brain/9582b1c2-9a30-4e4d-9f43-932e789f70db/screenshots'

test.describe('Customer-Facing Site Arabic Localization & RTL Audit', () => {
	test('renders customer-facing menu, customization modal, cart drawer, and checkout in Arabic with RTL layout', async ({
		page,
	}) => {
		test.setTimeout(180_000)
		// Ensure organization exists with locales: ['en', 'ar']
		const [org] = await db
			.select()
			.from(Organization)
			.where(eq(Organization.slug, 'acme'))
			.limit(1)
		expect(org).toBeTruthy()

		// 1. Visit Arabic Menu Page
		await page.setViewportSize({ width: 1280, height: 800 })
		await page.goto('http://acme.menuza.test:3008/ar/menu')
		await page.waitForLoadState('networkidle')

		// Remove any dev toolbar for clean screenshots
		await page.evaluate(() => {
			document.querySelector('astro-dev-toolbar')?.remove()
		})

		// A. Validate HTML lang and dir attributes
		const htmlLang = await page.getAttribute('html', 'lang')
		const htmlDir = await page.getAttribute('html', 'dir')
		expect(htmlLang).toBe('ar')
		expect(htmlDir).toBe('rtl')

		// B. Validate Translated Title and Headings
		await expect(page).toHaveTitle(/القائمة والطلب/)
		await expect(
			page.getByRole('heading', { name: 'بيتزا حرفية' }),
		).toBeVisible()
		await expect(
			page.getByRole('heading', { name: 'المشروبات والحلويات' }),
		).toBeVisible()

		// C. Validate Translated Items
		await expect(page.getByText('مارغريتا د.أو.بي').first()).toBeVisible()
		await expect(page.getByText('تارتوفو وفطر الغابة').first()).toBeVisible()
		await expect(
			page.getByText('سان بيليغرينو أرانتشاتا').first(),
		).toBeVisible()
		await expect(
			page.getByText('تيراميسو البندقية التقليدي').first(),
		).toBeVisible()

		// D. Validate Clean '$' Currency Formatting (No $US or US$)
		await expect(page.getByText('$18.00').first()).toBeVisible()
		await expect(page.getByText('$22.50').first()).toBeVisible()
		const menuBody = await page.locator('body').innerText()
		expect(menuBody).not.toContain('$US')
		expect(menuBody).not.toContain('US$')

		// E. Validate Dietary Badges
		await expect(page.getByText('🌱 نباتي').first()).toBeVisible()

		// F. Desktop Screenshot of Arabic Menu
		await page.screenshot({
			path: path.join(SCREENSHOTS_DIR, 'audit-sites-menu-ar-desktop.png'),
		})

		// F. Mobile Viewport & Overflow Check
		await page.setViewportSize({ width: 390, height: 844 })
		await page.waitForTimeout(300)
		await page.evaluate(() => {
			document.querySelector('astro-dev-toolbar')?.remove()
		})

		const mobileOverflow = await page.evaluate(
			() => document.documentElement.scrollWidth > window.innerWidth,
		)
		expect(mobileOverflow).toBe(false)

		await page.screenshot({
			path: path.join(SCREENSHOTS_DIR, 'audit-sites-menu-ar-mobile.png'),
		})

		// 2. Open Item Customization Modal (on mobile first)
		const itemCard = page.locator('.js-item-card').first()
		await expect(itemCard).toBeVisible()
		await itemCard.click({ force: true })

		const modal = page.locator('#item-modal-backdrop')
		await expect(modal).not.toHaveClass(/hidden/)
		await page.waitForTimeout(400)

		// Validate Modal Contents in Arabic
		await expect(page.locator('#modal-item-name')).toContainText(
			'مارغريتا د.أو.بي',
		)
		await expect(page.getByText('اختيار العجينة')).toBeVisible()
		await expect(page.getByText('عجينة نابولية رقيقة')).toBeVisible()
		await expect(page.getByText('عجينة خالية من الغلوتين')).toBeVisible()
		await expect(page.getByText('إضافات مميزة')).toBeVisible()
		await expect(page.getByText('موزاريلا بوفالو طازجة')).toBeVisible()
		await expect(page.getByText('بروشوتو دي بارما معتق')).toBeVisible()
		await expect(page.getByText('تعليمات خاصة')).toBeVisible()
		await expect(page.getByText('الكمية')).toBeVisible()

		await page.screenshot({
			path: path.join(SCREENSHOTS_DIR, 'audit-sites-modal-ar-mobile.png'),
		})

		// Desktop Modal Screenshot
		await page.setViewportSize({ width: 1280, height: 800 })
		await page.waitForTimeout(300)
		await page.screenshot({
			path: path.join(SCREENSHOTS_DIR, 'audit-sites-modal-ar-desktop.png'),
		})

		// 3. Select Option and Add to Order
		const gfCrust = page.getByText(/عجينة خالية من الغلوتين/).first()
		if (await gfCrust.isVisible()) {
			await gfCrust.click()
		}
		const addBtn = page.locator('#modal-add-btn')
		await expect(addBtn).toContainText('إضافة إلى الطلب')
		await addBtn.click({ force: true })
		await page.waitForTimeout(400)

		// 4. Validate Cart Drawer
		await page.evaluate(() => {
			document.querySelector('astro-dev-toolbar')?.remove()
		})
		const openCartBtn = page.locator('#open-cart-btn')
		await expect(openCartBtn).toBeVisible()
		await expect(openCartBtn).toContainText('عرض الطلب')
		await openCartBtn.click({ force: true })
		await page.waitForTimeout(400)

		const drawer = page.locator('#cart-drawer')
		await expect(drawer).not.toHaveClass(/translate-x-full/)
		await expect(drawer.getByText('طلبك')).toBeVisible()
		await expect(drawer.getByText('مارغريتا د.أو.بي')).toBeVisible()
		await expect(drawer.getByText(/عجينة خالية من الغلوتين/)).toBeVisible()
		await expect(drawer.getByText('المجموع الفرعي')).toBeVisible()
		await expect(drawer.getByText('متابعة الدفع')).toBeVisible()

		await page.screenshot({
			path: path.join(
				SCREENSHOTS_DIR,
				'audit-sites-cart-drawer-ar-desktop.png',
			),
		})

		// Mobile Drawer Screenshot
		await page.setViewportSize({ width: 390, height: 844 })
		await page.waitForTimeout(300)
		await page.screenshot({
			path: path.join(SCREENSHOTS_DIR, 'audit-sites-cart-drawer-ar-mobile.png'),
		})

		// 5. Navigate to Checkout
		const checkoutBtn = page.locator('#drawer-checkout-btn')
		await checkoutBtn.click({ force: true })
		await page.waitForLoadState('networkidle')
		await page.waitForTimeout(400)

		// Validate Checkout Page is in Arabic
		expect(page.url()).toContain('/ar/menu/checkout')
		const checkoutHtmlDir = await page.getAttribute('html', 'dir')
		expect(checkoutHtmlDir).toBe('rtl')
		await expect(page).toHaveTitle(/إتمام الطلب/)

		await expect(
			page.getByRole('heading', { name: 'إتمام الطلب' }),
		).toBeVisible()
		await expect(page.getByText('العودة إلى القائمة')).toBeVisible()
		await expect(page.getByText('١. طريقة الاستلام')).toBeVisible()
		await expect(page.getByText('٢. معلومات الاتصال')).toBeVisible()
		await expect(page.getByText('إضافة إكرامية للفريق')).toBeVisible()
		await expect(page.getByText('ملخص الطلب')).toBeVisible()
		await expect(page.getByText('مارغريتا د.أو.بي')).toBeVisible()
		await expect(
			page.getByRole('button', { name: 'تأكيد الطلب' }),
		).toBeVisible()

		await page.screenshot({
			path: path.join(SCREENSHOTS_DIR, 'audit-sites-checkout-ar-mobile.png'),
		})

		// Desktop Checkout Screenshot
		await page.setViewportSize({ width: 1280, height: 800 })
		await page.waitForTimeout(300)
		await page.screenshot({
			path: path.join(SCREENSHOTS_DIR, 'audit-sites-checkout-ar-desktop.png'),
		})

		// 6. Submit Order to Success Screen
		await page.locator('#cust-name').fill('سارة أحمد')
		await page.locator('#cust-phone').fill('+966 50 123 4567')
		await page.locator('#cust-email').fill('sarah@example.com')
		await page.locator('#place-order-btn').click({ force: true })

		await page.waitForLoadState('networkidle')
		await page.waitForTimeout(600)
		await page.evaluate(() => {
			document.querySelector('astro-dev-toolbar')?.remove()
		})

		// Validate Success Page is in Arabic
		expect(page.url()).toContain('/ar/menu/success')
		const successHtmlDir = await page.getAttribute('html', 'dir')
		expect(successHtmlDir).toBe('rtl')
		await expect(page).toHaveTitle(/تم تأكيد الطلب/)

		await expect(
			page.getByRole('heading', { name: 'شكرًا لطلبك!' }),
		).toBeVisible()
		await expect(page.getByText('رقم الطلب')).toBeVisible()
		await expect(page.getByText('الوقت المقدر')).toBeVisible()
		await expect(page.getByText('إيصال الطلب')).toBeVisible()
		await expect(
			page.getByRole('link', { name: 'طلب المزيد من الطعام' }),
		).toBeVisible()
		await expect(
			page.getByRole('link', { name: 'العودة إلى الصفحة الرئيسية' }),
		).toBeVisible()

		await page.screenshot({
			path: path.join(SCREENSHOTS_DIR, 'audit-sites-success-ar-desktop.png'),
		})

		// Mobile Success Screenshot
		await page.setViewportSize({ width: 390, height: 844 })
		await page.waitForTimeout(300)
		await page.screenshot({
			path: path.join(SCREENSHOTS_DIR, 'audit-sites-success-ar-mobile.png'),
		})

		// 7. Verify Location-Tied Currency (Canada CAD vs US USD)
		await page.setViewportSize({ width: 1280, height: 800 })
		await page.goto('http://acme.menuza.test:3008/ar/menu')
		await page.waitForLoadState('networkidle')

		const locationSelect = page.locator('#location-select')
		if (await locationSelect.isVisible()) {
			const waterfrontOption = locationSelect.locator('option', {
				hasText: /تورونتو|Waterfront/i,
			})
			if ((await waterfrontOption.count()) > 0) {
				const canadaVal = await waterfrontOption.first().getAttribute('value')
				if (canadaVal) {
					await Promise.all([
						page.waitForURL(new RegExp(`location=${canadaVal}`)),
						locationSelect.selectOption(canadaVal),
					])
					await page.waitForLoadState('networkidle')
					const canadaMenuData = await page.evaluate(() => {
						const el = document.getElementById('menu-data')
						return el
							? (JSON.parse(el.textContent || '{}') as {
									currency?: string
								})
							: null
					})
					expect(canadaMenuData?.currency).toBe('CAD')

					// Verify Canadian location prices also use clean '$'
					await expect(page.getByText('$18.00').first()).toBeVisible()
					const canadaBody = await page.locator('body').innerText()
					expect(canadaBody).not.toContain('$US')
					expect(canadaBody).not.toContain('US$')
					expect(canadaBody).not.toContain('CA$')
				}
			}
		}
	})
})
