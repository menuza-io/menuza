import { faker } from '@faker-js/faker'
import { generateTOTP } from '@repo/auth'
import { expect, test, waitFor } from '#tests/playwright-utils.ts'

test('Users can add 2FA to their account and use it when logging in', async ({
	page,
	login,
	navigate,
}) => {
	const password = faker.internet.password()
	const user = await login({ password })
	await navigate('/security')
	await expect(
		page.getByRole('heading', { name: /security settings/i, level: 1 }),
	).toBeVisible()
	await page.waitForLoadState('networkidle')

	await expect(
		page.getByRole('heading', { name: /multi-factor authentication/i }),
	).toBeVisible()

	const enable2FAButton = page.getByRole('button', {
		name: /Set up authenticator app/i,
	})
	await expect(enable2FAButton).toBeVisible()
	await enable2FAButton.click()

	await expect(
		page.getByRole('heading', {
			name: 'Complete two-factor authentication setup',
		}),
	).toBeVisible({ timeout: 30000 })

	await expect(
		page.getByRole('textbox', { name: /Authentication Code/i }),
	).toBeVisible()

	await page.getByRole('tab', { name: /Setup key/i }).click()

	const otpUriElement = page.getByLabel(/One-time Password URI/i)
	await expect(otpUriElement).toBeVisible()
	const otpUriString = await otpUriElement.innerText()

	const otpUri = new URL(otpUriString)
	const options = Object.fromEntries(otpUri.searchParams)
	// otpauth URIs use "SHA1"; otplib expects "SHA-1"
	const totpOptions = { ...options, algorithm: 'SHA-1' }

	const setupCode = (await generateTOTP(totpOptions)).otp
	await page
		.getByRole('textbox', { name: /Authentication Code/i })
		.fill(setupCode)
	await page.getByRole('button', { name: /Confirm/i }).click()

	await expect(
		page.getByRole('heading', {
			name: 'Complete two-factor authentication setup',
			level: 2,
		}),
	).toBeHidden()

	// Dialog may briefly show a Disable submit while closing; wait for it to go away
	await expect(page.getByRole('dialog')).toBeHidden()
	await expect(page.getByRole('button', { name: /Disable 2FA/i })).toBeVisible()

	await page.evaluate(() => {
		const form = document.createElement('form')
		form.method = 'POST'
		form.action = '/logout'
		document.body.appendChild(form)
		form.submit()
	})
	await page.waitForURL(/\/login|\/signup/)

	await navigate('/login')
	await expect(page).toHaveURL(`/login`)
	await page
		.getByRole('textbox', { name: /email or username/i })
		.fill(user.username)
	await page.getByRole('button', { name: 'Continue', exact: true }).click()
	await page.getByLabel(/^password$/i).fill(password)
	await page
		.getByRole('button', { name: 'Sign In', exact: true })
		.click({ force: true })

	await expect(page).toHaveURL(/\/verify/)

	const codeInput = page.getByRole('textbox', { name: /code/i })
	await waitFor(
		async () => {
			const loginCode = (await generateTOTP(totpOptions)).otp
			await codeInput.fill(loginCode)
			await page.getByRole('button', { name: /verify/i }).click()
			await page.waitForURL((url) => !url.pathname.includes('/verify'), {
				timeout: 5000,
			})
			return page.url()
		},
		{
			timeout: 15000,
			errorMessage:
				'Expected to leave the 2FA verify page after submitting a code',
		},
	)

	// After 2FA, users without an org land on org creation (or home then redirect)
	await expect(page).toHaveURL(/\/(organizations\/create)?$/)

	await navigate('/')
	await page.waitForURL('/organizations/create')
	await page.waitForLoadState('networkidle')

	await expect(
		page.getByText(
			'A restaurant is your workspace to manage locations, menus, online ordering, and delivery.',
		),
	).toBeVisible()

	await expect(
		page.getByRole('heading', { name: 'Create a new restaurant' }),
	).toBeVisible()
})
