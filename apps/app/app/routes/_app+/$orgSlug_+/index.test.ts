import {
	and,
	Dashboard,
	DashboardShare,
	db,
	eq,
	OnboardingProgress,
	OnboardingStep,
	SavedReport,
	UserOrganization,
} from '@repo/database'
import { organizationTemplates, type ReportDefinition } from '@repo/reports'
import { describe, expect, it } from 'vitest'
import {
	defaultHomeConfig,
	MAX_DASHBOARD_BLOCKS,
	serializeDashboardConfig,
	type DashboardBlock,
	type DashboardConfig,
} from '#app/utils/dashboards/config.ts'
import { appendBlock, removeBlock } from '#app/utils/dashboards/layout.ts'
import {
	insertTestDashboard,
	insertTestMember,
	insertTestShare,
	insertTestUser,
} from '#tests/dashboard-utils.ts'
import {
	addOrganizationMember,
	createAuthenticatedRequest,
	createTestNote,
	createTestOrganization,
	getResponseStatus,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'
import { action, loader } from './index.tsx'

function loadHome(slug: string, cookie: string) {
	const request = createAuthenticatedRequest(
		`http://localhost:3000/${slug}`,
		{},
		cookie,
	)
	return loader({ request, params: { orgSlug: slug }, context: {} } as any)
}

function postHome(
	slug: string,
	cookie: string,
	body: Record<string, string> | BodyInit,
) {
	const request = createAuthenticatedRequest(
		`http://localhost:3000/${slug}?index`,
		{
			method: 'POST',
			body:
				typeof body === 'string' || body instanceof FormData
					? body
					: new URLSearchParams(body as Record<string, string>),
		},
		cookie,
	)
	return action({ request, params: { orgSlug: slug }, context: {} } as any)
}

function saveConfig(slug: string, cookie: string, config: unknown) {
	return postHome(slug, cookie, {
		intent: 'save-config',
		config: typeof config === 'string' ? config : JSON.stringify(config),
	})
}

/** The status and body of an action result, whether it is plain data or not. */
function unwrap(result: unknown) {
	const body =
		result && typeof result === 'object' && 'data' in result
			? (result as { data: unknown }).data
			: result
	return { status: getResponseStatus(result), body }
}

async function savedHomeConfig(userId: string, organizationId: string) {
	const [row] = await db
		.select({ config: Dashboard.config })
		.from(Dashboard)
		.where(
			and(
				eq(Dashboard.ownerId, userId),
				eq(Dashboard.organizationId, organizationId),
				eq(Dashboard.kind, 'home'),
			),
		)
	return row ? (JSON.parse(row.config) as DashboardConfig) : null
}

async function homeRowCount(userId: string, organizationId: string) {
	const rows = await db
		.select({ id: Dashboard.id })
		.from(Dashboard)
		.where(
			and(
				eq(Dashboard.ownerId, userId),
				eq(Dashboard.organizationId, organizationId),
				eq(Dashboard.kind, 'home'),
			),
		)
	return rows.length
}

async function insertSavedReport(input: {
	organizationId: string
	createdById: string
	title: string
	definition?: ReportDefinition
}) {
	const [report] = await db
		.insert(SavedReport)
		.values({
			scope: 'organization',
			organizationId: input.organizationId,
			createdById: input.createdById,
			title: input.title,
			definition: JSON.stringify(
				input.definition ?? { settings: { title: input.title } },
			),
		})
		.returning({ id: SavedReport.id })
	if (!report) throw new Error('Failed to create saved report')
	return report
}

function notesReportDefinition(title: string): ReportDefinition {
	const template = organizationTemplates().find(
		(item) => item.id === 'notes-by-status',
	)!
	return {
		...template.definition,
		settings: { ...template.definition.settings, title },
	}
}

function reportBlock(
	id: string,
	config: Extract<DashboardBlock, { type: 'report' }>['config'],
): DashboardBlock {
	return { id, type: 'report', config }
}

async function seedOnboardingSteps() {
	await db
		.insert(OnboardingStep)
		.values([
			{
				key: 'explore_command_menu',
				title: 'Explore the command menu',
				description: 'Use Cmd/Ctrl + K to quickly navigate',
				autoDetect: false,
				sortOrder: 1,
			},
		])
		.onConflictDoNothing()
}

function expectBadRequest(result: unknown) {
	const { status, body } = unwrap(result)
	expect(status).toBe(400)
	expect(body).toEqual({
		ok: false,
		error: { code: expect.any(String), message: expect.any(String) },
	})
	return (body as { error: { code: string; message: string } }).error
}

describe('Home dashboard loader', () => {
	it('serves the default Home without creating a row', async () => {
		const { user, organization, cookie } = await setupTestOrgWithUser('member')

		const data = await loadHome(organization.slug, cookie)

		expect(data.organization).toEqual({
			id: organization.id,
			name: organization.name,
			slug: organization.slug,
		})
		expect(data.dashboard).toEqual({
			id: null,
			kind: 'home',
			access: 'owner',
			config: defaultHomeConfig(),
		})
		expect(data.blockData.notes?.points.length).toBeGreaterThanOrEqual(7)
		expect(data.blockData.onboarding).not.toBeNull()
		expect(data.blockData.leaderboard).toEqual([])
		expect(await homeRowCount(user.id, organization.id)).toBe(0)
	})

	it('counts every contributor, not only those on the leaderboard', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		const writers = await Promise.all(
			Array.from({ length: 8 }, () => insertTestUser()),
		)
		for (const writer of writers) {
			await createTestNote(organization.id, writer.id)
			await createTestNote(organization.id, writer.id)
		}
		const outsider = await insertTestUser()
		const other = await createTestOrganization(outsider.id)
		await createTestNote(other.id, outsider.id)

		const data = await loadHome(organization.slug, cookie)

		expect(data.blockData.leaderboard).toHaveLength(6)
		expect(data.contributorCount).toBe(8)
	})

	it('makes the organization the default one for the user', async () => {
		const { user, organization, cookie } = await setupTestOrgWithUser('admin')
		const other = await createTestOrganization(user.id, 'admin')
		await db
			.update(UserOrganization)
			.set({ isDefault: true })
			.where(
				and(
					eq(UserOrganization.userId, user.id),
					eq(UserOrganization.organizationId, other.id),
				),
			)

		await loadHome(organization.slug, cookie)

		const memberships = await db
			.select({
				organizationId: UserOrganization.organizationId,
				isDefault: UserOrganization.isDefault,
			})
			.from(UserOrganization)
			.where(eq(UserOrganization.userId, user.id))
		expect(
			memberships.find((row) => row.organizationId === organization.id)
				?.isDefault,
		).toBe(true)
		expect(
			memberships.find((row) => row.organizationId === other.id)?.isDefault,
		).toBe(false)
	})

	it('uses the saved Home and only loads data for its blocks', async () => {
		const { user, organization, cookie } = await setupTestOrgWithUser('admin')
		const config = removeBlock(
			removeBlock(defaultHomeConfig(), 'leaderboard'),
			'onboarding',
		)
		const home = await insertTestDashboard({
			organizationId: organization.id,
			ownerId: user.id,
			kind: 'home',
			config,
		})

		const data = await loadHome(organization.slug, cookie)

		expect(data.dashboard).toEqual({
			id: home.id,
			kind: 'home',
			access: 'owner',
			config,
		})
		expect(data.blockData.notes).not.toBeNull()
		expect(data.blockData.leaderboard).toBeNull()
		expect(data.blockData.onboarding).toBeNull()
	})

	it('tells the block picker whether onboarding could be added back', async () => {
		await seedOnboardingSteps()
		const { user, organization, cookie } = await setupTestOrgWithUser('admin')

		const onDefaultHome = await loadHome(organization.slug, cookie)
		expect(onDefaultHome.picker).toMatchObject({ onboardingAvailable: true })

		await insertTestDashboard({
			organizationId: organization.id,
			ownerId: user.id,
			kind: 'home',
			config: removeBlock(defaultHomeConfig(), 'onboarding'),
		})
		const withoutOnboarding = await loadHome(organization.slug, cookie)
		expect(withoutOnboarding.blockData.onboarding).toBeNull()
		expect(withoutOnboarding.picker).toMatchObject({
			onboardingAvailable: true,
		})

		await db
			.update(OnboardingProgress)
			.set({ isVisible: false })
			.where(
				and(
					eq(OnboardingProgress.userId, user.id),
					eq(OnboardingProgress.organizationId, organization.id),
				),
			)
		const dismissed = await loadHome(organization.slug, cookie)
		expect(dismissed.picker).toMatchObject({ onboardingAvailable: false })
	})

	it('offers saved reports and templates to the block picker', async () => {
		const { user, organization, cookie } = await setupTestOrgWithUser('admin')
		const otherOrganization = await createTestOrganization(user.id, 'admin')
		const own = await insertSavedReport({
			organizationId: organization.id,
			createdById: user.id,
			title: 'Our notes',
			definition: notesReportDefinition('Our notes'),
		})
		await insertSavedReport({
			organizationId: otherOrganization.id,
			createdById: user.id,
			title: 'Secret revenue report',
			definition: notesReportDefinition('Secret revenue report'),
		})

		const data = await loadHome(organization.slug, cookie)

		expect(data.picker.savedReports).toEqual([
			{ id: own.id, title: 'Our notes', subjectLabel: 'Notes' },
		])
		expect(
			data.picker.templateGroups.flatMap((group) =>
				group.templates.map((template) => template.id),
			),
		).toEqual(organizationTemplates().map((template) => template.id))
	})

	it('only loads report data when Home has report blocks', async () => {
		const { user, organization, cookie } = await setupTestOrgWithUser('admin')
		const report = await insertSavedReport({
			organizationId: organization.id,
			createdById: user.id,
			title: 'Weekly notes',
			definition: notesReportDefinition('Weekly notes'),
		})

		expect((await loadHome(organization.slug, cookie)).reports).toBeNull()

		await insertTestDashboard({
			organizationId: organization.id,
			ownerId: user.id,
			kind: 'home',
			config: appendBlock(
				appendBlock(
					defaultHomeConfig(),
					reportBlock('report-1', { source: 'saved', reportId: report.id }),
				),
				reportBlock('report-2', {
					source: 'template',
					templateId: 'customer-count',
				}),
			),
		})
		const data = await loadHome(organization.slug, cookie)

		expect(data.reports).toEqual({
			savedReports: {
				[report.id]: {
					title: 'Weekly notes',
					definition: notesReportDefinition('Weekly notes'),
				},
			},
			runUrl: `/${organization.slug}/reports/run`,
			tokenUrl: `/${organization.slug}/reports/token`,
			tenantApiUrl: expect.stringMatching(/^https?:\/\//),
		})
	})

	it('still loads Home after a saved report on it was deleted', async () => {
		const { user, organization, cookie } = await setupTestOrgWithUser('member')
		const report = await insertSavedReport({
			organizationId: organization.id,
			createdById: user.id,
			title: 'Weekly notes',
			definition: notesReportDefinition('Weekly notes'),
		})
		await insertTestDashboard({
			organizationId: organization.id,
			ownerId: user.id,
			kind: 'home',
			config: appendBlock(
				defaultHomeConfig(),
				reportBlock('report-1', { source: 'saved', reportId: report.id }),
			),
		})
		await db.delete(SavedReport).where(eq(SavedReport.id, report.id))

		const data = await loadHome(organization.slug, cookie)

		expect(data.reports).toMatchObject({
			savedReports: { [report.id]: null },
		})
		expect(data.blockData.notes).not.toBeNull()
	})

	it("ignores other members' Home dashboards", async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		const { user: otherUser } = await setupTestOrgWithUser('admin')
		await db.insert(UserOrganization).values({
			userId: otherUser.id,
			organizationId: organization.id,
			organizationRoleId: 'org_role_member',
		})
		await insertTestDashboard({
			organizationId: organization.id,
			ownerId: otherUser.id,
			kind: 'home',
			config: removeBlock(defaultHomeConfig(), 'stats'),
		})

		const data = await loadHome(organization.slug, cookie)

		expect(data.dashboard.id).toBeNull()
		expect(data.dashboard.config).toEqual(defaultHomeConfig())
	})

	it('lists the custom dashboards of this organization for the switcher', async () => {
		const { user, organization, cookie } = await setupTestOrgWithUser('member')
		const otherOrganization = await createTestOrganization(user.id, 'member')
		const colleague = await insertTestMember(organization.id, {
			name: 'Bea Builder',
		})
		await addOrganizationMember(colleague.user.id, otherOrganization.id)
		const mine = await insertTestDashboard({
			organizationId: organization.id,
			ownerId: user.id,
			name: 'Sales overview',
		})
		await insertTestDashboard({
			organizationId: otherOrganization.id,
			ownerId: user.id,
			name: 'Other organization board',
		})
		const shared = await insertTestDashboard({
			organizationId: organization.id,
			ownerId: colleague.user.id,
			name: 'Team board',
		})
		const sharedElsewhere = await insertTestDashboard({
			organizationId: otherOrganization.id,
			ownerId: colleague.user.id,
			name: 'Shared in the other organization',
		})
		const unshared = await insertTestDashboard({
			organizationId: organization.id,
			ownerId: colleague.user.id,
			name: 'Private board',
		})
		for (const dashboard of [shared, sharedElsewhere]) {
			await insertTestShare({
				dashboardId: dashboard.id,
				userId: user.id,
				sharedById: colleague.user.id,
				access: 'edit',
			})
		}

		const data = await loadHome(organization.slug, cookie)

		expect(data.switcher).toEqual({
			mine: [{ id: mine.id, name: 'Sales overview' }],
			sharedWithMe: [
				{
					id: shared.id,
					name: 'Team board',
					ownerName: 'Bea Builder',
					access: 'edit',
				},
			],
		})
		expect(JSON.stringify(data.switcher)).not.toContain(unshared.id)
	})

	it('returns 404 for an organization the user is not a member of', async () => {
		const { cookie } = await setupTestOrgWithUser('admin')
		const { organization: otherOrganization } =
			await setupTestOrgWithUser('admin')

		const error = await loadHome(otherOrganization.slug, cookie).catch(
			(caught: unknown) => caught,
		)

		expect(error).toBeInstanceOf(Response)
		expect((error as Response).status).toBe(404)
	})
})

describe('Home dashboard action', () => {
	it('saves the normalized config on the first save and replaces it later', async () => {
		const { user, organization, cookie } = await setupTestOrgWithUser('member')
		const config = removeBlock(defaultHomeConfig(), 'leaderboard')
		const withRglFields = {
			...config,
			layouts: {
				lg: config.layouts.lg.map((item) => ({ ...item, moved: false })),
				md: config.layouts.md,
			},
		}

		const first = unwrap(
			await saveConfig(organization.slug, cookie, withRglFields),
		)
		expect(first).toEqual({ status: 200, body: { ok: true } })
		expect(await savedHomeConfig(user.id, organization.id)).toEqual(config)

		const moved = {
			...config,
			layouts: {
				...config.layouts,
				md: config.layouts.md.map((item) =>
					item.i === 'stats' ? { ...item, y: 20 } : item,
				),
			},
		}
		await saveConfig(organization.slug, cookie, moved)
		expect(await homeRowCount(user.id, organization.id)).toBe(1)
		const saved = await savedHomeConfig(user.id, organization.id)
		expect(saved?.layouts.md.find((item) => item.i === 'stats')?.y).toBe(20)
		expect(saved?.layouts.lg).toEqual(config.layouts.lg)

		const data = await loadHome(organization.slug, cookie)
		expect(data.dashboard.config).toEqual(saved)
		expect(data.blockData.leaderboard).toBeNull()
	})

	it("keeps each member's Home separate in each organization", async () => {
		const { user, organization, cookie } = await setupTestOrgWithUser('admin')
		const otherOrganization = await createTestOrganization(user.id, 'admin')
		const { user: colleague, cookie: colleagueCookie } =
			await setupTestOrgWithUser('member')
		await db.insert(UserOrganization).values({
			userId: colleague.id,
			organizationId: organization.id,
			organizationRoleId: 'org_role_member',
		})

		await saveConfig(
			organization.slug,
			cookie,
			removeBlock(defaultHomeConfig(), 'stats'),
		)

		const colleagueHome = await loadHome(organization.slug, colleagueCookie)
		expect(colleagueHome.dashboard.config).toEqual(defaultHomeConfig())
		const otherHome = await loadHome(otherOrganization.slug, cookie)
		expect(otherHome.dashboard.config).toEqual(defaultHomeConfig())
		const ownHome = await loadHome(organization.slug, cookie)
		expect(ownHome.dashboard.config.blocks.map((block) => block.id)).toEqual([
			'notes-chart',
			'onboarding',
			'leaderboard',
		])
	})

	it('rejects a built-in block that appears twice', async () => {
		const { user, organization, cookie } = await setupTestOrgWithUser('admin')
		const config = defaultHomeConfig()

		const error = expectBadRequest(
			await saveConfig(organization.slug, cookie, {
				...config,
				blocks: [...config.blocks, { id: 'stats-2', type: 'stats' }],
			}),
		)

		expect(error.code).toBe('duplicate-built-in')
		expect(await homeRowCount(user.id, organization.id)).toBe(0)
	})

	it('rejects more than 30 blocks', async () => {
		const { user, organization, cookie } = await setupTestOrgWithUser('admin')
		const templateId = organizationTemplates()[0]!.id
		let config = defaultHomeConfig()
		for (
			let index = config.blocks.length;
			index <= MAX_DASHBOARD_BLOCKS;
			index++
		) {
			config = appendBlock(
				config,
				reportBlock(`report-${index}`, { source: 'template', templateId }),
			)
		}
		expect(config.blocks).toHaveLength(MAX_DASHBOARD_BLOCKS + 1)

		const error = expectBadRequest(
			await saveConfig(organization.slug, cookie, config),
		)

		expect(error.code).toBe('too-many-blocks')
		expect(error.message).toContain('30')
		expect(await homeRowCount(user.id, organization.id)).toBe(0)

		const full = { ...config, blocks: config.blocks.slice(0, -1) }
		expect(unwrap(await saveConfig(organization.slug, cookie, full))).toEqual({
			status: 200,
			body: { ok: true },
		})
		const saved = await savedHomeConfig(user.id, organization.id)
		expect(saved?.blocks).toHaveLength(MAX_DASHBOARD_BLOCKS)
	})

	it('accepts organization templates and rejects unknown template ids', async () => {
		const { user, organization, cookie } = await setupTestOrgWithUser('admin')
		const templateId = organizationTemplates()[0]!.id

		const error = expectBadRequest(
			await saveConfig(
				organization.slug,
				cookie,
				appendBlock(
					defaultHomeConfig(),
					reportBlock('report-1', {
						source: 'template',
						templateId: 'does-not-exist',
					}),
				),
			),
		)
		expect(error.code).toBe('unknown-template')
		expect(await homeRowCount(user.id, organization.id)).toBe(0)

		const valid = appendBlock(
			defaultHomeConfig(),
			reportBlock('report-1', { source: 'template', templateId }),
		)
		expect(unwrap(await saveConfig(organization.slug, cookie, valid))).toEqual({
			status: 200,
			body: { ok: true },
		})
		expect(await savedHomeConfig(user.id, organization.id)).toEqual(valid)
	})

	it('rejects a saved report of another organization without revealing it', async () => {
		const { user, organization, cookie } = await setupTestOrgWithUser('admin')
		const otherOrganization = await createTestOrganization(user.id, 'admin')
		const foreign = await insertSavedReport({
			organizationId: otherOrganization.id,
			createdById: user.id,
			title: 'Secret revenue report',
		})
		const own = await insertSavedReport({
			organizationId: organization.id,
			createdById: user.id,
			title: 'Our report',
		})

		const result = await saveConfig(
			organization.slug,
			cookie,
			appendBlock(
				defaultHomeConfig(),
				reportBlock('report-1', { source: 'saved', reportId: foreign.id }),
			),
		)
		const error = expectBadRequest(result)
		expect(error.code).toBe('unknown-report')
		expect(JSON.stringify(unwrap(result).body)).not.toContain('Secret')
		expect(await homeRowCount(user.id, organization.id)).toBe(0)

		const valid = appendBlock(
			appendBlock(
				defaultHomeConfig(),
				reportBlock('report-1', { source: 'saved', reportId: own.id }),
			),
			reportBlock('report-2', { source: 'saved', reportId: own.id }),
		)
		expect(unwrap(await saveConfig(organization.slug, cookie, valid))).toEqual({
			status: 200,
			body: { ok: true },
		})
		expect(await savedHomeConfig(user.id, organization.id)).toEqual(valid)
	})

	it('still saves layout changes when a saved report on Home was deleted', async () => {
		const { user, organization, cookie } = await setupTestOrgWithUser('admin')
		const report = await insertSavedReport({
			organizationId: organization.id,
			createdById: user.id,
			title: 'Weekly report',
		})
		const withReport = appendBlock(
			defaultHomeConfig(),
			reportBlock('report-1', { source: 'saved', reportId: report.id }),
		)
		expect(
			unwrap(await saveConfig(organization.slug, cookie, withReport)),
		).toEqual({ status: 200, body: { ok: true } })
		await db.delete(SavedReport).where(eq(SavedReport.id, report.id))

		const moved = {
			...withReport,
			layouts: {
				...withReport.layouts,
				lg: withReport.layouts.lg.map((item) =>
					item.i === 'stats' ? { ...item, y: 40 } : item,
				),
			},
		}
		expect(unwrap(await saveConfig(organization.slug, cookie, moved))).toEqual({
			status: 200,
			body: { ok: true },
		})
		expect(await savedHomeConfig(user.id, organization.id)).toEqual(moved)

		const error = expectBadRequest(
			await saveConfig(
				organization.slug,
				cookie,
				appendBlock(
					moved,
					reportBlock('report-2', { source: 'saved', reportId: 'missing' }),
				),
			),
		)
		expect(error.code).toBe('unknown-report')
	})

	it('rejects malformed configs and requests with a 400', async () => {
		const { user, organization, cookie } = await setupTestOrgWithUser('admin')

		expect(
			expectBadRequest(await saveConfig(organization.slug, cookie, '{not json'))
				.code,
		).toBe('invalid-json')
		expect(
			expectBadRequest(
				await saveConfig(organization.slug, cookie, {
					version: 1,
					blocks: 'stats',
				}),
			).code,
		).toBe('invalid-shape')
		expect(
			expectBadRequest(
				await postHome(organization.slug, cookie, { intent: 'save-config' }),
			).code,
		).toBe('invalid-request')
		expect(
			expectBadRequest(
				await postHome(organization.slug, cookie, { intent: 'unknown' }),
			).code,
		).toBe('invalid-request')
		expect(
			expectBadRequest(
				await postHome(
					organization.slug,
					cookie,
					JSON.stringify({ intent: 'reset' }),
				),
			).code,
		).toBe('invalid-request')
		expect(await homeRowCount(user.id, organization.id)).toBe(0)

		const data = await loadHome(organization.slug, cookie)
		expect(data.dashboard.config).toEqual(defaultHomeConfig())
	})

	it('resets Home to the default layout by removing the saved row', async () => {
		const { user, organization, cookie } = await setupTestOrgWithUser('admin')
		await insertTestDashboard({
			organizationId: organization.id,
			ownerId: user.id,
			kind: 'home',
			config: serializeDashboardConfig(
				removeBlock(defaultHomeConfig(), 'leaderboard'),
			),
		})

		expect(
			unwrap(await postHome(organization.slug, cookie, { intent: 'reset' })),
		).toEqual({ status: 200, body: { ok: true } })

		expect(await homeRowCount(user.id, organization.id)).toBe(0)
		const data = await loadHome(organization.slug, cookie)
		expect(data.dashboard).toMatchObject({
			id: null,
			config: defaultHomeConfig(),
		})
	})

	it('refuses to rename, delete or share Home with a 403', async () => {
		const { user, organization, cookie } = await setupTestOrgWithUser('member')
		const colleague = await insertTestMember(organization.id)
		const bodies: Array<Record<string, string>> = [
			{ intent: 'rename', name: 'Not Home' },
			{ intent: 'delete' },
			{ intent: 'share', userId: colleague.user.id, access: 'view' },
			{ intent: 'unshare', userId: colleague.user.id },
		]

		// Without a saved Home row and with one.
		for (const body of bodies) {
			const { status, body: result } = unwrap(
				await postHome(organization.slug, cookie, body),
			)
			expect(status).toBe(403)
			expect(result).toEqual({
				ok: false,
				error: { code: 'forbidden', message: expect.any(String) },
			})
		}
		expect(await homeRowCount(user.id, organization.id)).toBe(0)

		const home = await insertTestDashboard({
			organizationId: organization.id,
			ownerId: user.id,
			kind: 'home',
		})
		for (const body of bodies) {
			expect(
				unwrap(await postHome(organization.slug, cookie, body)).status,
			).toBe(403)
		}
		const [row] = await db
			.select({ name: Dashboard.name, config: Dashboard.config })
			.from(Dashboard)
			.where(eq(Dashboard.id, home.id))
		expect(row).toEqual({
			name: 'Home',
			config: serializeDashboardConfig(defaultHomeConfig()),
		})
		expect(
			await db
				.select({ userId: DashboardShare.userId })
				.from(DashboardShare)
				.where(eq(DashboardShare.dashboardId, home.id)),
		).toEqual([])
	})

	it('creates a custom dashboard without touching Home', async () => {
		const { user, organization, cookie } = await setupTestOrgWithUser('member')

		const response = await postHome(organization.slug, cookie, {
			intent: 'create',
			name: ' Sales overview ',
		})

		const [created] = await db
			.select({ id: Dashboard.id, name: Dashboard.name })
			.from(Dashboard)
			.where(
				and(
					eq(Dashboard.ownerId, user.id),
					eq(Dashboard.organizationId, organization.id),
					eq(Dashboard.kind, 'custom'),
				),
			)
		expect(created?.name).toBe('Sales overview')
		expect(response).toBeInstanceOf(Response)
		expect((response as Response).headers.get('Location')).toBe(
			`/${organization.slug}/dashboards/${created!.id}`,
		)
		expect(await homeRowCount(user.id, organization.id)).toBe(0)
		expect(
			unwrap(
				await postHome(organization.slug, cookie, {
					intent: 'create',
					name: 'a'.repeat(61),
				}),
			).status,
		).toBe(400)
	})

	it('returns 404 for an organization the user is not a member of', async () => {
		const { cookie } = await setupTestOrgWithUser('admin')
		const { organization: otherOrganization } =
			await setupTestOrgWithUser('admin')

		const error = await saveConfig(
			otherOrganization.slug,
			cookie,
			defaultHomeConfig(),
		).catch((caught: unknown) => caught)

		expect(error).toBeInstanceOf(Response)
		expect((error as Response).status).toBe(404)
	})
})
