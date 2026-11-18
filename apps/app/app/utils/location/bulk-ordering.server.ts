import { ORDERING_PAUSE_DURATIONS } from '@repo/common/location-availability'
import { db, eq, OrganizationLocation } from '@repo/database'
import { z } from 'zod'
import { purgeOrganizationSiteCache } from '#app/utils/sites/kv-cache.server.ts'
import { applyOrderingControl } from './ordering-controls.server.ts'
import { PAUSE_REASON_MAX_LENGTH } from './ordering-pause.ts'

/** Most locations one bulk action may name (more than any group has). */
export const MAX_BULK_LOCATIONS = 200

const locationIds = z
	.array(z.string().trim().min(1).max(64))
	.min(1)
	.max(MAX_BULK_LOCATIONS)

export const bulkOrderingInputSchema = z.discriminatedUnion('action', [
	z.object({
		action: z.literal('pause'),
		locationIds,
		duration: z.enum(ORDERING_PAUSE_DURATIONS),
		reason: z.string().trim().max(PAUSE_REASON_MAX_LENGTH).optional(),
	}),
	z.object({
		action: z.literal('resume'),
		locationIds,
	}),
])
export type BulkOrderingInput = z.infer<typeof bulkOrderingInputSchema>

export type BulkOrderingLocationResult = {
	locationId: string
	name: string | null
	status: 'done' | 'skipped' | 'failed'
	/** Why it was skipped or failed, as a code the screen words. */
	reason?: 'not_manageable' | 'not_found' | 'failed'
}

export type BulkOrderingResult = {
	action: 'pause' | 'resume'
	/** Locations asked for (duplicates removed). */
	total: number
	done: number
	skipped: number
	failed: number
	locations: BulkOrderingLocationResult[]
}

/**
 * Pauses or resumes online ordering at many locations in one action (#365).
 * It runs the same per-location writer as the Orders page and Station
 * (`applyOrderingControl`: one `organizationLocation` update and one activity
 * log entry with who, when, the duration and the reason), so there is no second
 * pause mechanism. Locations outside the person's scope or the organization are
 * skipped and listed; a failure on one location is recorded for that location
 * and never stops the rest.
 */
export async function bulkOrderingControl(input: {
	organization: { id: string; slug: string }
	userId: string
	/** `null` is every location; otherwise the ids the person may manage. */
	scope: string[] | null
	request: Request
	body: BulkOrderingInput
	now?: Date
}): Promise<BulkOrderingResult> {
	const { organization, body } = input
	const requested = [...new Set(body.locationIds)]
	const rows = await db
		.select({ id: OrganizationLocation.id, name: OrganizationLocation.name })
		.from(OrganizationLocation)
		.where(eq(OrganizationLocation.organizationId, organization.id))
	const names = new Map(rows.map((row) => [row.id, row.name]))

	const results: BulkOrderingLocationResult[] = []
	const manageable: string[] = []
	for (const id of requested) {
		if (!names.has(id)) {
			results.push({
				locationId: id,
				name: null,
				status: 'skipped',
				reason: 'not_found',
			})
		} else if (input.scope !== null && !input.scope.includes(id)) {
			results.push({
				locationId: id,
				name: names.get(id) ?? null,
				status: 'skipped',
				reason: 'not_manageable',
			})
		} else {
			manageable.push(id)
		}
	}

	for (const id of manageable) {
		try {
			const result = await applyOrderingControl({
				organization,
				userId: input.userId,
				control:
					body.action === 'pause'
						? {
								intent: 'pause',
								locationId: id,
								duration: body.duration,
								...(body.reason ? { reason: body.reason } : {}),
							}
						: { intent: 'resume', locationId: id },
				request: input.request,
				now: input.now,
				skipPurge: true,
				bulk: { size: requested.length },
			})
			results.push({
				locationId: id,
				name: names.get(id) ?? null,
				status: result.ok ? 'done' : 'failed',
				...(result.ok ? {} : { reason: 'failed' as const }),
			})
		} catch (error) {
			console.error('bulk ordering control failed for a location', {
				organizationId: organization.id,
				locationId: id,
				reason: error instanceof Error ? error.name : 'unknown',
			})
			results.push({
				locationId: id,
				name: names.get(id) ?? null,
				status: 'failed',
				reason: 'failed',
			})
		}
	}

	// One purge for the whole action: Sites shows every change at once.
	if (results.some((result) => result.status === 'done')) {
		await purgeOrganizationSiteCache(organization.id, organization.slug)
	}

	const order = new Map(requested.map((id, index) => [id, index]))
	results.sort((a, b) => order.get(a.locationId)! - order.get(b.locationId)!)
	return {
		action: body.action,
		total: requested.length,
		done: results.filter((r) => r.status === 'done').length,
		skipped: results.filter((r) => r.status === 'skipped').length,
		failed: results.filter((r) => r.status === 'failed').length,
		locations: results,
	}
}
