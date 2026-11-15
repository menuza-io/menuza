import { getFeatureFlag } from '@repo/common/feature-flags'
import { lt, Organization, sql } from '@repo/database'
import { postToApp } from './app-service.server.ts'
import { launchStatusSchema, type LaunchStatusResult } from './launch-status.ts'

export { type LaunchStatus, type LaunchStatusResult } from './launch-status.ts'

/** An organization still in setup this long after sign-up counts as stuck. */
export const STUCK_IN_SETUP_DAYS = 14
const DAY_MS = 86_400_000

/**
 * "Stuck in setup for more than 14 days": signed up more than 14 days ago,
 * on the launch checklist, and no location ever reached live
 * (`OrganizationLocation.liveAt`, set once by the checklist). Organizations
 * not on the checklist are left out: nothing records their launch.
 */
export async function stuckInSetupCondition(now: Date) {
	const cutoff = new Date(now.getTime() - STUCK_IN_SETUP_DAYS * DAY_MS)
	const systemOn = (await getFeatureFlag('launch.checklist', {})) === true
	return sql`${lt(Organization.createdAt, cutoff)}
		and not exists (
			select 1 from "OrganizationLocation" as live_location
			where live_location."organizationId" = ${Organization.id}
				and live_location."liveAt" is not null
		)
		and (${systemOn ? sql`1 = 1` : sql`0 = 1`} or exists (
			select 1 from "ConfigFlag" as launch_flag
			where launch_flag."organizationId" = ${Organization.id}
				and launch_flag."key" = 'launch.checklist'
				and launch_flag."level" = 'organization'
				and launch_flag."value" = 'true'
		))`
}

/**
 * The organization's launch checklist from the App, evaluated by the same
 * code the App's launch page uses. The first-order date comes from the
 * region through the App as a timestamp only.
 */
export async function loadLaunchStatus(
	organizationId: string,
): Promise<LaunchStatusResult> {
	const result = await postToApp(
		'/resources/launch-status',
		{ organizationId },
		{ timeoutMs: 8_000 },
	)
	if (result.status !== 'answered' || !result.response.ok) {
		return { status: 'unavailable' }
	}
	const parsed = launchStatusSchema.safeParse(
		await result.response.json().catch(() => null),
	)
	return parsed.success
		? { status: 'ok', launch: parsed.data }
		: { status: 'unavailable' }
}
