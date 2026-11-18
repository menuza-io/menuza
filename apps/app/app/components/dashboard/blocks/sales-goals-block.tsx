import { Trans } from '@lingui/react/macro'
import { Link } from 'react-router'
import { useEffect, useMemo, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/card'
import {
	type LocationGoalProgress,
	type SalesGoalsAccess,
	GOAL_BENCHMARK_CANCELLATION_RATE,
} from '#app/utils/goals/goals.ts'

type MonthSalesResponse = { byLocation?: Record<string, number> }

function mergeActuals(
	progress: LocationGoalProgress[],
	byLocation: Record<string, number>,
): LocationGoalProgress[] {
	return progress.map((row) => ({
		...row,
		actualMinor: byLocation[row.locationId] ?? row.actualMinor,
	}))
}

export function SalesGoalsBlock({
	orgSlug,
	access,
}: {
	orgSlug: string
	access: SalesGoalsAccess & { available: true }
}) {
	const [progress, setProgress] = useState<LocationGoalProgress[] | null>(null)
	const [error, setError] = useState(false)

	const orgTotal = useMemo(() => {
		if (!progress) return null
		let goal = 0
		let actual = 0
		let anyGoal = false
		for (const row of progress) {
			if (row.goalMinor !== null) {
				anyGoal = true
				goal += row.goalMinor
			}
			actual += row.actualMinor
		}
		return { goal: anyGoal ? goal : null, actual }
	}, [progress])

	useEffect(() => {
		let cancelled = false
		const load = async () => {
			try {
				const tokenRes = await fetch(access.tokenUrl)
				const tokenBody = (await tokenRes.json()) as { token?: string }
				if (!tokenRes.ok || typeof tokenBody.token !== 'string') {
					throw new Error('token')
				}
				const [goalsRes, salesRes] = await Promise.all([
					fetch(access.goalsUrl),
					fetch(`${access.tenantApiUrl}/analytics/month-sales?salesBasis=net`, {
						headers: { Authorization: `Bearer ${tokenBody.token}` },
					}),
				])
				if (!goalsRes.ok || !salesRes.ok) throw new Error('fetch')
				const goalsBody = (await goalsRes.json()) as {
					progress?: LocationGoalProgress[]
				}
				const salesBody = (await salesRes.json()) as MonthSalesResponse
				if (cancelled) return
				const base = goalsBody.progress ?? []
				setProgress(mergeActuals(base, salesBody.byLocation ?? {}))
			} catch {
				if (!cancelled) setError(true)
			}
		}
		void load()
		return () => {
			cancelled = true
		}
	}, [access])

	return (
		<Card className="h-full" data-testid="sales-goals-block">
			<CardHeader className="pb-2">
				<CardTitle className="text-base font-medium">
					<Trans>Sales goals</Trans>
				</CardTitle>
			</CardHeader>
			<CardContent className="space-y-3 text-sm">
				{error ? (
					<p className="text-muted-foreground">
						<Trans>Could not load goal progress.</Trans>
					</p>
				) : progress === null ? (
					<p className="text-muted-foreground">
						<Trans>Loading…</Trans>
					</p>
				) : orgTotal === null || orgTotal.goal === null ? (
					<p data-testid="sales-goals-prompt">
						<Trans>
							Set a monthly sales goal per location to track progress.{' '}
							<Link to={`/${orgSlug}/goals`} className="underline">
								Open goals
							</Link>
						</Trans>
					</p>
				) : (
					<>
						<p data-testid="sales-goals-progress">
							<Trans>
								Month to date: {(orgTotal.actual / 100).toFixed(0)} /{' '}
								{(orgTotal.goal / 100).toFixed(0)}
							</Trans>
						</p>
						<p className="text-muted-foreground text-xs">
							<Trans>
								Benchmark: keep cancellations under{' '}
								{(GOAL_BENCHMARK_CANCELLATION_RATE * 100).toFixed(0)}%.
							</Trans>
						</p>
					</>
				)}
			</CardContent>
		</Card>
	)
}
