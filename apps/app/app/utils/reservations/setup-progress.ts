import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/macro'
import {
	type SetupIssueTab,
	setupIssueTab,
} from '#app/utils/reservations/setup-issue-target.ts'

/**
 * Pure derivations for the Reservations settings first-run path: the setup
 * checklist, the one status that the header and the diagnostics share, and the
 * plain-language wording of each diagnostics issue. No I/O and no React, so
 * every rule is unit tested. The settings shell loads the inputs with the
 * clients the settings screens already use.
 */

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

export type SetupIssueInput = {
	code: string
	severity: 'error' | 'warning'
	entityId?: string
	field?: string
	partySize?: number
	serviceId?: string | null
	details?: Record<string, unknown>
}

/** Nothing to book yet: the validator is silent about an empty setup. */
export type SetupEssentials = { noServices?: boolean; noTables?: boolean }

export type SetupStatusState = 'ready' | 'ready_suggestions' | 'needs_attention'

export type SetupStatus = {
	state: SetupStatusState
	blockingCount: number
	suggestionCount: number
}

/**
 * The status is derived from the same rows the diagnostics card lists (see
 * `describeSetupIssues`), never from the raw validator output: the validator
 * emits one `unseatable_party_size` warning per party size while the card folds
 * them into one line, so counting the raw issues made the header chip say
 * "3 suggestions" above a card with one. Blocking rows are validator errors and
 * the empty-setup essentials; the rest are suggestions that never block.
 */
export function summarizeSetupItems(
	items: ReadonlyArray<Pick<SetupIssueItem, 'severity'>>,
): SetupStatus {
	const blockingCount = items.filter((i) => i.severity === 'error').length
	const suggestionCount = items.length - blockingCount
	return {
		state:
			blockingCount > 0
				? 'needs_attention'
				: suggestionCount > 0
					? 'ready_suggestions'
					: 'ready',
		blockingCount,
		suggestionCount,
	}
}

/** Convenience for callers that only have the raw validator output. */
export function summarizeSetupStatus(
	issues: readonly SetupIssueInput[],
	essentials: SetupEssentials = {},
): SetupStatus {
	return summarizeSetupItems(describeSetupIssues(issues, new Map(), essentials))
}

/** `[1,2,3,5,6]` -> `1-3, 5-6`. Logical order, digits only (callers wrap in bdi). */
export function formatPartySizeRanges(sizes: readonly number[]): string {
	const sorted = [...new Set(sizes)].sort((a, b) => a - b)
	const parts: string[] = []
	let start: number | null = null
	let prev: number | null = null
	const flush = () => {
		if (start === null || prev === null) return
		parts.push(start === prev ? String(start) : `${start}-${prev}`)
	}
	for (const size of sorted) {
		if (start !== null && prev !== null && size === prev + 1) {
			prev = size
			continue
		}
		flush()
		start = size
		prev = size
	}
	flush()
	return parts.join(', ')
}

export type SetupIssueItem = {
	key: string
	code: string
	severity: 'error' | 'warning'
	tab: SetupIssueTab | null
	text: MessageDescriptor
}

function issueText(
	issue: SetupIssueInput,
	serviceNames: ReadonlyMap<string, string>,
): MessageDescriptor {
	const serviceName =
		(issue.serviceId ? serviceNames.get(issue.serviceId) : undefined) ??
		(issue.entityId ? serviceNames.get(issue.entityId) : undefined)
	const named = serviceName ?? null
	switch (issue.code) {
		case 'invalid_interval_min':
			return msg`The time between start times is not a supported value.`
		case 'invalid_horizon_days':
			return msg`How far ahead guests can book is out of range.`
		case 'invalid_party_bounds':
			return msg`The online party size limits do not fit together.`
		case 'pacing_cap_below_min_party':
			return msg`A pacing limit is smaller than your smallest online party.`
		case 'duplicate_table_label':
			return msg`Two tables share the same name.`
		case 'invalid_table_seats':
			return msg`A table has a minimum of seats above its maximum.`
		case 'combination_too_few_members':
			return msg`A table combination needs at least two tables.`
		case 'combination_invalid_seats':
			return msg`A table combination has a minimum of seats above its maximum.`
		case 'combination_missing_table':
			return msg`A table combination uses a table that no longer exists.`
		case 'combination_archived_table':
			return msg`A table combination uses an archived table.`
		case 'combination_uncombinable_table':
			return msg`A table combination uses a table that cannot be combined.`
		case 'combination_cross_area':
			return msg`A table combination joins tables from different areas.`
		case 'combination_duplicate_members':
			return msg`A table combination lists the same table twice.`
		case 'service_invalid_window':
			return named
				? msg`${named} ends before it starts.`
				: msg`A service ends before it starts.`
		case 'service_duration_exceeds_24h':
			return named
				? msg`${named} runs longer than 24 hours.`
				: msg`A service runs longer than 24 hours.`
		case 'service_last_seating_after_end':
			return named
				? msg`${named} has its last seating after it closes.`
				: msg`A service has its last seating after it closes.`
		case 'service_last_seating_before_start':
			return named
				? msg`${named} has its last seating before it opens.`
				: msg`A service has its last seating before it opens.`
		case 'turn_time_bucket_invalid_range':
			return named
				? msg`A dining time for ${named} has a party range that is backwards.`
				: msg`A dining time has a party range that is backwards.`
		case 'turn_time_bucket_overlap':
			return named
				? msg`Dining times for ${named} overlap for some party sizes.`
				: msg`Default dining times overlap for some party sizes.`
		case 'turn_time_bucket_gap':
			return named
				? msg`Dining times for ${named} skip some party sizes.`
				: msg`Default dining times skip some party sizes.`
		case 'policy_unknown_service':
			return msg`A payment policy points to a service that is gone.`
		case 'policy_party_bounds_inverted':
			return msg`A payment policy has a largest party below its smallest.`
		case 'policy_invalid_window':
			return msg`A payment policy has an invalid cancellation window.`
		case 'block_invalid_window':
			return msg`A block ends before it starts.`
		case 'block_unknown_table':
			return msg`A block points to a table that no longer exists.`
		default:
			return msg`A setup check needs attention.`
	}
}

/**
 * Specific, ordered issue rows: blocking first, then suggestions. Every
 * `unseatable_party_size` warning is folded into one line with party ranges
 * ("No table fits parties of 7-8").
 */
export function describeSetupIssues(
	issues: readonly SetupIssueInput[],
	serviceNames: ReadonlyMap<string, string> = new Map(),
	essentials: SetupEssentials = {},
): SetupIssueItem[] {
	const items: SetupIssueItem[] = []
	if (essentials.noServices) {
		items.push({
			key: 'no_services',
			code: 'no_services',
			severity: 'error',
			tab: 'services',
			text: msg`No services yet. Add the hours guests can book.`,
		})
	}
	if (essentials.noTables) {
		items.push({
			key: 'no_tables',
			code: 'no_tables',
			severity: 'error',
			tab: 'tables',
			text: msg`No tables yet. Add the tables guests can be seated at.`,
		})
	}
	const unseatable: SetupIssueInput[] = []
	issues.forEach((issue, index) => {
		if (issue.code === 'unseatable_party_size') {
			unseatable.push(issue)
			return
		}
		items.push({
			key: `${issue.code}-${issue.entityId ?? index}-${index}`,
			code: issue.code,
			severity: issue.severity,
			tab: setupIssueTab(issue.code),
			text: issueText(issue, serviceNames),
		})
	})
	if (unseatable.length > 0) {
		const sizes = unseatable
			.map((i) => i.partySize ?? Number(i.details?.partySize))
			.filter((n) => Number.isFinite(n))
		const ranges = formatPartySizeRanges(sizes)
		items.push({
			key: 'unseatable_party_size',
			code: 'unseatable_party_size',
			severity: unseatable.some((i) => i.severity === 'error')
				? 'error'
				: 'warning',
			tab: setupIssueTab('unseatable_party_size'),
			text: ranges
				? msg`No table fits online parties of ${ranges}.`
				: msg`No table fits some online party sizes.`,
		})
	}
	return items.sort(
		(a, b) => Number(b.severity === 'error') - Number(a.severity === 'error'),
	)
}

// ---------------------------------------------------------------------------
// Checklist
// ---------------------------------------------------------------------------

export type SetupStepId = 'hours' | 'tables' | 'rules' | 'messages' | 'test'
export type SetupStepStatus = 'done' | 'todo' | 'unknown'

export type SetupStep = {
	id: SetupStepId
	status: SetupStepStatus
	/** Settings sub-page: `''` is Booking rules, `book` is the host booking page. */
	tab: SetupIssueTab | 'rules' | 'book'
	/** True for the first step that is not done. */
	next: boolean
}

export type SetupProgressInput = {
	/** Active (not archived) services, `null` when they could not be loaded. */
	serviceCount: number | null
	tableCount: number | null
	/** Guest message kinds switched on, `null` when not loaded. */
	enabledMessageCount: number | null
	settingsVersion: number | null
	/** The operator has opened Booking rules at least once on this device. */
	rulesReviewed: boolean
	/** The operator has opened the booking page from this checklist. */
	bookingTested: boolean
	issues: ReadonlyArray<Pick<SetupIssueInput, 'code' | 'severity'>>
}

function count(value: number | null, blockedBy: boolean): SetupStepStatus {
	if (value === null) return 'unknown'
	return value > 0 && !blockedBy ? 'done' : 'todo'
}

const SERVICE_BLOCKERS: ReadonlySet<SetupIssueTab | null> =
	new Set<SetupIssueTab | null>(['services'])
const TABLE_BLOCKERS: ReadonlySet<SetupIssueTab | null> =
	new Set<SetupIssueTab | null>(['tables'])

export function deriveSetupSteps(input: SetupProgressInput): SetupStep[] {
	const blocking = input.issues.filter((i) => i.severity === 'error')
	const blockedOn = (set: ReadonlySet<SetupIssueTab | null>) =>
		blocking.some((i) => set.has(setupIssueTab(i.code)))
	const rulesBlocked = blocking.some((i) => setupIssueTab(i.code) === null)

	const hours = count(input.serviceCount, blockedOn(SERVICE_BLOCKERS))
	const tables = count(input.tableCount, blockedOn(TABLE_BLOCKERS))
	const rules: SetupStepStatus =
		input.settingsVersion === null
			? 'unknown'
			: (input.settingsVersion > 1 || input.rulesReviewed) && !rulesBlocked
				? 'done'
				: 'todo'
	const messages = count(input.enabledMessageCount, false)
	// Testing a booking only makes sense once the rest is in place.
	const rest = [hours, tables, rules, messages]
	const test: SetupStepStatus = input.bookingTested
		? 'done'
		: rest.includes('unknown')
			? 'unknown'
			: 'todo'

	const steps: Array<Omit<SetupStep, 'next'>> = [
		{ id: 'hours', status: hours, tab: 'services' },
		{ id: 'tables', status: tables, tab: 'tables' },
		{ id: 'rules', status: rules, tab: 'rules' },
		{ id: 'messages', status: messages, tab: 'messages' },
		{ id: 'test', status: test, tab: 'book' },
	]
	const nextIndex = steps.findIndex((s) => s.status === 'todo')
	return steps.map((s, i) => ({ ...s, next: i === nextIndex }))
}

export function setupProgress(steps: readonly SetupStep[]): {
	done: number
	total: number
	complete: boolean
	/** True while any step is still `unknown`: show a skeleton, not a count. */
	loading: boolean
} {
	const done = steps.filter((s) => s.status === 'done').length
	return {
		done,
		total: steps.length,
		complete: done === steps.length,
		loading: steps.some((s) => s.status === 'unknown'),
	}
}
