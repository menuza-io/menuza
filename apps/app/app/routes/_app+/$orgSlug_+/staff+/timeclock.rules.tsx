import { auditService, AuditAction } from '@repo/audit'
import { isImpersonating } from '@repo/auth'
import { db, eq, Organization } from '@repo/database'
import { STAFFING_PERMISSIONS } from '@repo/staffing'
import { data, useLoaderData } from 'react-router'
import { z } from 'zod'
import { LaborPolicyEditor } from '#app/components/staff/labor-policy-editor.tsx'
import { TimeZoneCard } from '#app/components/staff/time-zone-card.tsx'
import { requireStaffingAccess } from '#app/utils/staffing/access.server.ts'
import { loadOrganizationScope } from '#app/utils/staffing/scope.server.ts'
import {
	TIMECLOCK_SETTINGS_REQUIREMENT,
	TIMEZONE_WRITE_REQUIREMENT,
} from '#app/utils/staffing/sections.ts'
import { loadTimeclockScopes } from '#app/utils/staffing/timeclock-context.server.ts'
import { type Route } from './+types/timeclock.rules.ts'

const timeZoneSchema = z.object({
	timeZone: z
		.string()
		.trim()
		.min(1)
		.max(64)
		.refine((zone) => {
			try {
				new Intl.DateTimeFormat('en-US', { timeZone: zone })
				return true
			} catch {
				return false
			}
		}),
})

export async function loader({ request, params }: Route.LoaderArgs) {
	const access = await requireStaffingAccess(
		request,
		params.orgSlug,
		TIMECLOCK_SETTINGS_REQUIREMENT,
	)
	const canWrite = access.grants.some(
		(grant) =>
			`${grant.action}:${grant.entity}:${grant.access}` ===
			STAFFING_PERMISSIONS.UPDATE_LABOR_POLICY,
	)
	const scope = await loadOrganizationScope(access.organizationId)
	return {
		orgSlug: params.orgSlug,
		scopes: await loadTimeclockScopes(access.organizationId, access.scopeIds),
		/** The organization default is only editable with every workplace. */
		canEditDefault: access.scopeIds === null,
		timeZone: scope.timeZone,
		canEditTimeZone: canWrite && access.scopeIds === null,
		dataRegion:
			access.dataRegion === 'ksa' ? ('ksa' as const) : ('us' as const),
	}
}

/**
 * `POST /:orgSlug/staff/timeclock/rules`: set the organization's staff time
 * zone. Needs the labor policy grant and staffing access to every workplace; the
 * change is written to the audit log with the old and new zone.
 */
export async function action({ request, params }: Route.ActionArgs) {
	const access = await requireStaffingAccess(
		request,
		params.orgSlug,
		TIMEZONE_WRITE_REQUIREMENT,
	)
	if (request.method !== 'POST') {
		throw data({ error: 'Method not allowed' }, { status: 405 })
	}
	if (await isImpersonating(request)) {
		throw data(
			{ error: 'Impersonated sessions are read-only' },
			{ status: 403 },
		)
	}
	if (access.scopeIds !== null) {
		return data({ error: 'unrestricted_scope_required' }, { status: 403 })
	}
	const parsed = timeZoneSchema.safeParse(
		Object.fromEntries(await request.formData()),
	)
	if (!parsed.success) {
		return data({ error: 'invalid_time_zone' }, { status: 400 })
	}

	const previous = await loadOrganizationScope(access.organizationId)
	await db
		.update(Organization)
		.set({ staffingTimeZone: parsed.data.timeZone })
		.where(eq(Organization.id, access.organizationId))
	await auditService.log({
		action: AuditAction.ORG_SETTINGS_UPDATED,
		userId: access.userId,
		organizationId: access.organizationId,
		details: `Staff time zone changed from ${previous.timeZone} to ${parsed.data.timeZone}.`,
		resourceType: 'organization',
		resourceId: access.organizationId,
		metadata: {
			setting: 'staffingTimeZone',
			from: previous.timeZone,
			to: parsed.data.timeZone,
		},
		request,
	})
	return data({ ok: true as const })
}

export default function StaffTimeclockRulesRoute() {
	const {
		orgSlug,
		scopes,
		canEditDefault,
		dataRegion,
		timeZone,
		canEditTimeZone,
	} = useLoaderData<typeof loader>()
	return (
		<div className="flex flex-col gap-8">
			<TimeZoneCard
				orgSlug={orgSlug}
				timeZone={timeZone}
				canEdit={canEditTimeZone}
			/>
			<LaborPolicyEditor
				scopes={scopes}
				canEditDefault={canEditDefault}
				dataRegion={dataRegion}
			/>
		</div>
	)
}
