import { and, db, eq, Organization } from '@repo/database'
import { ENV } from 'varlock/env'

import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'
import { resolveRegionalTenantApiUrls } from '#app/utils/tenant-api.server.ts'

import { type Route } from './+types/jobs.form-submission-retention.ts'

const FORM_SUBMISSION_RETENTION_DAYS = 365

export async function action({ request }: Route.ActionArgs) {
	if (request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 })
	}
	await requireInternalCommandAuth(request)

	const organizations = await db
		.select({ id: Organization.id, dataRegion: Organization.dataRegion })
		.from(Organization)
		.where(
			and(
				eq(Organization.active, true),
				eq(Organization.hasProvisionedDb, true),
			),
		)
	const token = ENV.INTERNAL_COMMAND_TOKEN
	const results = await Promise.allSettled(
		organizations.map(async (organization) => {
			const { tenantApiUrl } = resolveRegionalTenantApiUrls(
				organization.dataRegion,
			)
			const response = await fetch(
				`${tenantApiUrl}/api/forms/purge-submissions`,
				{
					method: 'POST',
					headers: {
						Authorization: `Bearer ${token}`,
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({
						orgId: organization.id,
						retentionDays: FORM_SUBMISSION_RETENTION_DAYS,
					}),
					signal: AbortSignal.timeout(10_000),
				},
			)
			if (!response.ok) throw new Error(`Purge failed with ${response.status}`)
			return (await response.json()) as { deleted: number }
		}),
	)

	const deleted = results.reduce(
		(total, result) =>
			total + (result.status === 'fulfilled' ? result.value.deleted : 0),
		0,
	)
	const failed = results.filter((result) => result.status === 'rejected').length
	return Response.json(
		{ success: failed === 0, deleted, failed, organizations: results.length },
		{ status: failed === 0 ? 200 : 502 },
	)
}
