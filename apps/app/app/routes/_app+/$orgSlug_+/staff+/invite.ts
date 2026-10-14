import { isImpersonating } from '@repo/auth'
import { db, eq, User } from '@repo/database'
import { opaqueIdSchema } from '@repo/staffing'
import { data, type ActionFunctionArgs } from 'react-router'
import { z } from 'zod'
import {
	createOrganizationInvitation,
	sendOrganizationInvitationEmail,
} from '#app/utils/organization/invitation.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	ORG_PERMISSIONS,
	requireUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'
import {
	checkRateLimit,
	createRateLimitResponse,
	ORGANIZATION_INVITE_RATE_LIMIT,
} from '#app/utils/rate-limit.server.ts'
import { requireStaffingAccess } from '#app/utils/staffing/access.server.ts'
import { STAFF_WRITE_REQUIREMENT } from '#app/utils/staffing/sections.ts'

const inviteSchema = z.object({
	email: z.string().trim().toLowerCase().email().max(254),
	// The staff record this invitation is for. Optional so a plain invite still
	// works; when present, accepting links the new login to that record.
	staffId: opaqueIdSchema.optional(),
})

/**
 * `POST /:orgSlug/staff/invite`: invite one staff member to the app as a plain
 * member. The email is typed or confirmed by the manager in a confirm dialog,
 * and travels from the browser to this route exactly like an invite sent from
 * Members; nothing else about the person (name, pay, PIN) is sent beyond the
 * opaque `staffId`, which the invitation carries so that accepting it links the
 * new login to that staff record (through the staffing outbox, ids only).
 *
 * Gates, in order: staffing flag and staff-update permission, member-invite
 * permission, not an impersonated session, not a Saudi-region organization (a
 * login email is a US-held identifier, so that is a residency decision for the
 * owner), then the same rate limit as the Members page. Attaching a `staffId`
 * additionally needs staffing access to every workplace.
 */
export async function action({ request, params }: ActionFunctionArgs) {
	if (request.method !== 'POST') {
		throw data({ error: 'Method not allowed' }, { status: 405 })
	}
	const access = await requireStaffingAccess(
		request,
		params.orgSlug,
		STAFF_WRITE_REQUIREMENT,
	)
	await requireUserWithOrganizationPermission(
		request,
		access.organizationId,
		ORG_PERMISSIONS.CREATE_MEMBER_ANY,
	)
	if (await isImpersonating(request)) {
		throw data(
			{ error: 'Impersonated sessions are read-only' },
			{ status: 403 },
		)
	}
	if (access.dataRegion === 'ksa') {
		return data({ error: 'region_not_supported' }, { status: 409 })
	}

	const rateLimit = await checkRateLimit(
		{ type: 'user', value: `${access.userId}:${access.organizationId}` },
		ORGANIZATION_INVITE_RATE_LIMIT,
	)
	if (!rateLimit.allowed) return createRateLimitResponse(rateLimit.resetAt)

	const parsed = inviteSchema.safeParse(
		Object.fromEntries(await request.formData()),
	)
	if (!parsed.success) {
		const badStaffId = parsed.error.issues.some(
			(issue) => issue.path[0] === 'staffId',
		)
		return data(
			{ error: badStaffId ? 'invalid_staff_id' : 'invalid_email' },
			{ status: 400 },
		)
	}

	// Linking a login to a staff record is a trust decision about identity, so
	// (like the member import, and tenant-api's own rule) it is limited to a
	// manager whose staffing access is not narrowed to selected scopes: the
	// record may also belong to scopes they cannot see. A plain invite still
	// works for them.
	if (parsed.data.staffId && access.scopeIds !== null) {
		return data({ error: 'unrestricted_scope_required' }, { status: 403 })
	}

	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		name: true,
	})
	const [inviter] = await db
		.select({ name: User.name, email: User.email })
		.from(User)
		.where(eq(User.id, access.userId))
		.limit(1)

	try {
		const { invitation } = await createOrganizationInvitation({
			organizationId: organization.id,
			email: parsed.data.email,
			role: 'member',
			inviterId: access.userId,
			staffMemberId: parsed.data.staffId,
			request,
		})
		await sendOrganizationInvitationEmail({
			invitation,
			organizationName: organization.name,
			inviterName: inviter?.name || inviter?.email || 'Someone',
		})
	} catch (error) {
		console.error(
			'Staff invite failed',
			error instanceof Error ? error.name : '',
		)
		return data({ error: 'invite_failed' }, { status: 500 })
	}
	return data({ ok: true as const })
}
