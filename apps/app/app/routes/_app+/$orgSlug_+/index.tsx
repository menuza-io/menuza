import { invariant } from '@epic-web/invariant'

import { t, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { requireUserId } from '@repo/auth'
import { getUserImgSrc } from '@repo/common'
import {
	getOnboardingProgress,
	autoDetectCompletedSteps,
} from '@repo/common/onboarding'
import {
	and,
	count,
	db,
	desc,
	eq,
	gte,
	inArray,
	Organization,
	OrganizationNote,
	User,
	UserImage,
	UserOrganization,
} from '@repo/database'
import { PageTitle } from '@repo/ui/page-title'
import confetti from 'canvas-confetti'
import { useEffect, useRef, lazy, Suspense } from 'react'
import {
	type LoaderFunctionArgs,
	useLoaderData,
	useRouteLoaderData,
	useSearchParams,
	useNavigate,
} from 'react-router'
import { LeadershipCard } from '#app/components/leadership-card.tsx'
import { OnboardingChecklist } from '#app/components/onboarding-checklist.tsx'

const NotesChart = lazy(() =>
	import('#app/components/notes-chart.tsx').then((m) => ({
		default: m.NotesChart,
	})),
)

import { type loader as rootLoader } from '#app/root.tsx'
import { setUserDefaultOrganization } from '#app/utils/organization/organizations.server.ts'
// import data from '#app/dashboard/data.json'

export async function loader({ request, params }: LoaderFunctionArgs) {
	const userId = await requireUserId(request)
	const orgSlug = params.orgSlug
	invariant(orgSlug, 'orgSlug is required')

	const [organization] = await db
		.select({
			id: Organization.id,
			name: Organization.name,
			createdAt: Organization.createdAt,
		})
		.from(Organization)
		.innerJoin(
			UserOrganization,
			and(
				eq(UserOrganization.organizationId, Organization.id),
				eq(UserOrganization.userId, userId),
				eq(UserOrganization.active, true),
			),
		)
		.where(and(eq(Organization.slug, orgSlug), eq(Organization.active, true)))
		.limit(1)

	if (!organization) {
		// Handle case where organization is not found or user is not a member
		throw new Response('Not Found', { status: 404 })
	}

	// Calculate appropriate date range - show since org creation or last 30 days, whichever is shorter
	const now = new Date()
	const thirtyDaysAgo = new Date()
	thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)

	const startDate =
		organization.createdAt > thirtyDaysAgo
			? organization.createdAt
			: thirtyDaysAgo
	const daysSinceStart = Math.ceil(
		(now.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24),
	)
	const daysToShow = Math.max(7, Math.min(30, daysSinceStart)) // Show at least 7 days, max 30

	// Run all independent queries in parallel for better performance
	const [notesData, onboardingProgress, leadershipData] = await Promise.all([
		// Notes data for chart
		db
			.select({ createdAt: OrganizationNote.createdAt })
			.from(OrganizationNote)
			.where(
				and(
					eq(OrganizationNote.organizationId, organization.id),
					gte(OrganizationNote.createdAt, startDate),
				),
			)
			.orderBy(OrganizationNote.createdAt),
		// Onboarding progress (auto-detect + get progress)
		(async () => {
			await autoDetectCompletedSteps(userId, organization.id)
			return getOnboardingProgress(userId, organization.id)
		})(),
		// Leadership data - top note creators
		db
			.select({
				createdById: OrganizationNote.createdById,
				noteCount: count(OrganizationNote.id),
			})
			.from(OrganizationNote)
			.where(eq(OrganizationNote.organizationId, organization.id))
			.groupBy(OrganizationNote.createdById)
			.orderBy(desc(count(OrganizationNote.id)))
			.limit(6),
		// Set default organization (fire and forget, no await needed for result)
		setUserDefaultOrganization(userId, organization.id),
	])

	// Group notes by day
	const dailyNotes = notesData.reduce(
		(acc, note) => {
			const date = note.createdAt.toISOString().split('T')[0]
			if (date) {
				acc[date] = (acc[date] || 0) + 1
			}
			return acc
		},
		{} as Record<string, number>,
	)

	// Create array with all days in the range, filling missing days with 0
	const chartData = []
	for (let i = daysToShow - 1; i >= 0; i--) {
		const date = new Date()
		date.setDate(date.getDate() - i)
		const dateStr = date.toISOString().split('T')[0]
		const dayName = date.toLocaleDateString('en-US', { weekday: 'short' })
		const monthDay = date.toLocaleDateString('en-US', {
			month: 'short',
			day: 'numeric',
		})

		chartData.push({
			date: dateStr,
			day: dayName,
			label: monthDay,
			notes: (dateStr && dailyNotes[dateStr]) || 0,
		})
	}

	// Get user details for the top contributors (depends on leadershipData)
	const userIds = leadershipData.map((item) => item.createdById)
	const users =
		userIds.length > 0
			? await db
					.select({
						id: User.id,
						name: User.name,
						email: User.email,
						objectKey: UserImage.objectKey,
					})
					.from(User)
					.leftJoin(UserImage, eq(UserImage.userId, User.id))
					.where(inArray(User.id, userIds))
			: []

	// ⚡ Performance: Build a Map for O(1) lookups instead of O(n) .find() per item
	// This reduces time complexity from O(n×m) to O(n+m) when combining user data with rankings
	const userMap = new Map(users.map((u) => [u.id, u]))

	// Combine user data with note counts and add ranking
	const leaders = leadershipData.map((item, index) => {
		const user = userMap.get(item.createdById)
		return {
			id: item.createdById,
			name: user?.name || 'Unknown User',
			email: user?.email || '',
			notesCount: item.noteCount,
			rank: index + 1,
			image: user?.objectKey ? getUserImgSrc(user.objectKey) : null,
		}
	})

	return Response.json({
		organization,
		chartData,
		daysToShow,
		onboardingProgress,
		leaders,
	})
}

export default function OrganizationDashboard() {
	const { _ } = useLingui()
	const { chartData, daysToShow, onboardingProgress, leaders } =
		useLoaderData() as {
			organization: { name: string }
			chartData: Array<{
				date: string
				day: string
				label: string
				notes: number
			}>
			daysToShow: number
			onboardingProgress: any
			leaders: Array<{
				id: string
				name: string
				email: string
				notesCount: number
				rank: number
			}>
		}
	const rootData = useRouteLoaderData<typeof rootLoader>('root')
	const user = rootData?.user
	const orgSlug =
		rootData?.userOrganizations?.currentOrganization?.organization.slug || ''

	const [searchParams] = useSearchParams()
	const navigate = useNavigate()

	const celebrationStartedRef = useRef(false)

	// Trigger confetti animation when celebrate param is present
	useEffect(() => {
		const shouldCelebrate = searchParams.get('celebrate') === 'true'

		if (shouldCelebrate && !celebrationStartedRef.current) {
			celebrationStartedRef.current = true

			// Fire confetti from the top
			const duration = 3000
			const animationEnd = Date.now() + duration
			const defaults = { startVelocity: 30, spread: 360, ticks: 60, zIndex: 0 }

			const interval = setInterval(() => {
				const timeLeft = animationEnd - Date.now()

				if (timeLeft <= 0) {
					clearInterval(interval)

					// Clean up query parameter after animation completes
					const newSearchParams = new URLSearchParams(searchParams)
					newSearchParams.delete('celebrate')
					void navigate(
						{
							search: newSearchParams.toString(),
						},
						{ replace: true },
					)
					celebrationStartedRef.current = false
					return
				}

				const particleCount = 50 * (timeLeft / duration)

				// Fire confetti from the top center
				void confetti({
					...defaults,
					particleCount,
					origin: { x: 0.5, y: 0 },
				})
			}, 250)

			return () => clearInterval(interval)
		}
	}, [searchParams, navigate])

	const userName = user?.name || 'User'

	const totalNotes = chartData.reduce((sum, d) => sum + d.notes, 0)
	const avgPerDay =
		Math.round((totalNotes / Math.max(1, chartData.length)) * 10) / 10
	const halfPoint = Math.floor(chartData.length / 2)
	const firstHalf = chartData
		.slice(0, halfPoint)
		.reduce((s, d) => s + d.notes, 0)
	const lastHalf = chartData.slice(halfPoint).reduce((s, d) => s + d.notes, 0)
	const trend =
		firstHalf === 0
			? lastHalf > 0
				? 100
				: 0
			: Math.round(((lastHalf - firstHalf) / firstHalf) * 100)

	const showOnboarding =
		onboardingProgress &&
		!onboardingProgress.isCompleted &&
		onboardingProgress.isVisible

	return (
		<div className="mx-auto flex h-full w-full max-w-6xl flex-col gap-8 py-8 md:px-6 lg:px-8">
			<PageTitle
				title={_(t`Welcome ${userName}!`)}
				description={_(t`Your organization dashboard`)}
			/>

			<div className="flex flex-wrap items-center gap-3 text-sm">
				<div className="text-muted-foreground">
					<Trans>{totalNotes} total notes</Trans>
				</div>
				<div className="bg-border h-4 w-px" />
				<div className="text-muted-foreground">
					<Trans>{avgPerDay} avg per day</Trans>
				</div>
				<div className="bg-border h-4 w-px" />
				<div className="flex items-center gap-1">
					{trend >= 0 ? (
						<>
							<span className="font-medium text-green-600 dark:text-green-400">
								<Trans>+{trend}%</Trans>
							</span>
							<span className="text-muted-foreground">
								<Trans>trending</Trans>
							</span>
						</>
					) : (
						<>
							<span className="font-medium text-red-600 dark:text-red-400">
								<Trans>{trend}%</Trans>
							</span>
							<span className="text-muted-foreground">
								<Trans>trending</Trans>
							</span>
						</>
					)}
				</div>
			</div>

			<Suspense
				fallback={<div className="bg-muted/50 h-80 animate-pulse rounded-lg" />}
			>
				<NotesChart
					data={chartData}
					daysShown={daysToShow}
					totalNotes={totalNotes}
					avgPerDay={avgPerDay}
					trend={trend}
				/>
			</Suspense>

			<div className="grid gap-6 lg:grid-cols-2">
				{showOnboarding ? (
					<OnboardingChecklist
						progress={onboardingProgress}
						orgSlug={orgSlug}
						organizationId={
							rootData?.userOrganizations?.currentOrganization?.organization
								.id || ''
						}
						variant="dashboard"
					/>
				) : null}
				<LeadershipCard
					className={showOnboarding ? '' : 'lg:col-span-2 lg:max-w-2xl'}
					leaders={leaders}
				/>
			</div>
		</div>
	)
}
