import {
	and,
	db,
	eq,
	OnboardingProgress,
	OnboardingStep,
	Organization,
	OrganizationNote,
	SavedReport,
} from '@repo/database'
import {
	organizationTemplates,
	RESERVATIONS_REPORT_SUBJECTS,
	STAFF_PAY_REPORT_PERMISSION,
	STAFFING_REPORT_SUBJECTS,
	type ReportDefinition,
} from '@repo/reports'
import { describe, expect, it } from 'vitest'
import { resolveRegionalTenantApiUrls } from '#app/utils/tenant-api.server.ts'
import { insertTestUser } from '#tests/dashboard-utils.ts'
import {
	addOrganizationMember,
	createTestOrganization,
} from '#tests/test-utils.ts'
import {
	loadBlockPicker,
	loadBuiltInBlockData,
	loadReportBlockData,
	summarizeNotes,
	type NotesChartPoint,
} from './block-data.server.ts'
import {
	defaultHomeConfig,
	type DashboardBlock,
	type ReportBlockConfig,
} from './config.ts'
import { reportTemplateGroups } from './reports.ts'

const DAY_MS = 24 * 60 * 60 * 1000

function daysAgo(now: Date, days: number) {
	return new Date(now.getTime() - days * DAY_MS)
}

function points(counts: number[]): NotesChartPoint[] {
	return counts.map((notes, index) => ({
		date: `2026-01-${String(index + 1).padStart(2, '0')}`,
		day: 'Mon',
		label: `Jan ${index + 1}`,
		notes,
	}))
}

async function setupOrg({ createdAt }: { createdAt?: Date } = {}) {
	const viewer = await insertTestUser({ name: 'Vera Viewer' })
	const organization = await createTestOrganization(viewer.id, 'admin')
	if (createdAt) {
		await db
			.update(Organization)
			.set({ createdAt })
			.where(eq(Organization.id, organization.id))
	}
	return {
		viewer,
		organization: {
			id: organization.id,
			createdAt: createdAt ?? organization.createdAt,
		},
	}
}

async function insertNotes(
	organizationId: string,
	createdById: string,
	dates: Date[],
) {
	if (dates.length === 0) return
	await db.insert(OrganizationNote).values(
		dates.map((createdAt, index) => ({
			title: `Note ${index + 1}`,
			content: 'Content',
			organizationId,
			createdById,
			createdAt,
		})),
	)
}

async function seedOnboardingSteps() {
	await db
		.insert(OnboardingStep)
		.values([
			{
				key: 'create_first_note',
				title: 'Create your first note',
				description: 'Start documenting your ideas and thoughts',
				actionConfig: JSON.stringify({
					type: 'navigate',
					target: '/notes/new',
					label: 'Create Note',
				}),
				autoDetect: true,
				detectConfig: JSON.stringify({ condition: 'hasNotes' }),
				sortOrder: 1,
			},
			{
				key: 'explore_command_menu',
				title: 'Explore the command menu',
				description: 'Use Cmd/Ctrl + K to quickly navigate',
				autoDetect: false,
				sortOrder: 2,
			},
		])
		.onConflictDoNothing()
}

async function onboardingProgressRows(userId: string, organizationId: string) {
	return db
		.select()
		.from(OnboardingProgress)
		.where(
			and(
				eq(OnboardingProgress.userId, userId),
				eq(OnboardingProgress.organizationId, organizationId),
			),
		)
}

const onlyBlocks = (...types: DashboardBlock['type'][]) =>
	defaultHomeConfig().blocks.filter((block) => types.includes(block.type))

function templateDefinition(templateId: string, title: string) {
	const template = organizationTemplates().find(
		(item) => item.id === templateId,
	)
	if (!template) throw new Error(`Unknown template ${templateId}`)
	return {
		...template.definition,
		settings: { ...template.definition.settings, title },
	} satisfies ReportDefinition
}

async function insertSavedReport(input: {
	organizationId: string
	createdById: string
	title: string
	definition: ReportDefinition | string
	updatedAt?: Date
}) {
	const [report] = await db
		.insert(SavedReport)
		.values({
			scope: 'organization',
			organizationId: input.organizationId,
			createdById: input.createdById,
			title: input.title,
			definition:
				typeof input.definition === 'string'
					? input.definition
					: JSON.stringify(input.definition),
			updatedAt: input.updatedAt,
		})
		.returning({ id: SavedReport.id })
	if (!report) throw new Error('Failed to create saved report')
	return report
}

function reportBlock(id: string, config: ReportBlockConfig): DashboardBlock {
	return { id, type: 'report', config }
}

async function setupReportOrg() {
	const viewer = await insertTestUser({ name: 'Rita Reports' })
	const organization = await createTestOrganization(viewer.id, 'admin')
	return {
		viewer,
		organization: {
			id: organization.id,
			slug: organization.slug,
			dataRegion: organization.dataRegion,
		},
	}
}

describe('summarizeNotes', () => {
	it('totals the notes and averages them per day', () => {
		expect(summarizeNotes(points([1, 0, 2, 0, 0, 3, 1]))).toMatchObject({
			total: 7,
			avgPerDay: 1,
		})
		expect(summarizeNotes(points([1, 0, 0]))).toMatchObject({
			total: 1,
			avgPerDay: 0.3,
		})
	})

	it('compares the second half of the period with the first half', () => {
		expect(summarizeNotes(points([2, 2, 3, 3])).trend).toBe(50)
		expect(summarizeNotes(points([4, 0, 1, 0])).trend).toBe(-75)
	})

	it('reports 100% growth from nothing and 0% for an empty period', () => {
		expect(summarizeNotes(points([0, 0, 1, 1])).trend).toBe(100)
		expect(summarizeNotes(points([0, 0, 0, 0]))).toEqual({
			total: 0,
			avgPerDay: 0,
			trend: 0,
		})
		expect(summarizeNotes([])).toEqual({ total: 0, avgPerDay: 0, trend: 0 })
	})
})

describe('loadBuiltInBlockData', () => {
	it('shows a week of daily notes for a new organization', async () => {
		const now = new Date()
		const { viewer, organization } = await setupOrg({
			createdAt: daysAgo(now, 1),
		})
		await insertNotes(organization.id, viewer.id, [now, now])

		const data = await loadBuiltInBlockData({
			userId: viewer.id,
			organization,
			blocks: onlyBlocks('notes-chart'),
			now,
		})

		expect(data.notes?.daysShown).toBe(7)
		expect(data.notes?.points).toHaveLength(7)
		expect(data.notes?.points.at(-1)).toMatchObject({
			date: now.toISOString().slice(0, 10),
			notes: 2,
		})
		expect(data.notes?.total).toBe(2)
	})

	it('covers at most the last 30 days and only counts notes in that window', async () => {
		const now = new Date()
		const { viewer, organization } = await setupOrg({
			createdAt: daysAgo(now, 90),
		})
		await insertNotes(organization.id, viewer.id, [
			now,
			now,
			daysAgo(now, 1),
			daysAgo(now, 10),
			daysAgo(now, 45),
		])

		const data = await loadBuiltInBlockData({
			userId: viewer.id,
			organization,
			blocks: onlyBlocks('stats'),
			now,
		})

		const series = data.notes!
		expect(series.daysShown).toBe(30)
		expect(series.points).toHaveLength(30)
		expect(series.points.map((point) => point.notes).slice(-2)).toEqual([1, 2])
		expect(series.total).toBe(4)
		expect(series.total).toBe(
			series.points.reduce((sum, point) => sum + point.notes, 0),
		)
		expect(series).toMatchObject(summarizeNotes(series.points))
		expect(series.points[0]).toEqual({
			date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
			day: expect.any(String),
			label: expect.any(String),
			notes: 0,
		})
	})

	it('ranks the six most active note creators', async () => {
		const { viewer, organization } = await setupOrg()
		const members: Array<Awaited<ReturnType<typeof insertTestUser>>> = []
		for (let index = 0; index < 7; index++) {
			const member = await insertTestUser({ name: `Member ${index + 1}` })
			await addOrganizationMember(member.id, organization.id)
			members.push(member)
		}
		const now = new Date()
		for (const [index, member] of members.entries()) {
			await insertNotes(
				organization.id,
				member.id,
				Array.from({ length: index + 1 }, () => now),
			)
		}

		const data = await loadBuiltInBlockData({
			userId: viewer.id,
			organization,
			blocks: onlyBlocks('leaderboard'),
		})

		expect(data.leaderboard).toEqual(
			[7, 6, 5, 4, 3, 2].map((notesCount, index) => ({
				id: members[notesCount - 1]!.id,
				name: `Member ${notesCount}`,
				email: members[notesCount - 1]!.email,
				notesCount,
				rank: index + 1,
				image: null,
			})),
		)
	})

	it('returns an empty leaderboard when the organization has no notes', async () => {
		const { viewer, organization } = await setupOrg()
		const data = await loadBuiltInBlockData({
			userId: viewer.id,
			organization,
			blocks: onlyBlocks('leaderboard'),
		})
		expect(data.leaderboard).toEqual([])
	})

	it("loads the viewer's onboarding progress and auto-detects completed steps", async () => {
		await seedOnboardingSteps()
		const { viewer, organization } = await setupOrg()
		const colleague = await insertTestUser()
		await addOrganizationMember(colleague.id, organization.id)
		await insertNotes(organization.id, viewer.id, [new Date()])

		const forViewer = await loadBuiltInBlockData({
			userId: viewer.id,
			organization,
			blocks: onlyBlocks('onboarding'),
		})
		const forColleague = await loadBuiltInBlockData({
			userId: colleague.id,
			organization,
			blocks: onlyBlocks('onboarding'),
		})

		const isDone = (progress: typeof forViewer.onboarding, key: string) =>
			progress?.steps.find((step) => step.key === key)?.isCompleted
		expect(forViewer.onboarding).toMatchObject({
			isVisible: true,
			isCompleted: false,
		})
		expect(isDone(forViewer.onboarding, 'create_first_note')).toBe(true)
		expect(isDone(forColleague.onboarding, 'create_first_note')).toBe(false)
	})

	it('only loads data for the blocks on the dashboard', async () => {
		await seedOnboardingSteps()
		const { viewer, organization } = await setupOrg()

		expect(
			await loadBuiltInBlockData({
				userId: viewer.id,
				organization,
				blocks: [],
			}),
		).toEqual({ notes: null, onboarding: null, leaderboard: null })

		const leaderboardOnly = await loadBuiltInBlockData({
			userId: viewer.id,
			organization,
			blocks: onlyBlocks('leaderboard'),
		})
		expect(leaderboardOnly.notes).toBeNull()
		expect(leaderboardOnly.onboarding).toBeNull()
		expect(leaderboardOnly.leaderboard).toEqual([])
		expect(await onboardingProgressRows(viewer.id, organization.id)).toEqual([])

		const all = await loadBuiltInBlockData({
			userId: viewer.id,
			organization,
			blocks: defaultHomeConfig().blocks,
		})
		expect(all.notes).not.toBeNull()
		expect(all.onboarding).not.toBeNull()
		expect(all.leaderboard).toEqual([])
	})

	it('ignores report blocks', async () => {
		const { viewer, organization } = await setupOrg()
		const data = await loadBuiltInBlockData({
			userId: viewer.id,
			organization,
			blocks: [
				{
					id: 'report-1',
					type: 'report',
					config: { source: 'template', templateId: 'customer-count' },
				},
			],
		})
		expect(data).toEqual({ notes: null, onboarding: null, leaderboard: null })
	})
})

describe('loadReportBlockData', () => {
	it('does nothing when the dashboard has no report blocks', async () => {
		const { organization } = await setupReportOrg()
		expect(
			await loadReportBlockData({
				organization,
				blocks: defaultHomeConfig().blocks,
			}),
		).toBeNull()
	})

	it('loads the saved reports of the report blocks from the organization only', async () => {
		const { viewer, organization } = await setupReportOrg()
		const other = await createTestOrganization(viewer.id, 'admin')
		const notesDefinition = templateDefinition(
			'notes-by-status',
			'Notes by status',
		)
		const notes = await insertSavedReport({
			organizationId: organization.id,
			createdById: viewer.id,
			title: 'Notes by status',
			definition: notesDefinition,
		})
		const invalid = await insertSavedReport({
			organizationId: organization.id,
			createdById: viewer.id,
			title: 'Invalid definition',
			definition: { settings: { title: 'Invalid definition' } } as never,
		})
		const notJson = await insertSavedReport({
			organizationId: organization.id,
			createdById: viewer.id,
			title: 'Not JSON',
			definition: 'not json',
		})
		const foreign = await insertSavedReport({
			organizationId: other.id,
			createdById: viewer.id,
			title: 'Another organization',
			definition: notesDefinition,
		})

		const data = await loadReportBlockData({
			organization,
			blocks: [
				...defaultHomeConfig().blocks,
				reportBlock('report-a', { source: 'saved', reportId: notes.id }),
				reportBlock('report-b', { source: 'saved', reportId: notes.id }),
				reportBlock('report-c', { source: 'saved', reportId: invalid.id }),
				reportBlock('report-d', { source: 'saved', reportId: notJson.id }),
				reportBlock('report-e', { source: 'saved', reportId: foreign.id }),
				reportBlock('report-f', { source: 'saved', reportId: 'missing' }),
				reportBlock('report-g', {
					source: 'template',
					templateId: 'customer-count',
				}),
			],
		})

		expect(data?.savedReports).toEqual({
			[notes.id]: { title: 'Notes by status', definition: notesDefinition },
			[invalid.id]: { title: 'Invalid definition', definition: null },
			[notJson.id]: { title: 'Not JSON', definition: null },
			[foreign.id]: null,
			missing: null,
		})
	})

	it('gives template blocks the URLs the reports page runs reports with', async () => {
		const { organization } = await setupReportOrg()

		const data = await loadReportBlockData({
			organization,
			blocks: [
				reportBlock('report-a', {
					source: 'template',
					templateId: 'customer-count',
				}),
			],
		})

		expect(data).toEqual({
			savedReports: {},
			runUrl: `/${organization.slug}/reports/run`,
			tokenUrl: `/${organization.slug}/reports/token`,
			tenantApiUrl: resolveRegionalTenantApiUrls('us').tenantApiUrl,
		})
	})

	it('uses the tenant-api of the organization data region', async () => {
		const { organization } = await setupReportOrg()
		const data = await loadReportBlockData({
			organization: { ...organization, dataRegion: 'ksa' },
			blocks: [
				reportBlock('report-a', {
					source: 'template',
					templateId: 'customer-count',
				}),
			],
		})
		expect(data?.tenantApiUrl).toBe(
			resolveRegionalTenantApiUrls('ksa').tenantApiUrl,
		)
	})
})

describe('loadBlockPicker', () => {
	const noBlockData = { notes: null, onboarding: null, leaderboard: null }

	it("offers the organization's saved reports, newest first, with their subject", async () => {
		const { viewer, organization } = await setupReportOrg()
		const other = await createTestOrganization(viewer.id, 'admin')
		const now = Date.now()
		const older = await insertSavedReport({
			organizationId: organization.id,
			createdById: viewer.id,
			title: 'Members by role',
			definition: templateDefinition('members-by-role', 'Members by role'),
			updatedAt: new Date(now - 60_000),
		})
		const newer = await insertSavedReport({
			organizationId: organization.id,
			createdById: viewer.id,
			title: 'Shop orders',
			definition: templateDefinition('shop-order-count', 'Shop orders'),
			updatedAt: new Date(now),
		})
		await insertSavedReport({
			organizationId: organization.id,
			createdById: viewer.id,
			title: 'Unreadable',
			definition: 'not json',
		})
		await insertSavedReport({
			organizationId: other.id,
			createdById: viewer.id,
			title: 'Another organization',
			definition: templateDefinition('notes-by-status', 'Elsewhere'),
		})

		const picker = await loadBlockPicker({
			userId: viewer.id,
			organizationId: organization.id,
			blockData: noBlockData,
			grants: [],
		})

		expect(picker.savedReports).toEqual([
			{ id: newer.id, title: 'Shop orders', subjectLabel: 'Shop orders' },
			{ id: older.id, title: 'Members by role', subjectLabel: 'Members' },
		])
	})

	it('offers every template to a person whose grants cover them', async () => {
		const { viewer, organization } = await setupReportOrg()
		const grants = [
			STAFF_PAY_REPORT_PERMISSION,
			...STAFFING_REPORT_SUBJECTS,
			...RESERVATIONS_REPORT_SUBJECTS,
		]
		const picker = await loadBlockPicker({
			userId: viewer.id,
			organizationId: organization.id,
			blockData: noBlockData,
			grants,
		})
		expect(picker.savedReports).toEqual([])
		expect(picker.templateGroups).toEqual(reportTemplateGroups())
	})

	it('hides staff and reservation templates and saved reports from someone without the grants', async () => {
		const { viewer, organization } = await setupReportOrg()
		const staffTemplate = organizationTemplates().find(
			(template) => template.definition.subject === 'time_entries',
		)
		const bookingsTemplate = organizationTemplates().find(
			(template) => template.definition.subject === 'bookings',
		)
		expect(staffTemplate).toBeDefined()
		const saved = await insertSavedReport({
			organizationId: organization.id,
			createdById: viewer.id,
			title: 'Staff hours',
			definition: templateDefinition(staffTemplate!.id, 'Staff hours'),
		})
		const ids = (groups: ReturnType<typeof reportTemplateGroups>) =>
			groups.flatMap((group) => group.templates.map((item) => item.id))

		const without = await loadBlockPicker({
			userId: viewer.id,
			organizationId: organization.id,
			blockData: noBlockData,
			grants: [],
		})
		expect(ids(without.templateGroups)).not.toContain(staffTemplate!.id)
		if (bookingsTemplate) {
			expect(ids(without.templateGroups)).not.toContain(bookingsTemplate.id)
		}
		expect(ids(without.templateGroups)).toContain('sales-total')
		expect(without.savedReports.map((report) => report.id)).not.toContain(
			saved.id,
		)

		const withStaff = await loadBlockPicker({
			userId: viewer.id,
			organizationId: organization.id,
			blockData: noBlockData,
			grants: ['time_entries'],
		})
		expect(ids(withStaff.templateGroups)).toContain(staffTemplate!.id)
		expect(withStaff.savedReports.map((report) => report.id)).toContain(
			saved.id,
		)
	})

	it('offers the reservation KPI templates as report blocks only to people who can run them', async () => {
		const { viewer, organization } = await setupReportOrg()
		const kpis = [
			'rsv-covers-today',
			'rsv-no-show-rate-30d',
			'rsv-late-cancels-30d',
			'rsv-waitlist-avg-wait-7d',
		]
		const idsFor = async (grants: string[]) => {
			const picker = await loadBlockPicker({
				userId: viewer.id,
				organizationId: organization.id,
				blockData: noBlockData,
				grants,
			})
			return picker.templateGroups.flatMap((group) =>
				group.templates.map((item) => item.id),
			)
		}
		for (const id of kpis) expect(await idsFor([])).not.toContain(id)
		// Bookings alone covers the three booking KPIs, not the waitlist one.
		const bookingsOnly = await idsFor(['bookings'])
		expect(bookingsOnly).toEqual(expect.arrayContaining(kpis.slice(0, 3)))
		expect(bookingsOnly).not.toContain('rsv-waitlist-avg-wait-7d')
		expect(await idsFor([...RESERVATIONS_REPORT_SUBJECTS])).toEqual(
			expect.arrayContaining(kpis),
		)
	})
})
