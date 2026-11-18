import { getUserImgSrc } from '@repo/common'
import {
	autoDetectCompletedSteps,
	getOnboardingProgress,
	type OnboardingProgressData,
} from '@repo/common/onboarding'
import {
	and,
	count,
	db,
	desc,
	eq,
	gte,
	inArray,
	OrganizationNote,
	SavedReport,
	sql,
	User,
	UserImage,
	UserOrganization,
} from '@repo/database'
import { definitionAllowed, type ReportDefinition } from '@repo/reports'
import { listSavedReports, parseDefinition } from '@repo/reports/server'
import {
	isLaunchChecklistOn,
	loadLaunchChecklist,
} from '#app/utils/launch/launch.server.ts'
import { type LaunchChecklist } from '#app/utils/launch/launch.ts'
import { ORG_PERMISSIONS } from '#app/utils/organization/permissions.server.ts'
import { resolveRegionalTenantApiUrls } from '#app/utils/tenant-api.server.ts'
import { loadAttention, loadPermissionChecker } from './attention.server.ts'
import { type AttentionData } from './attention.ts'
import { loadBookingsTodayAccess } from './bookings-today.server.ts'
import { type BookingsTodayAccess } from './bookings-today.ts'
import { type BlockType, type DashboardBlock } from './config.ts'
import {
	ORGANIZATION_REPORT_CATALOG,
	reportSubjectLabel,
	reportTemplateGroups,
	type ReportBlockData,
	type ReportTemplateGroup,
	type SavedReportBlockData,
	type SavedReportOption,
} from './reports.ts'
import { loadSalesGoalsAccess } from '#app/utils/goals/goals-access.server.ts'
import { type SalesGoalsAccess } from '#app/utils/goals/goals.ts'
import { loadHomeLocations, loadTodayAccess } from './today.server.ts'
import {
	type HomeLocation,
	type TodayAccess,
	homeLocationStorageKey,
} from './today.ts'
import { isOnboardingVisible } from './visibility.ts'

const MIN_CHART_DAYS = 7
const MAX_CHART_DAYS = 30
const LEADERBOARD_SIZE = 6
const DAY_MS = 24 * 60 * 60 * 1000

export type NotesChartPoint = {
	date: string
	day: string
	label: string
	notes: number
}

export type NotesSummary = { total: number; avgPerDay: number; trend: number }

/** Daily note counts shared by the stats and notes chart blocks. */
export type NotesSeries = NotesSummary & {
	points: NotesChartPoint[]
	daysShown: number
}

export type LeaderboardEntry = {
	id: string
	name: string
	notesCount: number
	rank: number
	image: string | null
}

/** Data for each built-in block type, or null when no such block is shown. */
export type BuiltInBlockData = {
	/** When built-in block payloads were loaded (dashboard freshness, #387). */
	fetchedAt: number
	notes: NotesSeries | null
	onboarding: OnboardingProgressData | null
	leaderboard: LeaderboardEntry[] | null
	/** Needs attention items computed for the viewer; null without the block. */
	attention: AttentionData | null
	/**
	 * The launch checklist the onboarding block shows while `launch.checklist`
	 * is on (instead of the template steps); null otherwise.
	 */
	launch: { checklist: LaunchChecklist; canTellGuests: boolean } | null
}

/** What the Add block dialog may offer besides the built-in blocks. */
export type DashboardBlockPicker = {
	/** Onboarding is only offered while the viewer would see the checklist. */
	onboardingAvailable: boolean
	bookingsToday: BookingsTodayAccess
	/** Which Today tiles the viewer may see, and the locations they cover. */
	today: TodayAccess
	salesGoals: SalesGoalsAccess
	/** Key the home location picker is remembered under (per user and organization). */
	locationStorageKey: string
	savedReports: SavedReportOption[]
	templateGroups: ReportTemplateGroup[]
}

type BlockOrganization = {
	id: string
	slug?: string
	createdAt: Date
}

type ReportOrganization = { id: string; slug: string; dataRegion: string }

function sumNotes(points: readonly NotesChartPoint[]) {
	return points.reduce((sum, point) => sum + point.notes, 0)
}

/** The trend compares the second half of the period with the first half. */
export function summarizeNotes(
	points: readonly NotesChartPoint[],
): NotesSummary {
	const total = sumNotes(points)
	const avgPerDay = Math.round((total / Math.max(1, points.length)) * 10) / 10
	const half = Math.floor(points.length / 2)
	const firstHalf = sumNotes(points.slice(0, half))
	const lastHalf = sumNotes(points.slice(half))
	const trend =
		firstHalf === 0
			? lastHalf > 0
				? 100
				: 0
			: Math.round(((lastHalf - firstHalf) / firstHalf) * 100)
	return { total, avgPerDay, trend }
}

function toDateKey(date: Date) {
	return date.toISOString().slice(0, 10)
}

async function loadNotesSeries(
	organization: BlockOrganization,
	now: Date,
): Promise<NotesSeries> {
	// Since the organization was created or the last 30 days, whichever is
	// shorter, but always at least a week.
	const thirtyDaysAgo = new Date(now)
	thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - MAX_CHART_DAYS)
	const startDate =
		organization.createdAt > thirtyDaysAgo
			? organization.createdAt
			: thirtyDaysAgo
	const daysSinceStart = Math.ceil(
		(now.getTime() - startDate.getTime()) / DAY_MS,
	)
	const daysShown = Math.max(
		MIN_CHART_DAYS,
		Math.min(MAX_CHART_DAYS, daysSinceStart),
	)

	const notes = await db
		.select({ createdAt: OrganizationNote.createdAt })
		.from(OrganizationNote)
		.where(
			and(
				eq(OrganizationNote.organizationId, organization.id),
				gte(OrganizationNote.createdAt, startDate),
			),
		)
	const countsByDay = new Map<string, number>()
	for (const note of notes) {
		const key = toDateKey(note.createdAt)
		countsByDay.set(key, (countsByDay.get(key) ?? 0) + 1)
	}

	const points: NotesChartPoint[] = []
	for (let offset = daysShown - 1; offset >= 0; offset--) {
		const date = new Date(now)
		date.setDate(date.getDate() - offset)
		const key = toDateKey(date)
		points.push({
			date: key,
			day: date.toLocaleDateString('en-US', { weekday: 'short' }),
			label: date.toLocaleDateString('en-US', {
				month: 'short',
				day: 'numeric',
			}),
			notes: countsByDay.get(key) ?? 0,
		})
	}
	return { points, daysShown, ...summarizeNotes(points) }
}

async function loadOnboarding(userId: string, organizationId: string) {
	await autoDetectCompletedSteps(userId, organizationId)
	return getOnboardingProgress(userId, organizationId)
}

async function loadLeaderboard(
	organizationId: string,
): Promise<LeaderboardEntry[]> {
	const ranking = await db
		.select({
			createdById: OrganizationNote.createdById,
			noteCount: count(OrganizationNote.id),
		})
		.from(OrganizationNote)
		// Only active members rank; removed members drop off the board.
		.innerJoin(
			UserOrganization,
			and(
				eq(UserOrganization.userId, OrganizationNote.createdById),
				eq(UserOrganization.organizationId, organizationId),
				eq(UserOrganization.active, true),
			),
		)
		.where(eq(OrganizationNote.organizationId, organizationId))
		.groupBy(OrganizationNote.createdById)
		.orderBy(desc(count(OrganizationNote.id)))
		.limit(LEADERBOARD_SIZE)
	if (ranking.length === 0) return []

	const users = await db
		.select({
			id: User.id,
			name: User.name,
			objectKey: UserImage.objectKey,
		})
		.from(User)
		.leftJoin(UserImage, eq(UserImage.userId, User.id))
		.where(
			inArray(
				User.id,
				ranking.map((row) => row.createdById),
			),
		)
	const usersById = new Map(users.map((user) => [user.id, user]))

	return ranking.map((row, index) => {
		const user = usersById.get(row.createdById)
		return {
			id: row.createdById,
			name: user?.name || 'Unknown User',
			notesCount: row.noteCount,
			rank: index + 1,
			image: user?.objectKey ? getUserImgSrc(user.objectKey) : null,
		}
	})
}

/** How many members have written at least one note in the organization. */
export async function loadContributorCount(
	organizationId: string,
): Promise<number> {
	const [row] = await db
		.select({
			contributors: sql<number>`count(distinct ${OrganizationNote.createdById})`,
		})
		.from(OrganizationNote)
		.where(eq(OrganizationNote.organizationId, organizationId))
	return Number(row?.contributors ?? 0)
}

/**
 * Loads what the built-in blocks of a dashboard show, skipping block types
 * the dashboard does not contain. `include` loads a type's data even without
 * its block, for pages that show it elsewhere. Onboarding is always the
 * viewer's own.
 */
export async function loadBuiltInBlockData({
	userId,
	organization,
	blocks,
	include = [],
	request,
	now = new Date(),
}: {
	userId: string
	organization: BlockOrganization
	blocks: readonly DashboardBlock[]
	include?: readonly BlockType[]
	/** The page request: attention actions check permissions with it. */
	request?: Request
	now?: Date
}): Promise<BuiltInBlockData> {
	const types = new Set<BlockType>([
		...blocks.map((block) => block.type),
		...include,
	])
	const launchOn = types.has('onboarding')
		? await isLaunchChecklistOn(organization.id)
		: false
	const [notes, onboarding, leaderboard, attention, launch] = await Promise.all(
		[
			types.has('stats') || types.has('notes-chart')
				? loadNotesSeries(organization, now)
				: null,
			types.has('onboarding') && !launchOn
				? loadOnboarding(userId, organization.id)
				: null,
			types.has('leaderboard') ? loadLeaderboard(organization.id) : null,
			types.has('attention')
				? loadAttention({ userId, organization, request, now })
				: null,
			launchOn ? loadHomeLaunch(userId, organization.id, now) : null,
		],
	)
	return {
		fetchedAt: now.getTime(),
		notes,
		onboarding,
		leaderboard,
		attention,
		launch,
	}
}

async function loadHomeLaunch(
	userId: string,
	organizationId: string,
	now: Date,
): Promise<BuiltInBlockData['launch']> {
	const [checklist, has] = await Promise.all([
		loadLaunchChecklist({ organizationId, userId, now }),
		loadPermissionChecker(userId, organizationId),
	])
	return checklist
		? {
				checklist,
				canTellGuests: has(ORG_PERMISSIONS.UPDATE_CAMPAIGN_ANY),
			}
		: null
}

/** A saved definition that no longer parses must not break the dashboard. */
function readSavedDefinition(raw: string): ReportDefinition | null {
	try {
		return parseDefinition(raw)
	} catch {
		return null
	}
}

async function loadSavedReportsById(
	organizationId: string,
	reportIds: string[],
) {
	const savedReports: Record<string, SavedReportBlockData | null> =
		Object.fromEntries(reportIds.map((id) => [id, null]))
	if (reportIds.length === 0) return savedReports

	const rows = await db
		.select({
			id: SavedReport.id,
			title: SavedReport.title,
			definition: SavedReport.definition,
		})
		.from(SavedReport)
		.where(
			and(
				eq(SavedReport.organizationId, organizationId),
				inArray(SavedReport.id, reportIds),
			),
		)
	for (const row of rows) {
		savedReports[row.id] = {
			title: row.title,
			definition: readSavedDefinition(row.definition),
		}
	}
	return savedReports
}

/**
 * Loads what report blocks need from the server: their saved reports (null
 * once the organization no longer has one) and the URLs reports run with.
 * Customer data is only ever queried by the browser, and whether the viewer
 * may read it is up to the responses it gets. Returns null without any work
 * when there are no report blocks.
 */
export async function loadReportBlockData({
	organization,
	blocks,
}: {
	organization: ReportOrganization
	blocks: readonly DashboardBlock[]
}): Promise<ReportBlockData | null> {
	const reportBlocks = blocks.flatMap((block) =>
		block.type === 'report' ? [block.config] : [],
	)
	if (reportBlocks.length === 0) return null

	const reportIds = new Set(
		reportBlocks.flatMap((config) =>
			config.source === 'saved' ? [config.reportId] : [],
		),
	)
	return {
		savedReports: await loadSavedReportsById(organization.id, [...reportIds]),
		runUrl: `/${organization.slug}/reports/run`,
		tokenUrl: `/${organization.slug}/reports/token`,
		tenantApiUrl: resolveRegionalTenantApiUrls(organization.dataRegion)
			.tenantApiUrl,
	}
}

async function loadSavedReportOptions(
	organizationId: string,
	grants: readonly string[],
): Promise<SavedReportOption[]> {
	const reports = await listSavedReports({
		scope: 'organization',
		organizationId,
	})
	return reports.flatMap((report) => {
		const definition = readSavedDefinition(report.definition)
		if (!definition) return []
		// A saved report on a subject the person cannot run is not offered.
		if (!definitionAllowed(ORGANIZATION_REPORT_CATALOG, definition, grants)) {
			return []
		}
		return [
			{
				id: report.id,
				title: report.title,
				subjectLabel: reportSubjectLabel(definition.subject),
			},
		]
	})
}

/**
 * Loads the Add block dialog data. The onboarding progress of an onboarding
 * block already on the dashboard is reused.
 */
export async function loadBlockPicker({
	userId,
	organization,
	blockData,
	grants,
	bookingsToday: knownBookingsToday,
	locations: knownLocations,
}: {
	userId: string
	organization: { id: string; slug: string; dataRegion: string }
	blockData: BuiltInBlockData
	/** Restricted report subjects the person's reports token lists. */
	grants: readonly string[]
	/** Already loaded by the caller (Home needs it for its default layout). */
	bookingsToday?: BookingsTodayAccess
	locations?: HomeLocation[]
}): Promise<DashboardBlockPicker> {
	const organizationId = organization.id
	const launchOn =
		blockData.launch !== null || (await isLaunchChecklistOn(organizationId))
	const [onboarding, savedReports, bookingsToday, locations] =
		await Promise.all([
			launchOn
				? null
				: (blockData.onboarding ?? loadOnboarding(userId, organizationId)),
			loadSavedReportOptions(organizationId, grants),
			knownBookingsToday ?? loadBookingsTodayAccess({ userId, organizationId }),
			knownLocations ?? loadHomeLocations(userId, organizationId),
		])
	const [today, salesGoals] = await Promise.all([
		loadTodayAccess({
			userId,
			organization,
			bookingsToday,
			locations,
		}),
		loadSalesGoalsAccess({
			userId,
			organizationId,
			orgSlug: organization.slug,
			dataRegion: organization.dataRegion,
		}),
	])
	return {
		// The launch checklist stays on Home (it ends in "You're live").
		onboardingAvailable: launchOn || isOnboardingVisible(onboarding),
		bookingsToday,
		today,
		salesGoals,
		locationStorageKey: homeLocationStorageKey(userId, organizationId),
		savedReports,
		templateGroups: reportTemplateGroups(grants),
	}
}
