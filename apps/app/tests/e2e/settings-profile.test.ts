import { invariant } from '@epic-web/invariant'
import { faker } from '@faker-js/faker'
import { verifyUserPassword } from '@repo/auth'
import { db, eq, User } from '@repo/database'
import { readEmail } from '#tests/mocks/utils.ts'
import {
	expect,
	test,
	createUser,
	saveBar,
	waitFor,
} from '#tests/playwright-utils.ts'

// const CODE_REGEX = /Here's your verification code: (?<code>[\d\w]+)/

test('Users can update their basic info', async ({ page, login, navigate }) => {
	await login()
	await navigate('/profile')

	// Wait for the page to be fully loaded
	await page.waitForLoadState('networkidle')

	const newUserData = createUser()

	await page.getByRole('textbox', { name: /^name$/i }).fill(newUserData.name)
	await page
		.getByRole('textbox', { name: /username/i })
		.fill(newUserData.username)

	await saveBar(page).save.click()
	await expect(saveBar(page).bar).toBeHidden()
})

test('Users can update their password', async ({ page, login, navigate }) => {
	const oldPassword = faker.internet.password() + 'A1!'
	const newPassword = faker.internet.password() + 'A1!'
	const user = await login({ password: oldPassword })
	await navigate('/security')

	// Wait for the page to be fully loaded
	await page.waitForLoadState('networkidle')

	// Wait for the button to be visible and clickable, then click
	const changePasswordButton = page.getByRole('button', {
		name: 'Change Password',
	})
	await expect(changePasswordButton).toBeVisible()
	await changePasswordButton.click()

	// Wait for the password dialog to be visible and form fields to be available
	await expect(
		page.getByRole('heading', { name: 'Change Password' }),
	).toBeVisible()

	// Use dialog context and input names for password form fields
	const dialog = page.getByRole('dialog')
	await expect(dialog.getByLabel(/current password/i)).toBeVisible()

	await dialog.getByLabel(/current password/i).fill(oldPassword)
	await dialog.getByLabel(/^new password$/i).fill(newPassword)
	await dialog.getByLabel(/confirm.*password/i).fill(newPassword)

	await dialog.getByRole('button', { name: /^change password/i }).click()

	// Password dialog should close after successful change (target the dialog h2, not page h3)
	await expect(
		page.getByRole('heading', { name: 'Change Password', level: 2 }),
	).toBeHidden()

	const { username } = user
	expect(
		await verifyUserPassword({ username }, oldPassword),
		'Old password still works',
	).toBeNull()
	expect(
		await verifyUserPassword({ username }, newPassword),
		'New password does not work',
	).toEqual({ id: user.id })
})

test('Users can update their profile photo', async ({
	page,
	login,
	navigate,
}) => {
	const user = await login()
	await navigate('/profile')

	// Wait for the page to be fully loaded
	await page.waitForLoadState('networkidle')

	const beforeSrc = await page
		.getByRole('img', { name: user.name ?? user.username })
		.getAttribute('src')

	// Set the file input directly - this will trigger the dialog to open
	// eslint-disable-next-line playwright/no-raw-locators -- file inputs don't have accessible roles, must use attribute selector
	const fileInput = page.locator('input[type="file"][accept="image/*"]')
	await expect(fileInput).toBeAttached()
	await fileInput.setInputFiles(
		'../../packages/test-utils/fixtures/images/user/kody.png',
	)

	// Wait for the dialog to appear
	await expect(
		page.getByRole('heading', { name: 'Update Profile Photo' }),
	).toBeVisible()

	// The file is already set, now just click Save
	// (The file was set when we triggered the file input above)

	await page.getByRole('button', { name: /save/i }).click()

	// Photo dialog should close after saving
	await expect(
		page.getByRole('heading', { name: 'Update Profile Photo' }),
	).toBeHidden()

	// Wait for the image to reload with new src - use waitFor with a condition
	await page.waitForFunction(
		({ originalSrc, userName }) => {
			const img = document.querySelector(
				`img[alt*="${userName}"]`,
			) as HTMLImageElement
			return img && img.src !== originalSrc
		},
		{ originalSrc: beforeSrc, userName: user.name ?? user.username },
	)
})

test('Users can change their email address', async ({
	page,
	login,
	navigate,
}) => {
	const preUpdateUser = await login()
	const newEmailAddress = faker.internet.email().toLowerCase()
	expect(preUpdateUser.email).not.toEqual(newEmailAddress)
	await navigate('/profile')

	// Wait for the page to be fully loaded
	await page.waitForLoadState('networkidle')

	// Target the DialogTrigger button specifically using data attributes
	// This is the button that actually opens the email dialog

	const changeEmailButton = page.getByRole('button', { name: /^change$/i })

	await expect(changeEmailButton).toBeVisible()
	await changeEmailButton.click()

	// Wait for the email dialog to be visible
	const emailDialog = page.getByRole('dialog')
	await expect(
		emailDialog.getByRole('heading', { name: 'Change Email' }),
	).toBeVisible()
	await emailDialog
		.getByRole('textbox', { name: /email/i })
		.fill(newEmailAddress)
	await page.getByRole('button', { name: 'Save' }).click()
	// After save, the dialog shows verification info with the code directly
	await expect(
		page.getByText(/verification email has been sent/i),
	).toBeVisible()

	// Extract the verification code directly from the success message
	const codeElement = page.getByText(/Verification code:/).getByRole('strong')
	await expect(codeElement).toBeVisible()
	const code = await codeElement.innerText()
	invariant(code, 'Verification code not found in dialog')

	// Close the dialog and proceed with verification on the verify page
	await page.getByRole('button', { name: 'Close' }).first().click()

	// Navigate to the verify page for email verification
	await navigate(
		'/verify?type=change-email&target=' + encodeURIComponent(preUpdateUser.id),
	)

	// Look for verification code input on the verify page
	const codeInput = page.getByLabel('Verification Code')
	await expect(codeInput).toBeVisible()
	await codeInput.fill(code)
	await page.getByRole('button', { name: 'Verify' }).click()
	await expect(page.getByText(/email changed/i)).toBeVisible()

	const [updatedUser] = await db
		.select({ email: User.email })
		.from(User)
		.where(eq(User.id, preUpdateUser.id))
		.limit(1)
	invariant(updatedUser, 'Updated user not found')
	expect(updatedUser.email).toBe(newEmailAddress)
	const noticeEmail = await waitFor(() => readEmail(preUpdateUser.email), {
		errorMessage: 'Notice email was not sent',
	})
	expect(noticeEmail.subject).toContain('changed')
})
