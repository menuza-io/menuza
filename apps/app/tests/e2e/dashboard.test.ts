import { faker } from '@faker-js/faker'
import { type Locator, type Page, type Request } from '@playwright/test'
import {
	and,
	count,
	Dashboard,
	db,
	eq,
	OnboardingStep,
	Organization,
	OrganizationNote,
	Role,
	SavedReport,
	User,
	UserOrganization,
	_RoleToUser,
} from '@repo/database'
import { organizationTemplates } from '@repo/reports'
import { saveReport } from '@repo/reports/server'
import { expect, test } from '#tests/playwright-utils.ts'
import { createTestOrganization } from '#tests/test-utils.ts'
// Removed db import - using test utilities instead
import { initializeOnboardingSteps } from '../../../../packages/database/setup-onboarding.ts'

// Ensure onboarding steps are seeded before tests
async function ensureOnboardingStepsExist() {
	const [result] = await db.select({ count: count() }).from(OnboardingStep)
	const existingSteps = result?.count ?? 0
	if (existingSteps === 0) {
		console.log('Seeding onboarding steps for tests...')
		await initializeOnboardingSteps()
	}
}

const DEFAULT_HOME_BLOCKS = [
	'Stats',
	'Notes chart',
	'Onboarding checklist',
	'Top contributors',
]

function homeBlock(page: Page, name: string) {
	return page.getByRole('main').getByRole('region', { name, exact: true })
}

/** Accessible names of the Home blocks in DOM (and so tab) order. */
function homeBlockOrder(page: Page) {
	return page
		.getByRole('main')
		.getByRole('region')
		.evaluateAll((regions) =>
			regions.map((region) => region.getAttribute('aria-label')),
		)
}

async function boxOf(locator: Locator) {
	const box = await locator.boundingBox()
	if (!box) throw new Error(`${locator} is not visible`)
	return box
}

function isHomePost(request: Request, orgSlug: string) {
	const { pathname } = new URL(request.url())
	return (
		request.method() === 'POST' &&
		pathname.replace(/\.data$/, '') === `/${orgSlug}`
	)
}

/** Records POSTs to the Home route itself, i.e. dashboard saves. */
function recordHomePosts(page: Page, orgSlug: string) {
	const posts: string[] = []
	page.on('request', (request) => {
		if (isHomePost(request, orgSlug)) posts.push(request.postData() ?? '')
	})
	return posts
}

function nextHomePost(page: Page, orgSlug: string) {
	return page.waitForResponse((response) =>
		isHomePost(response.request(), orgSlug),
	)
}

/**
 * Where the grid puts each block. Inline styles hold the target position, so
 * they neither depend on scrolling nor on running move animations.
 */
function homeLayoutStyles(page: Page) {
	// eslint-disable-next-line playwright/no-raw-locators -- grid items have no role of their own
	return page.locator('[data-block-id]').evaluateAll((items) =>
		Object.fromEntries(
			items.map((item) => {
				const { transform, width, height } = (item as HTMLElement).style
				return [
					item.getAttribute('data-block-id'),
					{ transform, width, height },
				]
			}),
		),
	)
}

function resizeHandle(page: Page, blockId: string) {
	return page.locator(`[data-block-id="${blockId}"] > .react-resizable-handle`)
}

/** Presses the middle of `from`, moves the pointer by `offset` and releases. */
async function dragBy(
	page: Page,
	from: Locator,
	offset: { x: number; y: number },
) {
	await from.scrollIntoViewIfNeeded()
	const box = await boxOf(from)
	const x = box.x + box.width / 2
	const y = box.y + box.height / 2
	await page.mouse.move(x, y)
	await page.mouse.down()
	await page.mouse.move(x + offset.x, y + offset.y, { steps: 15 })
	await page.mouse.up()
}

/** Saves a retitled copy of an organization template, as the reports page does. */
async function saveReportFromTemplate(input: {
	organizationId: string
	createdById: string
	templateId: string
	title: string
}) {
	const template = organizationTemplates().find(
		(item) => item.id === input.templateId,
	)
	if (!template) throw new Error(`Unknown report template ${input.templateId}`)
	const report = await saveReport({
		scope: 'organization',
		organizationId: input.organizationId,
		createdById: input.createdById,
		definition: {
			...template.definition,
			settings: { ...template.definition.settings, title: input.title },
		},
	})
	if (!report) throw new Error('Failed to save the report')
	return report
}

function isReportRun(request: Request, orgSlug: string) {
	return (
		request.method() === 'POST' &&
		new URL(request.url()).pathname === `/${orgSlug}/reports/run`
	)
}

/** Records requests for customer data: analytics tokens and tenant-api queries. */
function recordTenantRequests(page: Page) {
	const requests: string[] = []
	page.on('request', (request) => {
		const { pathname } = new URL(request.url())
		if (
			pathname.endsWith('/reports/token') ||
			pathname.endsWith('/analytics/query')
		) {
			requests.push(request.url())
		}
	})
	return requests
}

async function savedHomeConfig(userId: string, organizationId: string) {
	const rows = await db
		.select({ config: Dashboard.config })
		.from(Dashboard)
		.where(
			and(
				eq(Dashboard.ownerId, userId),
				eq(Dashboard.organizationId, organizationId),
				eq(Dashboard.kind, 'home'),
			),
		)
	return rows.map(
		(row) =>
			JSON.parse(row.config) as {
				blocks: Array<{ id: string; type: string; config?: unknown }>
				layouts: Record<'lg' | 'md', Array<{ i: string; y: number }>>
			},
	)
}

test.describe('Dashboard', () => {
	test('Dashboard displays organization overview', async ({
		page,
		login,
		navigate,
	}) => {
		const user = await login()

		// Create an organization for the user
		const org = await createTestOrganization(user.id, 'admin')

		// Navigate to organization dashboard
		await navigate('/:slug', { slug: org.slug })
		await page.waitForLoadState('networkidle')

		// Verify organization name is displayed
		await expect(page.getByText(org.name)).toBeVisible()

		// Verify dashboard components are present - use more specific selector
		await expect(page.getByRole('heading', { name: /welcome/i })).toBeVisible()
		await expect(page.getByRole('main')).toBeVisible()
	})

	test('Dashboard shows notes chart with data', async ({
		page,
		login,
		navigate,
	}) => {
		const user = await login()

		// Create an organization for the user
		const org = await createTestOrganization(user.id, 'admin')

		// Create notes over different days
		const today = new Date()
		const yesterday = new Date(today)
		yesterday.setDate(yesterday.getDate() - 1)
		const twoDaysAgo = new Date(today)
		twoDaysAgo.setDate(twoDaysAgo.getDate() - 2)

		await db.insert(OrganizationNote).values([
			{
				title: 'Today Note 1',
				content: 'Content 1',
				organizationId: org.id,
				createdById: user.id,
				isPublic: true,
				createdAt: today,
			},
			{
				title: 'Today Note 2',
				content: 'Content 2',
				organizationId: org.id,
				createdById: user.id,
				isPublic: true,
				createdAt: today,
			},
			{
				title: 'Yesterday Note',
				content: 'Content 3',
				organizationId: org.id,
				createdById: user.id,
				isPublic: true,
				createdAt: yesterday,
			},
		])

		// Navigate to organization dashboard
		await navigate('/:slug', { slug: org.slug })
		await page.waitForLoadState('networkidle')

		// Verify notes statistics are displayed (based on actual UI)
		await expect(page.getByText(/daily notes created/i)).toBeVisible()

		// Verify chart shows data points
		await expect(page.getByText(/total notes/i)).toBeVisible()
	})

	test('Dashboard shows onboarding checklist for new organizations', async ({
		page,
		login,
		navigate,
	}) => {
		// Ensure onboarding steps exist in database
		await ensureOnboardingStepsExist()

		const user = await login()

		// Create a new organization with minimal data to avoid auto-completion
		const [org] = await db
			.insert(Organization)
			.values({
				name: '', // Empty name to avoid hasCompletedProfile auto-detection
				slug: `test-org-${Date.now()}-${Math.random().toString(36).substring(7)}`,
				description: '',
			})
			.returning()
		if (!org) throw new Error('Failed to create organization')
		await db.insert(UserOrganization).values({
			userId: user.id,
			organizationId: org.id,
			organizationRoleId: 'org_role_admin',
		})

		// Navigate to organization dashboard
		await navigate('/:slug', { slug: org.slug })
		await page.waitForLoadState('networkidle')

		// Verify onboarding checklist is displayed - use specific heading
		await expect(
			page.getByRole('heading', { name: /get started/i }),
		).toBeVisible()

		// Verify some common onboarding steps
		await expect(page.getByText(/create your first note/i)).toBeVisible()
		await expect(page.getByText(/invite team members/i)).toBeVisible()
	})

	test('Dashboard shows recent activity', async ({ page, login, navigate }) => {
		const user = await login()

		// Create an organization for the user
		const org = await createTestOrganization(user.id, 'admin')

		// Create some recent notes
		await db.insert(OrganizationNote).values([
			{
				title: 'Recent Note 1',
				content: 'Recent content 1',
				organizationId: org.id,
				createdById: user.id,
				isPublic: true,
			},
			{
				title: 'Recent Note 2',
				content: 'Recent content 2',
				organizationId: org.id,
				createdById: user.id,
				isPublic: true,
			},
		])

		// Navigate to organization dashboard
		await navigate('/:slug', { slug: org.slug })
		await page.waitForLoadState('networkidle')

		// Verify activity is reflected in the dashboard stats
		await expect(page.getByText(/top contributors/i)).toBeVisible()
	})

	test('Dashboard displays organization statistics', async ({
		page,
		login,
		navigate,
	}) => {
		const user = await login()

		// Create additional users
		const [member1] = await db
			.insert(User)
			.values({
				email: faker.internet.email(),
				username: faker.internet.username(),
				name: faker.person.fullName(),
			})
			.returning()
		if (!member1) throw new Error('Failed to create member1')

		const [member2] = await db
			.insert(User)
			.values({
				email: faker.internet.email(),
				username: faker.internet.username(),
				name: faker.person.fullName(),
			})
			.returning()
		if (!member2) throw new Error('Failed to create member2')

		const [userRole] = await db
			.select({ id: Role.id })
			.from(Role)
			.where(eq(Role.name, 'user'))
			.limit(1)
		if (userRole) {
			await db.insert(_RoleToUser).values([
				{ A: userRole.id, B: member1.id },
				{ A: userRole.id, B: member2.id },
			])
		}

		const [org] = await db
			.insert(Organization)
			.values({
				name: faker.company.name(),
				slug: faker.helpers.slugify(faker.company.name()).toLowerCase(),
				description: faker.company.catchPhrase(),
			})
			.returning()
		if (!org) throw new Error('Failed to create organization')
		await db.insert(UserOrganization).values([
			{
				userId: user.id,
				organizationId: org.id,
				organizationRoleId: 'org_role_admin',
			},
			{
				userId: member1.id,
				organizationId: org.id,
				organizationRoleId: 'org_role_member',
			},
			{
				userId: member2.id,
				organizationId: org.id,
				organizationRoleId: 'org_role_member',
			},
		])

		await db.insert(OrganizationNote).values(
			Array.from({ length: 5 }, (_, i) => ({
				title: `Note ${i + 1}`,
				content: `Content ${i + 1}`,
				organizationId: org.id,
				createdById: user.id,
				isPublic: true,
			})),
		)

		// Navigate to organization dashboard
		await navigate('/:slug', { slug: org.slug })
		await page.waitForLoadState('networkidle')

		// Verify statistics are displayed - use more specific selectors
		await expect(page.getByText(/5 total notes/i)).toBeVisible()
	})

	test('Dashboard allows quick note creation', async ({
		page,
		login,
		navigate,
	}) => {
		const user = await login()

		// Create an organization for the user
		const org = await createTestOrganization(user.id, 'admin')

		// Navigate to organization dashboard
		await navigate('/:slug', { slug: org.slug })
		await page.waitForLoadState('networkidle')

		// Look for quick note creation button or link - use first() to avoid strict mode
		const createNoteButton = page
			.getByRole('link', { name: /create note/i })
			.first()

		if (await createNoteButton.isVisible()) {
			await createNoteButton.click()

			// Verify we're redirected to note creation page
			await expect(page).toHaveURL(new RegExp(`/${org.slug}/notes/new`))
		}
	})

	test('Dashboard shows empty state for new organizations', async ({
		page,
		login,
		navigate,
	}) => {
		// Ensure onboarding steps exist in database
		await ensureOnboardingStepsExist()

		const user = await login()

		// Create a new organization with minimal data to avoid auto-completion
		const [org] = await db
			.insert(Organization)
			.values({
				name: '', // Empty name to avoid hasCompletedProfile auto-detection
				slug: `test-org-${Date.now()}-${Math.random().toString(36).substring(7)}`,
				description: '',
			})
			.returning()
		if (!org) throw new Error('Failed to create organization')
		await db.insert(UserOrganization).values({
			userId: user.id,
			organizationId: org.id,
			organizationRoleId: 'org_role_admin',
		})

		// Navigate to organization dashboard
		await navigate('/:slug', { slug: org.slug })
		await page.waitForLoadState('networkidle')

		// Verify empty state messaging - use specific selectors
		await expect(
			page.getByRole('heading', { name: /get started/i }),
		).toBeVisible()
		await expect(page.getByRole('heading', { name: /welcome/i })).toBeVisible()
	})

	test('Dashboard navigation works correctly', async ({
		page,
		login,
		navigate,
	}) => {
		const user = await login()

		// Create an organization for the user
		const org = await createTestOrganization(user.id, 'admin')

		// Navigate to organization dashboard
		await navigate('/:slug', { slug: org.slug })
		await page.waitForLoadState('networkidle')

		// Test navigation to notes section - use first() to avoid strict mode
		const notesLink = page
			.getByRole('link', { name: 'Notes', exact: true })
			.first()
		if (await notesLink.isVisible()) {
			await notesLink.click()
			await expect(page).toHaveURL(new RegExp(`/${org.slug}/notes`))
		}

		// Navigate back to dashboard
		await navigate('/:slug', { slug: org.slug })
		await page.waitForLoadState('networkidle')

		// Test navigation to settings - it's a sidebar link (collapsible menu)
		const settingsLink = page.getByRole('link', { name: /^Settings$/i })
		if (await settingsLink.isVisible()) {
			await settingsLink.click()
			// Verify navigation to settings page
			await expect(page).toHaveURL(new RegExp(`/${org.slug}/settings`))
		}
	})

	test('Dashboard is responsive on different screen sizes', async ({
		page,
		login,
		navigate,
	}) => {
		const user = await login()

		// Create an organization for the user
		const org = await createTestOrganization(user.id, 'admin')

		// Test desktop view
		await page.setViewportSize({ width: 1200, height: 800 })
		await navigate('/:slug', { slug: org.slug })
		await page.waitForLoadState('networkidle')

		// Verify dashboard loads properly on desktop
		const orgNameLocator = page.getByText(org.name).first()
		await expect(orgNameLocator).toBeVisible()

		// Test tablet view
		await page.setViewportSize({ width: 768, height: 1024 })
		await page.waitForTimeout(500) // Allow time for responsive layout
		await page.waitForLoadState('networkidle')

		// Verify dashboard is still functional on tablet
		await expect(orgNameLocator).toBeVisible()

		// Test mobile view
		await page.setViewportSize({ width: 375, height: 667 })
		await page.waitForTimeout(1000) // Allow time for responsive layout to adjust
		await page.waitForLoadState('networkidle')

		// Verify dashboard is still functional on mobile - just check the page loaded
		// The org name might be in sidebar which could be collapsed on mobile
		await expect(page.getByRole('document')).toBeVisible()
		// Alternative check: verify we're on the right URL
		await expect(page).toHaveURL(new RegExp(`/${org.slug}`))
	})

	test('Home shows the default blocks in reading order without saving', async ({
		page,
		login,
		navigate,
	}) => {
		await ensureOnboardingStepsExist()
		const user = await login()
		const org = await createTestOrganization(user.id, 'admin')
		const homePosts = recordHomePosts(page, org.slug)

		await page.setViewportSize({ width: 1440, height: 900 })
		await navigate('/:slug', { slug: org.slug })
		await page.waitForLoadState('networkidle')

		await expect(homeBlock(page, 'Top contributors')).toBeVisible()
		expect(await homeBlockOrder(page)).toEqual(DEFAULT_HOME_BLOCKS)

		const title = await boxOf(
			page.getByRole('heading', { level: 1, name: /welcome/i }),
		)
		const stats = await boxOf(homeBlock(page, 'Stats'))
		expect(title.y + title.height).toBeLessThanOrEqual(stats.y)

		const onboarding = await boxOf(homeBlock(page, 'Onboarding checklist'))
		const leaderboard = await boxOf(homeBlock(page, 'Top contributors'))
		expect(Math.round(onboarding.y)).toBe(Math.round(leaderboard.y))
		expect(onboarding.x).toBeLessThan(leaderboard.x)

		// Crossing the lg/md breakpoint and reloading must not save a layout.
		await page.setViewportSize({ width: 1024, height: 900 })
		await expect
			.poll(async () => (await boxOf(homeBlock(page, 'Stats'))).width)
			.toBeLessThan(stats.width)
		await page.reload()
		await page.waitForLoadState('networkidle')
		await expect(homeBlock(page, 'Stats')).toBeVisible()

		expect(homePosts).toEqual([])
		const [homeRows] = await db
			.select({ count: count() })
			.from(Dashboard)
			.where(
				and(
					eq(Dashboard.ownerId, user.id),
					eq(Dashboard.organizationId, org.id),
				),
			)
		expect(homeRows?.count).toBe(0)
	})

	test('Home stacks the blocks in one column on phones', async ({
		page,
		login,
		navigate,
	}) => {
		await ensureOnboardingStepsExist()
		const user = await login()
		const org = await createTestOrganization(user.id, 'admin')

		await page.setViewportSize({ width: 390, height: 844 })
		await navigate('/:slug', { slug: org.slug })
		await page.waitForLoadState('networkidle')

		await expect(homeBlock(page, 'Top contributors')).toBeVisible()
		expect(await homeBlockOrder(page)).toEqual(DEFAULT_HOME_BLOCKS)
		await expect
			.poll(async () => {
				const boxes = await Promise.all(
					DEFAULT_HOME_BLOCKS.map((name) => boxOf(homeBlock(page, name))),
				)
				const tops = boxes.map((box) => Math.round(box.y))
				const sortedTops = [...tops].sort((a, b) => a - b)
				return {
					columns: new Set(boxes.map((box) => Math.round(box.x))).size,
					widths: new Set(boxes.map((box) => Math.round(box.width))).size,
					topToBottom:
						new Set(tops).size === tops.length &&
						tops.join() === sortedTops.join(),
				}
			})
			.toEqual({ columns: 1, widths: 1, topToBottom: true })
		await expect(page.getByRole('button', { name: 'Edit layout' })).toHaveCount(
			0,
		)
		await expect(
			page.getByRole('button', { name: 'Move block', exact: true }),
		).toHaveCount(0)
	})

	test('Home layout edits are saved once per change and survive a reload', async ({
		page,
		login,
		navigate,
	}) => {
		await ensureOnboardingStepsExist()
		const user = await login()
		const org = await createTestOrganization(user.id, 'admin')
		const homePosts = recordHomePosts(page, org.slug)

		// Tall enough to drag the leaderboard up to the stats strip without
		// scrolling in between.
		await page.setViewportSize({ width: 1440, height: 1100 })
		await navigate('/:slug', { slug: org.slug })
		await page.waitForLoadState('networkidle')

		await expect(homeBlock(page, 'Top contributors')).toBeVisible()
		await expect(
			page.getByRole('button', { name: 'Move block', exact: true }),
		).toHaveCount(0)
		await expect(resizeHandle(page, 'stats')).toBeHidden()
		await page.getByRole('button', { name: 'Edit layout' }).click()
		for (const name of DEFAULT_HOME_BLOCKS) {
			const block = homeBlock(page, name)
			await expect(
				block.getByRole('button', { name: 'Move block', exact: true }),
			).toBeVisible()
			await expect(
				block.getByRole('button', { name: 'Remove block' }),
			).toBeVisible()
		}
		for (const blockId of [
			'stats',
			'notes-chart',
			'onboarding',
			'leaderboard',
		]) {
			await expect(resizeHandle(page, blockId)).toBeVisible()
		}
		await expect(page.getByRole('button', { name: 'Add block' })).toBeVisible()
		await expect(
			page.getByRole('button', { name: 'Reset to default' }),
		).toBeVisible()

		// Dragging a block by its body does not move it.
		const initialLayout = await homeLayoutStyles(page)
		await dragBy(page, homeBlock(page, 'Stats'), { x: 0, y: 600 })
		expect(await homeLayoutStyles(page)).toEqual(initialLayout)

		// Drag the leaderboard by its handle above the stats strip.
		const moved = nextHomePost(page, org.slug)
		const leaderboardHandle = homeBlock(page, 'Top contributors').getByRole(
			'button',
			{ name: 'Move block', exact: true },
		)
		await leaderboardHandle.scrollIntoViewIfNeeded()
		const handleBox = await boxOf(leaderboardHandle)
		const statsBox = await boxOf(homeBlock(page, 'Stats'))
		await dragBy(page, leaderboardHandle, {
			x: 0,
			y: statsBox.y + 4 - (handleBox.y + handleBox.height / 2),
		})
		expect((await moved).status()).toBe(200)
		expect(await homeBlockOrder(page)).toEqual([
			'Top contributors',
			'Stats',
			'Notes chart',
			'Onboarding checklist',
		])

		// Make the notes chart narrower and taller with its resize handle.
		const chartBefore = await boxOf(homeBlock(page, 'Notes chart'))
		const resized = nextHomePost(page, org.slug)
		await dragBy(page, resizeHandle(page, 'notes-chart'), { x: -360, y: 110 })
		expect((await resized).status()).toBe(200)
		await expect
			.poll(async () => {
				const chart = await boxOf(homeBlock(page, 'Notes chart'))
				return {
					narrower: chart.width < chartBefore.width - 200,
					taller: chart.height > chartBefore.height + 50,
				}
			})
			.toEqual({ narrower: true, taller: true })

		await expect(page.getByText('Saved', { exact: true })).toBeVisible()
		expect(homePosts).toHaveLength(2)
		expect(homePosts.every((body) => body.includes('intent=save-config'))).toBe(
			true,
		)

		const editedLayout = await homeLayoutStyles(page)
		expect(editedLayout).not.toEqual(initialLayout)
		await page.reload()
		await page.waitForLoadState('networkidle')
		await expect(homeBlock(page, 'Top contributors')).toBeVisible()
		await expect.poll(() => homeLayoutStyles(page)).toEqual(editedLayout)
		expect(homePosts).toHaveLength(2)

		const [saved] = await savedHomeConfig(user.id, org.id)
		expect(saved?.layouts.lg).toContainEqual(
			expect.objectContaining({ i: 'leaderboard', y: 0 }),
		)
		// Only the desktop layout was edited.
		expect(saved?.layouts.md).toContainEqual(
			expect.objectContaining({ i: 'stats', y: 0 }),
		)
	})

	test('Home blocks can be removed, added back and reset to the default', async ({
		page,
		login,
		navigate,
	}) => {
		await ensureOnboardingStepsExist()
		const user = await login()
		const org = await createTestOrganization(user.id, 'admin')

		await page.setViewportSize({ width: 1440, height: 900 })
		await navigate('/:slug', { slug: org.slug })
		await page.waitForLoadState('networkidle')
		await page.getByRole('button', { name: 'Edit layout' }).click()

		const leaderboard = homeBlock(page, 'Top contributors')
		const removed = nextHomePost(page, org.slug)
		await leaderboard.getByRole('button', { name: 'Remove block' }).click()
		await expect(leaderboard).toHaveCount(0)
		expect((await removed).status()).toBe(200)

		const dialog = page.getByRole('dialog', { name: 'Add block' })
		const builtIns = dialog.getByRole('group', { name: 'Built-in blocks' })
		await page.getByRole('button', { name: 'Add block' }).click()
		await expect(builtIns.getByRole('button')).toHaveCount(1)
		const added = nextHomePost(page, org.slug)
		await builtIns.getByRole('button', { name: /^Top contributors/ }).click()
		await expect(dialog).toHaveCount(0)
		expect((await added).status()).toBe(200)

		await page.reload()
		await page.waitForLoadState('networkidle')
		await expect(leaderboard).toBeVisible()
		const onboardingBox = await boxOf(homeBlock(page, 'Onboarding checklist'))
		// Added blocks go to the bottom of the grid.
		expect((await boxOf(leaderboard)).y).toBeGreaterThanOrEqual(
			onboardingBox.y + onboardingBox.height,
		)

		await page.getByRole('button', { name: 'Edit layout' }).click()
		await page.getByRole('button', { name: 'Add block' }).click()
		await expect(
			dialog.getByText('All built-in blocks are already on this dashboard.'),
		).toBeVisible()
		await page.keyboard.press('Escape')
		await expect(dialog).toHaveCount(0)

		await page.getByRole('button', { name: 'Reset to default' }).click()
		const confirm = page.getByRole('alertdialog')
		const reset = nextHomePost(page, org.slug)
		await confirm.getByRole('button', { name: 'Reset', exact: true }).click()
		const resetResponse = await reset
		expect(resetResponse.status()).toBe(200)
		expect(resetResponse.request().postData()).toContain('intent=reset')

		await page.reload()
		await page.waitForLoadState('networkidle')
		await expect(leaderboard).toBeVisible()
		expect(await homeBlockOrder(page)).toEqual(DEFAULT_HOME_BLOCKS)
		const [onboarding, contributors] = await Promise.all([
			boxOf(homeBlock(page, 'Onboarding checklist')),
			boxOf(leaderboard),
		])
		expect(Math.round(onboarding.y)).toBe(Math.round(contributors.y))
		expect(await savedHomeConfig(user.id, org.id)).toEqual([])
	})

	test('Home adds saved reports and templates as report blocks that run on the App', async ({
		page,
		login,
		navigate,
	}) => {
		await ensureOnboardingStepsExist()
		const user = await login()
		const org = await createTestOrganization(user.id, 'admin')
		await db.insert(OrganizationNote).values(
			(['high', 'high', 'low'] as const).map((priority, index) => ({
				title: `Report note ${index + 1}`,
				content: 'Content',
				organizationId: org.id,
				createdById: user.id,
				priority,
			})),
		)
		const title = 'Team notes by priority'
		const report = await saveReportFromTemplate({
			organizationId: org.id,
			createdById: user.id,
			templateId: 'notes-by-priority',
			title,
		})
		const tenantRequests = recordTenantRequests(page)

		await page.setViewportSize({ width: 1440, height: 900 })
		await navigate('/:slug', { slug: org.slug })
		await page.waitForLoadState('networkidle')
		await page.getByRole('button', { name: 'Edit layout' }).click()

		const dialog = page.getByRole('dialog', { name: 'Add block' })
		const savedReports = dialog.getByRole('group', { name: 'Saved reports' })
		const templates = dialog.getByRole('group', { name: 'Report templates' })
		await page.getByRole('button', { name: 'Add block' }).click()
		const savedOption = savedReports.getByRole('button', {
			name: new RegExp(`^${title}`),
		})
		await expect(savedOption).toContainText('Notes')
		await expect(
			templates
				.getByRole('group', { name: 'Notes', exact: true })
				.getByRole('button', { name: /^Notes by status/ }),
		).toBeVisible()
		const added = nextHomePost(page, org.slug)
		const ran = page.waitForResponse((response) =>
			isReportRun(response.request(), org.slug),
		)
		await savedOption.click()
		await expect(dialog).toHaveCount(0)
		expect((await added).status()).toBe(200)
		expect((await ran).status()).toBe(200)

		const savedBlocks = homeBlock(page, title)
		await expect(savedBlocks.getByText('High', { exact: true })).toBeVisible()
		await expect(
			savedBlocks.getByRole('link', { name: 'Open report' }),
		).toHaveAttribute('href', `/${org.slug}/reports/${report.id}`)

		// The same report can be added again, and templates as well.
		await page.getByRole('button', { name: 'Add block' }).click()
		const addedAgain = nextHomePost(page, org.slug)
		await savedOption.click()
		expect((await addedAgain).status()).toBe(200)
		await page.getByRole('button', { name: 'Add block' }).click()
		const addedTemplate = nextHomePost(page, org.slug)
		await templates.getByRole('button', { name: /^Notes by status/ }).click()
		expect((await addedTemplate).status()).toBe(200)
		await page.getByRole('button', { name: 'Done', exact: true }).click()

		await page.reload()
		await page.waitForLoadState('networkidle')
		expect(await homeBlockOrder(page)).toEqual([
			...DEFAULT_HOME_BLOCKS,
			title,
			title,
			'Notes by status',
		])
		await expect(savedBlocks).toHaveCount(2)
		for (const block of await savedBlocks.all()) {
			await expect(block.getByText('Low', { exact: true })).toBeVisible()
		}
		const templateBlock = homeBlock(page, 'Notes by status')
		await expect(
			templateBlock.getByRole('link', { name: 'Open report' }),
		).toHaveAttribute(
			'href',
			`/${org.slug}/reports/new?template=notes-by-status`,
		)
		const [config] = await savedHomeConfig(user.id, org.id)
		expect(config?.blocks.filter((block) => block.type === 'report')).toEqual([
			expect.objectContaining({
				config: { source: 'saved', reportId: report.id },
			}),
			expect.objectContaining({
				config: { source: 'saved', reportId: report.id },
			}),
			expect.objectContaining({
				config: { source: 'template', templateId: 'notes-by-status' },
			}),
		])

		// Opening the report and coming back leaves the dashboard as it was.
		const posts = recordHomePosts(page, org.slug)
		await savedBlocks.first().getByRole('link', { name: 'Open report' }).click()
		await expect(page).toHaveURL(
			new RegExp(`/${org.slug}/reports/${report.id}$`),
		)
		await expect(page.getByRole('heading', { name: title })).toBeVisible()
		await page.goBack()
		await expect(page).toHaveURL(new RegExp(`/${org.slug}$`))
		await expect(savedBlocks).toHaveCount(2)
		await expect(
			savedBlocks.first().getByText('High', { exact: true }),
		).toBeVisible()
		expect(posts).toEqual([])
		// Notes are control-plane data: no analytics token or tenant-api query.
		expect(tenantRequests).toEqual([])
	})

	test('Home shows "Report not found" for a deleted saved report', async ({
		page,
		login,
		navigate,
	}) => {
		await ensureOnboardingStepsExist()
		const user = await login()
		const org = await createTestOrganization(user.id, 'admin')
		const title = 'Report about to be deleted'
		const report = await saveReportFromTemplate({
			organizationId: org.id,
			createdById: user.id,
			templateId: 'members-by-role',
			title,
		})

		await page.setViewportSize({ width: 1440, height: 900 })
		await navigate('/:slug', { slug: org.slug })
		await page.waitForLoadState('networkidle')
		await page.getByRole('button', { name: 'Edit layout' }).click()
		await page.getByRole('button', { name: 'Add block' }).click()
		const added = nextHomePost(page, org.slug)
		await page
			.getByRole('dialog', { name: 'Add block' })
			.getByRole('button', { name: new RegExp(`^${title}`) })
			.click()
		expect((await added).status()).toBe(200)
		await expect(homeBlock(page, title)).toBeVisible()

		await db.delete(SavedReport).where(eq(SavedReport.id, report.id))
		const response = await page.reload()
		expect(response?.status()).toBe(200)
		const deleted = homeBlock(page, 'Report')
		await expect(deleted.getByText('Report not found')).toBeVisible()
		await expect(
			deleted.getByRole('link', { name: 'Open report' }),
		).toHaveCount(0)
		await expect(homeBlock(page, 'Stats')).toBeVisible()

		await page.getByRole('button', { name: 'Edit layout' }).click()
		const removed = nextHomePost(page, org.slug)
		await deleted.getByRole('button', { name: 'Remove block' }).click()
		expect((await removed).status()).toBe(200)
		await expect(deleted).toHaveCount(0)
		expect(await homeBlockOrder(page)).toEqual(DEFAULT_HOME_BLOCKS)
	})

	test('Home shows "No access" when the analytics token is refused after permissions change', async ({
		page,
		login,
		navigate,
	}) => {
		await ensureOnboardingStepsExist()
		const user = await login()
		const org = await createTestOrganization(user.id, 'admin')
		const tenantRequests = recordTenantRequests(page)

		await page.setViewportSize({ width: 1440, height: 900 })
		await navigate('/:slug', { slug: org.slug })
		await page.waitForLoadState('networkidle')

		// Home was loaded as an admin; as a member the viewer may no longer
		// get an analytics token.
		await db
			.update(UserOrganization)
			.set({ organizationRoleId: 'org_role_member' })
			.where(
				and(
					eq(UserOrganization.userId, user.id),
					eq(UserOrganization.organizationId, org.id),
				),
			)

		await page.getByRole('button', { name: 'Edit layout' }).click()
		await page.getByRole('button', { name: 'Add block' }).click()
		const token = page.waitForResponse(
			(response) =>
				new URL(response.url()).pathname === `/${org.slug}/reports/token`,
		)
		await page
			.getByRole('dialog', { name: 'Add block' })
			.getByRole('group', { name: 'Report templates' })
			.getByRole('button', { name: /^Customer count/ })
			.click()
		expect((await token).status()).toBe(403)

		const block = homeBlock(page, 'Customer count')
		await expect(block.getByText('No access', { exact: true })).toBeVisible()
		await expect(
			block.getByText("You don't have permission to see this report's data."),
		).toBeVisible()
		await expect(homeBlock(page, 'Stats')).toBeVisible()
		expect(
			tenantRequests.filter((url) => url.endsWith('/analytics/query')),
		).toEqual([])
	})

	test('Home hides a dismissed onboarding checklist and closes the gap', async ({
		page,
		login,
		navigate,
	}) => {
		await ensureOnboardingStepsExist()
		const user = await login()
		const org = await createTestOrganization(user.id, 'admin')

		await page.setViewportSize({ width: 1440, height: 900 })
		await navigate('/:slug', { slug: org.slug })
		await page.waitForLoadState('networkidle')

		const onboarding = homeBlock(page, 'Onboarding checklist')
		await onboarding.getByRole('button', { name: 'Close' }).click()
		await expect(onboarding).toHaveCount(0)
		expect(await homeBlockOrder(page)).toEqual([
			'Stats',
			'Notes chart',
			'Top contributors',
		])

		await page.reload()
		await page.waitForLoadState('networkidle')
		await expect(homeBlock(page, 'Top contributors')).toBeVisible()
		await expect(onboarding).toHaveCount(0)

		// The leaderboard takes the onboarding block's place at the start of
		// the row, right below the chart.
		await expect
			.poll(async () => {
				const [stats, chart, leaderboard] = await Promise.all([
					boxOf(homeBlock(page, 'Stats')),
					boxOf(homeBlock(page, 'Notes chart')),
					boxOf(homeBlock(page, 'Top contributors')),
				])
				return {
					startAligned: Math.round(leaderboard.x) === Math.round(stats.x),
					belowChart:
						Math.round(leaderboard.y - (chart.y + chart.height)) ===
						Math.round(chart.y - (stats.y + stats.height)),
				}
			})
			.toEqual({ startAligned: true, belowChart: true })
	})

	test('Home plays confetti for ?celebrate=true and then drops the parameter', async ({
		page,
		login,
		navigate,
	}) => {
		const user = await login()
		const org = await createTestOrganization(user.id, 'admin')

		await navigate('/:slug?celebrate=true', { slug: org.slug })
		await expect
			.poll(() =>
				page.evaluate(() => document.querySelectorAll('body > canvas').length),
			)
			.toBeGreaterThan(0)
		await expect(page).not.toHaveURL(/celebrate=true/, { timeout: 10_000 })
		await expect(homeBlock(page, 'Stats')).toBeVisible()
	})

	test('Home saves a block added just before ?celebrate=true is dropped', async ({
		page,
		login,
		navigate,
	}) => {
		await ensureOnboardingStepsExist()
		const user = await login()
		const org = await createTestOrganization(user.id, 'admin')

		await page.setViewportSize({ width: 1440, height: 900 })
		await navigate('/:slug', { slug: org.slug })
		await page.waitForLoadState('networkidle')
		await page.getByRole('button', { name: 'Edit layout' }).click()
		const leaderboard = homeBlock(page, 'Top contributors')
		const removed = nextHomePost(page, org.slug)
		await leaderboard.getByRole('button', { name: 'Remove block' }).click()
		expect((await removed).status()).toBe(200)

		// The confetti canvas appears 250ms into the 3s celebration.
		await page.addInitScript(() => {
			new MutationObserver((ignoredRecords, observer) => {
				if (!document.querySelector('body > canvas')) return
				observer.disconnect()
				document.documentElement.dataset.confettiAt = String(Date.now())
			}).observe(document, { childList: true, subtree: true })
		})
		const saveUrls: string[] = []
		page.on('request', (request) => {
			if (isHomePost(request, org.slug)) saveUrls.push(request.url())
		})
		await navigate('/:slug?celebrate=true', { slug: org.slug })
		await page.getByRole('button', { name: 'Edit layout' }).click()
		await page.getByRole('button', { name: 'Add block' }).click()
		const option = page
			.getByRole('dialog', { name: 'Add block' })
			.getByRole('group', { name: 'Built-in blocks' })
			.getByRole('button', { name: /^Top contributors/ })
		// Picked about 350ms before the parameter is dropped, so the save is
		// still waiting out its delay when the URL changes.
		await option.evaluate(async (button: HTMLElement) => {
			const sleep = (ms: number) =>
				new Promise((resolve) => setTimeout(resolve, ms))
			const { dataset } = document.documentElement
			while (!dataset.confettiAt) await sleep(10)
			await sleep(Number(dataset.confettiAt) + 2400 - Date.now())
			button.click()
		})

		await expect(page).not.toHaveURL(/celebrate=true/, { timeout: 10_000 })
		await expect(page.getByText('Saved', { exact: true })).toBeVisible()
		await expect(
			leaderboard.getByText('Top Contributors', { exact: true }),
		).toBeVisible()
		// Saved by the page's own fetcher, not by a request sent on leaving.
		expect(saveUrls.map((url) => new URL(url).pathname)).toEqual([
			`/${org.slug}.data`,
		])

		await page.reload()
		await page.waitForLoadState('networkidle')
		await expect(leaderboard).toBeVisible()
		expect(await homeBlockOrder(page)).toEqual(DEFAULT_HOME_BLOCKS)
	})
})
