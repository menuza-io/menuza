import { type projectMonthlySales } from '@repo/common/sales-goal-projection'

export const GOAL_BENCHMARK_CANCELLATION_RATE = 0.05

export type SalesGoalsAccess =
	| {
			available: true
			tokenUrl: string
			tenantApiUrl: string
			goalsUrl: string
	  }
	| { available: false }

export type LocationGoalProgress = {
	locationId: string
	locationName: string
	goalMinor: number | null
	actualMinor: number
	currency: string
	projection: ReturnType<typeof projectMonthlySales>
}
