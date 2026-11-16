import {
	type AudienceCounts,
	type AudienceDefinition,
} from '@repo/common/marketing-audiences'
import { type getOperatorTenantClient } from '#app/utils/tenant-api.server.ts'

type FetchTenant = Awaited<ReturnType<typeof getOperatorTenantClient>>['fetchTenant']

/**
 * Saved audiences (#98) as the App sees them: names, ids, definitions and
 * floored counts. Never a guest: tenant-api answers with counts only, and the
 * definition holds numbers and ids.
 */
export type AudienceListItem = {
	id: string
	name: string
	version: number
	systemKey: string | null
	definition: AudienceDefinition
	counts: AudienceCounts | null
}

export async function loadAudiences(
	fetchTenant: FetchTenant,
	options: { counts?: boolean } = {},
): Promise<AudienceListItem[] | null> {
	const res = await fetchTenant(
		`/operator/marketing/audiences${options.counts === false ? '?counts=0' : ''}`,
	)
	if (!res.ok) return null
	const data = (await res.json().catch(() => null)) as {
		audiences?: AudienceListItem[]
	} | null
	return data?.audiences ?? null
}

/** Names and ids for the broadcast composer and the automation condition. */
export async function loadAudienceOptions(
	fetchTenant: FetchTenant,
): Promise<Array<{ id: string; name: string }> | undefined> {
	const audiences = await loadAudiences(fetchTenant, { counts: false })
	return audiences?.map(({ id, name }) => ({ id, name }))
}
