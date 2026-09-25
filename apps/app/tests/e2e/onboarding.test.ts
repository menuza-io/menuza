import { invariant } from '@epic-web/invariant'
import { faker } from '@faker-js/faker'
import { normalizeEmail, normalizeUsername } from '@repo/auth'
import { brand } from '@repo/config/brand'
import {
	and,
	Connection,
	db,
	eq,
	like,
	RateLimitEntry,
	User,
} from '@repo/database'
import { USERNAME_MAX_LENGTH, USERNAME_MIN_LENGTH } from '@repo/validation'
import { readEmail } from '#tests/mocks/utils.ts'
import { createUser, expect, test as base } from '#tests/playwright-utils.ts'

const URL_REGEX = /(?<url>https?:\/\/[^\s$.?#].[^\s]*)/
const CODE_REGEX =
	/(?:Here's your verification code|Your verification code):?\s*(?<code>[\da-zA-Z]+)/i
function extractUrl(text: string) {
	const match = text.match(URL_REGEX)
	return match?.groups?.url
}

/**
 * Clear the DB-backed forgot-password rate-limit bucket.
 *
 * `start:mocks` (what Playwright uses under CI) runs the production build, so
 * the limiter in `apps/app/app/routes/_auth+/forgot-password.tsx` allows only
 * 3 requests per hour per IP. That counter lives in the shared test database,
 * so it accumulates across retries and across runs, and can leave the
 * "reset password with a short code" submit stuck on `/forgot-password` with a
 * 429 instead of redirecting to `/verify`. Resetting the bucket before each
 * forgot-password attempt keeps the tests isolated without weakening the
 * production limit.
 */
async function resetForgotPasswordRateLimit() {
	await db
		.delete(RateLimitEntry)
		.where(like(RateLimitEntry.keyId, 'auth-forgot-password:%'))
}

const test = base.extend<{
	getOnboardingData(): {
		username: string
		name: string
		email: string
		password: string
	}
}>({
	getOnboardingData: async ({}, use) => {
		const userData = createUser()
		await use(() => {
			const onboardingData = {
				...userData,
				password: faker.internet.password() + 'A1!',
			}
			return onboardingData
		})
		await db.delete(User).where(eq(User.username, userData.username))
	},
})

test('onboarding with link', async ({ page, getOnboardingData, navigate }) => {
	const onboardingData = getOnboardingData()

	await navigate('/')

	await page.getByRole('link', { name: /sign in/i }).click()
	await expect(page).toHaveURL(`/login`)

	const createAccountLink = page.getByRole('link', {
		name: /create account/i,
	})
	await createAccountLink.click()

	await expect(page).toHaveURL(`/signup`)

	const emailTextbox = page.getByRole('textbox', { name: /email/i })
	await emailTextbox.click()
	await emailTextbox.fill(onboardingData.email)

	await page.getByRole('button', { name: /sign up/i }).click()
	await expect(page.getByText(/check your email/i)).toBeVisible()

	const email = await readEmail(onboardingData.email)
	invariant(email, 'Email not found')
	expect(email.to).toBe(onboardingData.email.toLowerCase())
	expect(email.from).toBe(brand.supportEmail)
	expect(email.subject).toMatch(/welcome/i)
	const onboardingUrl = extractUrl(email.text)
	invariant(onboardingUrl, 'Onboarding URL not found')
	await navigate(onboardingUrl)

	await expect(page).toHaveURL(/\/verify/)

	// The verify page is now a Card component, not in main section
	await page.getByRole('button', { name: /verify/i }).click()

	await expect(page).toHaveURL(`/onboarding`)
	await page
		.getByRole('textbox', { name: /^username/i })
		.fill(onboardingData.username)

	await page
		.getByRole('textbox', { name: /full name/i })
		.fill(onboardingData.name)

	await page.getByLabel(/^password/i).fill(onboardingData.password)

	await page.getByLabel(/^confirm password/i).fill(onboardingData.password)

	await page.waitForLoadState('networkidle') // ensure js is fully loaded.

	await page.getByRole('checkbox', { name: /terms/i }).check()

	await page.getByRole('checkbox', { name: /remember me/i }).check()

	await page.getByRole('button', { name: /Create account/i }).click()

	// After onboarding, user is redirected to organizations/create page
	await expect(page).toHaveURL(`/organizations/create`)

	// Verify the welcome message appears indicating successful signup
	await expect(page.getByText(/thanks for signing up/i)).toBeVisible()
})

test('onboarding with a short code', async ({
	page,
	getOnboardingData,
	navigate,
}) => {
	const onboardingData = getOnboardingData()

	await navigate('/signup')

	const emailTextbox = page.getByRole('textbox', { name: /email/i })
	await emailTextbox.click()
	await emailTextbox.fill(onboardingData.email)

	await page.getByRole('button', { name: /sign up/i }).click()
	await expect(page.getByText(/check your email/i)).toBeVisible()

	const email = await readEmail(onboardingData.email)
	invariant(email, 'Email not found')
	expect(email.to).toBe(onboardingData.email.toLowerCase())
	expect(email.from).toBe(brand.supportEmail)
	expect(email.subject).toMatch(/welcome/i)
	const codeMatch = email.text.match(CODE_REGEX)
	const code = codeMatch?.groups?.code
	invariant(code, 'Onboarding code not found')
	await page.getByRole('textbox', { name: /code/i }).fill(code)
	// The button text is 'Verify', not 'sign up'
	await page.getByRole('button', { name: /verify/i }).click()

	await expect(page).toHaveURL(`/onboarding`)
})

test('completes onboarding after GitHub OAuth given valid user details', async ({
	page,
	prepareGitHubUser,
	navigate,
}) => {
	const ghUser = await prepareGitHubUser()

	// let's verify we do not have user with that email in our system:
	expect(
		(
			await db
				.select()
				.from(User)
				.where(eq(User.email, normalizeEmail(ghUser.primaryEmail)))
				.limit(1)
		)[0] ?? null,
	).toBeNull()

	await navigate('/signup')

	// Wait for the page to be fully loaded
	await page.waitForLoadState('networkidle')

	await page.getByRole('button', { name: /signup with github/i }).click()

	await expect(page).toHaveURL(/\/onboarding\/github/)

	// Wait longer for the GitHub OAuth flow to complete and page to load
	await page.waitForLoadState('networkidle')

	await expect(
		page.getByText(
			new RegExp(
				`Hi ${ghUser.primaryEmail}, just a few more details to get started`,
				'i',
			),
		),
	).toBeVisible()

	// fields are pre-populated for the user, so we only need to accept
	// terms of service and hit the 'crete an account' button
	const usernameInput = page.getByRole('textbox', { name: /username/i })
	await expect(usernameInput).toHaveValue(
		normalizeUsername(ghUser.profile.login),
	)
	await expect(page.getByRole('textbox', { name: /full name/i })).toHaveValue(
		ghUser.profile.name,
	)
	const createAccountButton = page.getByRole('button', {
		name: /create account/i,
	})

	await page.waitForLoadState('networkidle') // ensure js is fully loaded.
	await page
		.getByRole('checkbox', {
			name: /i agree to the terms of service and privacy policy/i,
		})
		.check()
	await createAccountButton.click()

	await expect(page).toHaveURL('/organizations')
	await expect(page.getByText(/thanks for signing up/i)).toBeVisible()

	// internally, a user has been created:
	const [createdUser] = await db
		.select()
		.from(User)
		.where(eq(User.email, normalizeEmail(ghUser.primaryEmail)))
		.limit(1)
	if (!createdUser) throw new Error('User not found')
})

test('logs user in after GitHub OAuth if they are already registered', async ({
	page,
	prepareGitHubUser,
	navigate,
}) => {
	const ghUser = await prepareGitHubUser()

	// let's verify we do not have user with that email in our system ...
	expect(
		(
			await db
				.select()
				.from(User)
				.where(eq(User.email, normalizeEmail(ghUser.primaryEmail)))
				.limit(1)
		)[0] ?? null,
	).toBeNull()
	// ... and create one:
	const name = faker.person.fullName()
	const [user] = await db
		.insert(User)
		.values({
			email: normalizeEmail(ghUser.primaryEmail),
			username: normalizeUsername(ghUser.profile.login),
			name,
		})
		.returning({ id: User.id, name: User.name })
	if (!user) throw new Error('Failed to create user')

	// let's verify there is no connection between the GitHub user
	// and out app's user:
	const [connection] = await db
		.select()
		.from(Connection)
		.where(
			and(
				eq(Connection.providerName, 'github'),
				eq(Connection.userId, user.id),
			),
		)
		.limit(1)
	expect(connection ?? null).toBeNull()

	await navigate('/signup')
	await page.getByRole('button', { name: /signup with github/i }).click()

	await expect(page).toHaveURL(`/organizations/create`)

	// internally, a connection (rather than a new user) has been created:
	const [linkedConnection] = await db
		.select()
		.from(Connection)
		.where(
			and(
				eq(Connection.providerName, 'github'),
				eq(Connection.userId, user.id),
			),
		)
		.limit(1)
	if (!linkedConnection) throw new Error('Connection not found')
})

test('shows help texts on entering invalid details on onboarding page after GitHub OAuth', async ({
	page,
	prepareGitHubUser,
	navigate,
}) => {
	const ghUser = await prepareGitHubUser()

	await navigate('/signup')
	await page.getByRole('button', { name: /signup with github/i }).click()

	await expect(page).toHaveURL(/\/onboarding\/github/)
	await expect(
		page.getByText(
			new RegExp(
				`Hi ${ghUser.primaryEmail}, just a few more details to get started`,
				'i',
			),
		),
	).toBeVisible()

	const usernameInput = page.getByRole('textbox', { name: /username/i })

	// notice, how button is currently in 'idle' (neutral) state and so has got no companion
	const createAccountButton = page.getByRole('button', {
		name: /create account/i,
	})
	await expect(createAccountButton.getByRole('status')).not.toBeVisible()
	await expect(createAccountButton.getByText('error')).not.toBeAttached()

	// invalid chars in username
	await usernameInput.fill('U$er_name') // $ is invalid char, see app/utils/user-validation.ts.
	await createAccountButton.click()

	/* eslint-disable playwright/no-raw-locators -- SVG elements don't have accessible roles */
	await expect(
		createAccountButton.getByRole('img').or(createAccountButton.locator('svg')),
	).toBeVisible()
	/* eslint-enable playwright/no-raw-locators */
	await expect(
		page.getByText(
			/username can only include letters, numbers, and underscores/i,
		),
	).toBeVisible()
	// but we also never checked that privacy consent box
	await expect(
		page.getByText(
			/you must agree to the terms of service and privacy policy/i,
		),
	).toBeVisible()
	await expect(page).toHaveURL(/\/onboarding\/github/)

	// empty username
	await usernameInput.fill('')
	await createAccountButton.click()
	await expect(page.getByText(/username is required/i)).toBeVisible()
	await expect(page).toHaveURL(/\/onboarding\/github/)

	// too short username
	await usernameInput.fill(
		faker.string.alphanumeric({ length: USERNAME_MIN_LENGTH - 1 }),
	)
	await createAccountButton.click()
	await expect(page.getByText(/username is too short/i)).toBeVisible()

	// too long username
	await usernameInput.fill(
		faker.string.alphanumeric({
			length: USERNAME_MAX_LENGTH + 1,
		}),
	)
	// we are truncating the user's input
	expect(await usernameInput.inputValue()).toHaveLength(USERNAME_MAX_LENGTH)
	await createAccountButton.click()
	await expect(page.getByText(/username is too long/i)).not.toBeVisible()

	// still unchecked 'terms of service' checkbox
	await usernameInput.fill(
		normalizeUsername(`U5er_name_0k_${faker.person.lastName()}`),
	)
	await createAccountButton.click()
	await expect(
		page.getByText(/must agree to the terms of service and privacy policy/i),
	).toBeVisible()
	await expect(page).toHaveURL(/\/onboarding\/github/)

	// we are all set up and ...

	await page.waitForLoadState('networkidle') // ensure js is fully loaded.
	await page
		.getByRole('checkbox', {
			name: /i agree to the terms of service and privacy policy/i,
		})
		.check()
	await createAccountButton.click()
	await expect(createAccountButton.getByText('error')).not.toBeAttached()

	// ... sign up is successful!
	await expect(page.getByText(/thanks for signing up/i)).toBeVisible()
})

test('login as existing user', async ({ page, insertNewUser, navigate }) => {
	const password = faker.internet.password() + 'A1!'
	const user = await insertNewUser({ password })
	invariant(user.name, 'User name not found')
	await navigate('/login')
	await page
		.getByRole('textbox', { name: /^email or username$/i })
		.fill(user.username)
	await page.getByRole('button', { name: 'Continue', exact: true }).click()
	await page.getByLabel(/^password$/i).fill(password)
	await page
		.getByRole('button', { name: 'Sign In', exact: true })
		.click({ force: true })

	// Wait for navigation or error message
	try {
		// Wait for either successful redirect to home page or stay on login page
		await page.waitForURL('/organizations/create')
	} catch (error) {
		// If we didn't redirect to home, we're probably still on login page
		console.log('Login did not redirect to home page. Current URL:', page.url())

		// Check if there are any error messages (but don't wait too long)
		/* eslint-disable playwright/no-raw-locators -- CSS classes needed as fallback for error elements without role */
		const errorElements = page
			.getByRole('alert')
			.or(page.locator('.error, .text-red-500, .text-destructive'))
		/* eslint-enable playwright/no-raw-locators */
		const errorCount = await errorElements.count()

		if (errorCount > 0) {
			const errorMessage = await errorElements.first().textContent()
			console.log('Error message found:', errorMessage)
		} else {
			console.log('No error messages found on page')
		}

		// Take a screenshot for debugging
		await page.screenshot({ path: 'login-failure-debug.png' })

		// Re-throw the error to fail the test
		throw error
	}

	// After login, user should be redirected and see the Dashboard button in header
	await expect(
		page.getByRole('heading', { name: 'Create a new restaurant' }),
	).toBeVisible()
})

test('reset password with a link', async ({
	page,
	insertNewUser,
	navigate,
}) => {
	const originalPassword = faker.internet.password() + 'A1!'
	const user = await insertNewUser({ password: originalPassword })
	invariant(user.name, 'User name not found')

	// Keep this attempt from inheriting the shared rate-limit budget.
	await resetForgotPasswordRateLimit()

	await navigate('/login')
	await page
		.getByRole('textbox', { name: /email or username/i })
		.fill(user.username)
	await page.getByRole('button', { name: 'Continue', exact: true }).click()
	await page.getByRole('link', { name: /forgot your password/i }).click()
	await expect(page).toHaveURL('/forgot-password')

	await expect(page.getByText(/forgot password/i)).toBeVisible()

	await page
		.getByRole('textbox', { name: /username or email/i })
		.fill(user.username)
	await page
		.getByRole('button', { name: /send reset instructions/i })
		.click({ force: true })

	// Wait for redirect to verify page after successful form submission
	await expect(page).toHaveURL(/\/verify\?/)

	const email = await readEmail(user.email)
	invariant(email, 'Email not found')
	expect(email.subject).toMatch(/password reset/i)
	expect(email.to).toBe(user.email.toLowerCase())
	expect(email.from).toBe(brand.supportEmail)
	const resetPasswordUrl = extractUrl(email.text)
	invariant(resetPasswordUrl, 'Reset password URL not found')
	await navigate(resetPasswordUrl)

	await expect(page).toHaveURL(/\/verify/)

	// Wait for the verify form to be fully loaded
	await expect(page.getByRole('textbox', { name: /code/i })).toBeVisible()

	// Check if code is pre-filled, if not extract and fill it
	const codeInput = page.getByRole('textbox', { name: /code/i })
	const codeValue = await codeInput.inputValue()

	if (!codeValue) {
		// Extract code from email if not pre-filled
		const codeMatch = email.text.match(CODE_REGEX)
		const code = codeMatch?.groups?.code
		invariant(code, 'Reset Password code not found')
		await codeInput.fill(code)
	}

	await page.getByRole('button', { name: /verify/i }).click()

	await expect(page).toHaveURL(`/reset-password`)

	// Generate a stronger password that meets all requirements
	const newPassword = 'NewPassword123!'

	// Wait for the form to be fully loaded
	await page.waitForLoadState('networkidle')

	// Fill the password fields
	await page.getByLabel(/^new password$/i).fill(newPassword)
	await page.getByLabel(/^confirm password$/i).fill(newPassword)

	// Click the reset password button
	await page.getByRole('button', { name: /reset password/i }).click()

	// Wait for successful redirect to login page
	await expect(page).toHaveURL('/login')

	// Wait for login page to fully load
	await page.waitForLoadState('networkidle')

	// Try logging in with the new password directly
	await page
		.getByRole('textbox', { name: /^email or username$/i })
		.fill(user.username)
	await page.getByRole('button', { name: 'Continue', exact: true }).click()
	await page.getByLabel(/^password$/i).fill(newPassword)
	await page
		.getByRole('button', { name: 'Sign In', exact: true })
		.click({ force: true })

	// Wait for login to complete and redirect to home page
	await expect(page).toHaveURL(`/organizations/create`)

	await expect(
		page.getByRole('heading', { name: 'Create a new restaurant' }),
	).toBeVisible()
})

test('reset password with a short code', async ({
	page,
	insertNewUser,
	navigate,
}) => {
	const user = await insertNewUser()
	// Keep this attempt from inheriting the shared rate-limit budget (earlier
	// forgot-password submits, including retries, consume the same bucket).
	await resetForgotPasswordRateLimit()
	await navigate('/login')
	await page
		.getByRole('textbox', { name: /email or username/i })
		.fill(user.username)
	await page.getByRole('button', { name: 'Continue', exact: true }).click()
	await page.getByRole('link', { name: /forgot your password/i }).click()
	await expect(page).toHaveURL('/forgot-password')
	await expect(page.getByText(/forgot password/i)).toBeVisible()
	await page
		.getByRole('textbox', { name: /username or email/i })
		.fill(user.username)
	await page
		.getByRole('button', { name: /send reset instructions/i })
		.click({ force: true })

	// Wait for redirect to verify page after successful form submission
	await expect(page).toHaveURL(/\/verify\?/)

	const email = await readEmail(user.email)
	invariant(email, 'Email not found')
	expect(email.subject).toMatch(/password reset/i)
	expect(email.to).toBe(user.email)
	expect(email.from).toBe(brand.supportEmail)
	const codeMatch = email.text.match(CODE_REGEX)
	const code = codeMatch?.groups?.code
	invariant(code, 'Reset Password code not found')
	await page.getByRole('textbox', { name: /code/i }).fill(code)
	await page.getByRole('button', { name: /verify/i }).click()

	await expect(page).toHaveURL(`/reset-password`)
})
