import { type InventoryStatus } from '@repo/inventory'
import { type InventoryTab } from './nav.ts'

/**
 * Pure derivation of the Inventory first-run checklist on Today: (1) Add your
 * items (2) Say where you keep them (3) Do your first count (4) Record a
 * delivery. The facts come from the region (`GET /operator/inventory/status`);
 * until they arrive every step is `unknown` and the screen shows a skeleton,
 * never a guess.
 */

export type InventorySetupStepId = 'items' | 'storage' | 'count' | 'delivery'
export type InventorySetupStepStatus = 'done' | 'todo' | 'unknown'

export type InventorySetupStep = {
	id: InventorySetupStepId
	status: InventorySetupStepStatus
	/** The tab the step's Go button opens. */
	tab: InventoryTab
	/** True for the first step that is not done. */
	next: boolean
}

type StatusFacts = Pick<
	InventoryStatus,
	'items' | 'storageAreas' | 'approvedCounts' | 'deliveries'
>

const STEP_ORDER: ReadonlyArray<{
	id: InventorySetupStepId
	tab: InventoryTab
	fact: keyof StatusFacts
}> = [
	{ id: 'items', tab: 'stock', fact: 'items' },
	// Storage areas are set up from the Stock tab until Inventory settings ship.
	{ id: 'storage', tab: 'stock', fact: 'storageAreas' },
	{ id: 'count', tab: 'counts', fact: 'approvedCounts' },
	{ id: 'delivery', tab: 'purchasing', fact: 'deliveries' },
]

export function deriveInventorySetupSteps(
	status: StatusFacts | null,
): InventorySetupStep[] {
	const steps = STEP_ORDER.map(({ id, tab, fact }) => ({
		id,
		tab,
		status: (status === null
			? 'unknown'
			: status[fact] > 0
				? 'done'
				: 'todo') as InventorySetupStepStatus,
	}))
	const nextIndex = steps.findIndex((step) => step.status === 'todo')
	return steps.map((step, index) => ({ ...step, next: index === nextIndex }))
}

export function inventorySetupProgress(steps: readonly InventorySetupStep[]): {
	done: number
	total: number
	complete: boolean
	/** True while any step is still `unknown`: show a skeleton, not a count. */
	loading: boolean
} {
	const done = steps.filter((step) => step.status === 'done').length
	return {
		done,
		total: steps.length,
		complete: steps.length > 0 && done === steps.length,
		loading: steps.some((step) => step.status === 'unknown'),
	}
}
