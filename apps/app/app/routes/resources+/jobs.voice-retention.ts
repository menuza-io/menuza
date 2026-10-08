import { db, eq, Organization, PhoneAgent } from '@repo/database'
import { ENV } from 'varlock/env'

import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'
import { resolveRegionalTenantApiUrls } from '#app/utils/tenant-api.server.ts'

import { type Route } from './+types/jobs.voice-retention.ts'

type VoicePurgeResult = {
	recordingsDeleted: number
	recordingsPending: number
	recordingsFailed: number
	transcriptsCleared: number
	requestsCleared: number
	followUpsResolved: number
	recordingsDeferred: number
	handoffsDeleted: number
}

const EMPTY_RESULT: VoicePurgeResult = {
	recordingsDeleted: 0,
	recordingsPending: 0,
	recordingsFailed: 0,
	transcriptsCleared: 0,
	requestsCleared: 0,
	followUpsResolved: 0,
	recordingsDeferred: 0,
	handoffsDeleted: 0,
}

/** Organizations purged in parallel; batches run one after another. */
export const VOICE_PURGE_BATCH_SIZE = 10
const VOICE_PURGE_TIMEOUT_MS = 30_000

type PurgeTarget = { id: string; dataRegion: string }

async function purgeOrganization(
	organization: PurgeTarget,
	token: string,
): Promise<VoicePurgeResult> {
	const { tenantApiUrl } = resolveRegionalTenantApiUrls(organization.dataRegion)
	const response = await fetch(`${tenantApiUrl}/api/voice/retention/purge`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			orgId: organization.id,
			dataRegion: organization.dataRegion,
		}),
		signal: AbortSignal.timeout(VOICE_PURGE_TIMEOUT_MS),
	})
	if (!response.ok) {
		throw new Error(`Voice purge failed with ${response.status}`)
	}
	const body = (await response.json()) as Partial<VoicePurgeResult>
	return {
		recordingsDeleted: body.recordingsDeleted ?? 0,
		recordingsPending: body.recordingsPending ?? 0,
		recordingsFailed: body.recordingsFailed ?? 0,
		transcriptsCleared: body.transcriptsCleared ?? 0,
		requestsCleared: body.requestsCleared ?? 0,
		followUpsResolved: body.followUpsResolved ?? 0,
		recordingsDeferred: body.recordingsDeferred ?? 0,
		handoffsDeleted: body.handoffsDeleted ?? 0,
	}
}

/**
 * Daily: each regional tenant-api deletes expired call recordings and clears
 * caller data past its retention. Only counts come back to App; no caller
 * data leaves the region.
 *
 * Every organization that has (or had) a phone agent and still has a tenant
 * database is purged, including inactive ones: their recordings still expire.
 */
export async function action({ request }: Route.ActionArgs) {
	if (request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 })
	}
	await requireInternalCommandAuth(request)

	const organizations = await db
		.select({ id: Organization.id, dataRegion: Organization.dataRegion })
		.from(Organization)
		.innerJoin(PhoneAgent, eq(PhoneAgent.organizationId, Organization.id))
		.where(eq(Organization.hasProvisionedDb, true))
		.orderBy(Organization.id)
	const token = ENV.INTERNAL_COMMAND_TOKEN

	const totals = { ...EMPTY_RESULT }
	let failed = 0
	for (
		let start = 0;
		start < organizations.length;
		start += VOICE_PURGE_BATCH_SIZE
	) {
		const batch = organizations.slice(start, start + VOICE_PURGE_BATCH_SIZE)
		const results = await Promise.allSettled(
			batch.map((organization) => purgeOrganization(organization, token)),
		)
		for (const [index, result] of results.entries()) {
			if (result.status === 'rejected') {
				failed++
				console.error('Voice retention purge failed', {
					organizationId: batch[index]!.id,
					error:
						result.reason instanceof Error
							? result.reason.message
							: String(result.reason),
				})
				continue
			}
			for (const key of Object.keys(totals) as Array<keyof VoicePurgeResult>) {
				totals[key] += result.value[key]
			}
		}
	}

	return Response.json(
		{
			success: failed === 0 && totals.recordingsFailed === 0,
			...totals,
			failed,
			organizations: organizations.length,
		},
		{ status: failed === 0 ? 200 : 502 },
	)
}
