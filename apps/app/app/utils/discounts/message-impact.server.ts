import { userHasOrganizationPermission } from '@repo/auth'
import {
	type DiscountUsedIn,
	discountUsedInResponseSchema,
} from '@repo/discounts'
import { and, AuditLog, db, desc, eq, inArray } from '@repo/database'
import { AuditAction } from '@repo/audit'
import { auditCampaign } from '#app/utils/marketing/campaign-audit.server.ts'
import { ORG_PERMISSIONS } from '#app/utils/organization/permissions.server.ts'
import { getOperatorTenantClient } from '#app/utils/tenant-api.server.ts'
import { DISCOUNT_RESOURCE_TYPE } from './history.server.ts'

/**
 * What pausing, archiving or shortening a discount does to the messages that
 * promise it (#236). The page shows them first (browser-direct, discounts
 * token); this module acts on the operator's choice: pause those automations
 * too, cancel those scheduled broadcasts, and on resume offer to resume what was
 * paused with the discount.
 *
 * The server never trusts ids from the browser: it asks the region again which
 * messages offer this discount and acts only on those, and only for a member who
 * holds the permission for that kind of message (a member who can edit discounts
 * but not campaigns cannot pause campaigns through this). Ids only; no recipient
 * data is read.
 */

type FetchTenant = (path: string, init?: RequestInit) => Promise<Response>

export type CascadeFlags = {
	pauseAutomations: boolean
	cancelBroadcasts: boolean
}

export function readCascadeFlags(form: FormData): CascadeFlags {
	return {
		pauseAutomations: form.get('pauseAutomations') === '1',
		cancelBroadcasts: form.get('cancelBroadcasts') === '1',
	}
}

export type CascadeResult = {
	pausedAutomationIds: string[]
	cancelledCampaignIds: string[]
	/** What was asked but not done, and why. */
	skipped: Array<
		'automations_forbidden' | 'broadcasts_forbidden' | 'unreachable'
	>
	/** Messages that could not be changed (already gone, or the region said no). */
	failed: number
}

const EMPTY: CascadeResult = {
	pausedAutomationIds: [],
	cancelledCampaignIds: [],
	skipped: [],
	failed: 0,
}

export async function readDiscountUsedIn(
	fetchTenant: FetchTenant,
	discountId: string,
): Promise<DiscountUsedIn | null> {
	try {
		const res = await fetchTenant(
			`/operator/marketing/discount-used-in?discountId=${encodeURIComponent(discountId)}`,
		)
		if (!res.ok) return null
		const parsed = discountUsedInResponseSchema.safeParse(await res.json())
		return parsed.success ? parsed.data : null
	} catch {
		return null
	}
}

async function canUpdate(
	userId: string,
	organizationId: string,
	permission: string,
) {
	return userHasOrganizationPermission(
		userId,
		organizationId,
		permission as never,
	)
}

/** The discount was paused, archived or got an earlier end: act on what offers it. */
export async function cascadeOnPause(input: {
	request: Request
	organizationId: string
	orgSlug: string
	userId: string
	discountId: string
	flags: CascadeFlags
}): Promise<CascadeResult> {
	const { flags } = input
	if (!flags.pauseAutomations && !flags.cancelBroadcasts) return EMPTY
	const { fetchTenant } = await getOperatorTenantClient(
		input.request,
		input.orgSlug,
		{ canUpdate: true },
	)
	const usedIn = await readDiscountUsedIn(fetchTenant, input.discountId)
	if (!usedIn) return { ...EMPTY, skipped: ['unreachable'] }

	const result: CascadeResult = {
		pausedAutomationIds: [],
		cancelledCampaignIds: [],
		skipped: [],
		failed: 0,
	}

	if (flags.pauseAutomations) {
		if (
			!(await canUpdate(
				input.userId,
				input.organizationId,
				ORG_PERMISSIONS.UPDATE_AUTOMATION_ANY,
			))
		) {
			result.skipped.push('automations_forbidden')
		} else {
			for (const automation of usedIn.automations) {
				const res = await fetchTenant(
					`/operator/journeys/${encodeURIComponent(automation.id)}/pause`,
					{ method: 'POST' },
				).catch(() => null)
				if (res?.ok) result.pausedAutomationIds.push(automation.id)
				else result.failed++
			}
		}
	}

	if (flags.cancelBroadcasts) {
		if (
			!(await canUpdate(
				input.userId,
				input.organizationId,
				ORG_PERMISSIONS.UPDATE_CAMPAIGN_ANY,
			))
		) {
			result.skipped.push('broadcasts_forbidden')
		} else {
			// A broadcast already sending cannot be stopped (no mid-send stop).
			for (const broadcast of usedIn.broadcasts.filter(
				(entry) => entry.status === 'Scheduled',
			)) {
				const res = await fetchTenant(
					`/operator/marketing/campaigns/${encodeURIComponent(broadcast.id)}/cancel`,
					{ method: 'POST' },
				).catch(() => null)
				if (res?.ok) {
					result.cancelledCampaignIds.push(broadcast.id)
					await auditCampaign({
						kind: 'cancelled',
						userId: input.userId,
						organizationId: input.organizationId,
						campaignId: broadcast.id,
						request: input.request,
					})
				} else {
					result.failed++
				}
			}
		}
	}
	return result
}

function parseMetadata(raw: string | null): Record<string, unknown> {
	if (!raw) return {}
	try {
		const value: unknown = JSON.parse(raw)
		return value && typeof value === 'object'
			? (value as Record<string, unknown>)
			: {}
	} catch {
		return {}
	}
}

/**
 * Ids as the audit log keeps them. Its writer sanitizes metadata by walking
 * every object, an array included, so a list of ids is stored as an object
 * keyed by position (`{"0":"a-1","1":"a-2"}`). Both shapes are read, so the
 * pairing survives however the log wrote it.
 */
function ids(value: unknown): string[] {
	const list = Array.isArray(value)
		? value
		: value && typeof value === 'object'
			? Object.values(value)
			: []
	return list
		.filter((id): id is string => typeof id === 'string' && id.length > 0)
		.slice(0, 200)
}

/**
 * The automations paused together with this discount: those named by its latest
 * status change, and only while that change is the pause itself. Once the
 * discount was resumed (or paused again without a pairing) there is nothing to
 * offer. Ids from the audit log; the region says which are still paused.
 */
export async function pairedAutomationIdsByDiscount(
	organizationId: string,
	discountIds: readonly string[],
): Promise<Map<string, string[]>> {
	const result = new Map<string, string[]>()
	if (discountIds.length === 0) return result
	const rows = await db
		.select({
			resourceId: AuditLog.resourceId,
			metadata: AuditLog.metadata,
		})
		.from(AuditLog)
		.where(
			and(
				eq(AuditLog.organizationId, organizationId),
				eq(AuditLog.resourceType, DISCOUNT_RESOURCE_TYPE),
				eq(AuditLog.action, AuditAction.DISCOUNT_STATUS_CHANGED),
				// bounded: one page of discounts at most
				inArray(AuditLog.resourceId, [...discountIds].slice(0, 90)),
			),
		)
		.orderBy(desc(AuditLog.createdAt))
	const seen = new Set<string>()
	for (const row of rows) {
		if (!row.resourceId || seen.has(row.resourceId)) continue
		seen.add(row.resourceId)
		const metadata = parseMetadata(row.metadata)
		if (metadata.status === 'paused') {
			const paired = ids(metadata.pausedAutomationIds)
			if (paired.length > 0) result.set(row.resourceId, paired)
		}
	}
	return result
}

/** The paired automations that are still paused, with their names. */
export async function describePairedAutomations(input: {
	fetchTenant: FetchTenant
	organizationId: string
	discountId: string
}): Promise<Array<{ id: string; name: string }>> {
	const paired = (
		await pairedAutomationIdsByDiscount(input.organizationId, [
			input.discountId,
		])
	).get(input.discountId)
	if (!paired) return []
	const described = await Promise.all(
		paired.slice(0, 20).map(async (id) => {
			try {
				const res = await input.fetchTenant(
					`/operator/journeys/${encodeURIComponent(id)}`,
				)
				if (!res.ok) return null
				const body = (await res.json()) as {
					journey?: { name?: unknown; status?: unknown }
				}
				return body.journey?.status === 'paused' &&
					typeof body.journey.name === 'string'
					? { id, name: body.journey.name }
					: null
			} catch {
				return null
			}
		}),
	)
	return described.filter((entry): entry is { id: string; name: string } =>
		Boolean(entry),
	)
}

export type ResumeResult = {
	resumedAutomationIds: string[]
	failed: number
	forbidden: boolean
}

/** Resume what was paused with the discount (only those still paused). */
export async function resumePairedAutomations(input: {
	request: Request
	organizationId: string
	orgSlug: string
	userId: string
	automationIds: readonly string[]
}): Promise<ResumeResult> {
	const result: ResumeResult = {
		resumedAutomationIds: [],
		failed: 0,
		forbidden: false,
	}
	if (input.automationIds.length === 0) return result
	if (
		!(await canUpdate(
			input.userId,
			input.organizationId,
			ORG_PERMISSIONS.UPDATE_AUTOMATION_ANY,
		))
	) {
		return { ...result, forbidden: true }
	}
	const { fetchTenant } = await getOperatorTenantClient(
		input.request,
		input.orgSlug,
		{ canUpdate: true },
	)
	for (const id of input.automationIds.slice(0, 20)) {
		try {
			const current = await fetchTenant(
				`/operator/journeys/${encodeURIComponent(id)}`,
			)
			if (!current.ok) {
				result.failed++
				continue
			}
			const body = (await current.json()) as { journey?: { status?: unknown } }
			// Only what is still paused; one that was changed since stays as it is.
			if (body.journey?.status !== 'paused') continue
			const res = await fetchTenant(
				`/operator/journeys/${encodeURIComponent(id)}/publish`,
				{ method: 'POST' },
			)
			if (res.ok) result.resumedAutomationIds.push(id)
			else result.failed++
		} catch {
			result.failed++
		}
	}
	return result
}

/** An end date moved earlier (or added): `YYYY-MM-DDTHH:MM`, compared as text. */
export function endDateShortened(
	before: string | null | undefined,
	after: string | null | undefined,
): boolean {
	if (!after) return false
	if (!before) return true
	return after < before
}

/**
 * Definition fields a message promises: the amount a guest was told. A change
 * to one of them breaks what a scheduled or running message says.
 */
const PROMISE_KEYS = [
	'percentBp',
	'amountMinor',
	'valueType',
	'tiers',
	'maxDiscountMinor',
] as const

/**
 * Whether the amount a message promises changed. `undefined` and `null` are
 * the same here: an unchanged discount rebuilt from the editor leaves optional
 * fields undefined where the stored one holds null, and that is not an edit.
 */
export function promiseChanged(
	before: Record<string, unknown>,
	after: Record<string, unknown>,
): boolean {
	const canonical = (value: unknown) =>
		JSON.stringify(value === undefined ? null : value)
	return PROMISE_KEYS.some(
		(key) => canonical(before[key]) !== canonical(after[key]),
	)
}
