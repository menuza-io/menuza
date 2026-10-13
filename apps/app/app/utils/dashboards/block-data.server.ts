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
	User,
	UserImage,
} from '@repo/database'
import { type BlockType, type DashboardBlock } from './config.ts'

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
	email: string
	notesCount: number
	rank: number
	image: string | null
}

/** Data for each built-in block type, or null when no such block is shown. */
export type BuiltInBlockData = {
	notes: NotesSeries | null
	onboarding: OnboardingProgressData | null
	leaderboard: LeaderboardEntry[] | null
}

type BlockOrganization = { id: string; createdAt: Date }

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
		.where(eq(OrganizationNote.organizationId, organizationId))
		.groupBy(OrganizationNote.createdById)
		.orderBy(desc(count(OrganizationNote.id)))
		.limit(LEADERBOARD_SIZE)
	if (ranking.length === 0) return []

	const users = await db
		.select({
			id: User.id,
			name: User.name,
			email: User.email,
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
			email: user?.email || '',
			notesCount: row.noteCount,
			rank: index + 1,
			image: user?.objectKey ? getUserImgSrc(user.objectKey) : null,
		}
	})
}

/**
 * Loads what the built-in blocks of a dashboard show, skipping block types
 * the dashboard does not contain. Onboarding is always the viewer's own.
 */
export async function loadBuiltInBlockData({
	userId,
	organization,
	blocks,
	now = new Date(),
}: {
	userId: string
	organization: BlockOrganization
	blocks: readonly DashboardBlock[]
	now?: Date
}): Promise<BuiltInBlockData> {
	const types = new Set<BlockType>(blocks.map((block) => block.type))
	const [notes, onboarding, leaderboard] = await Promise.all([
		types.has('stats') || types.has('notes-chart')
			? loadNotesSeries(organization, now)
			: null,
		types.has('onboarding') ? loadOnboarding(userId, organization.id) : null,
		types.has('leaderboard') ? loadLeaderboard(organization.id) : null,
	])
	return { notes, onboarding, leaderboard }
}
