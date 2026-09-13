import { parseWithZod } from '@conform-to/zod'
import { invariant } from '@epic-web/invariant'
import { Trans } from '@lingui/macro'
import { requireUserWithRole } from '@repo/auth'
import { redirectWithToast } from '@repo/common/toast'
import {
	AuditLog,
	Organization,
	OrganizationRole,
	SSOConfiguration,
	SSOSession,
	Session,
	User,
	UserImage,
	UserOrganization,
	and,
	db,
	desc,
	eq,
	isNull,
	like,
	or,
} from '@repo/database'
import { useLoaderData } from 'react-router'
import { z } from 'zod'
import { SSOUserManagement } from '#app/components/sso-user-management.tsx'
import { auditLogService } from '#app/utils/audit-log.server.ts'
import { ssoConfigurationService } from '#app/utils/sso-configuration.server.ts'
import { type Route } from './+types/$organizationId.sso.users.ts'

const SSOUserActionSchema = z.object({
	intent: z.enum(['change_role', 'toggle_status']),
	userId: z.string(),
	roleId: z.string().optional(),
	active: z.boolean().optional(),
})

export async function loader({ request, params }: Route['LoaderArgs']) {
	await requireUserWithRole(request, 'admin')

	async function getOrganizationForSSO(organizationId: string) {
		const [organization] = await db
			.select({
				id: Organization.id,
				name: Organization.name,
				slug: Organization.slug,
			})
			.from(Organization)
			.where(eq(Organization.id, organizationId))
			.limit(1)

		if (!organization) {
			throw new Response('Organization not found', { status: 404 })
		}

		return organization
	}

	invariant(params.organizationId, 'Organization ID is required')

	// Get organization
	const organization = await getOrganizationForSSO(params.organizationId)

	// Get SSO configuration
	const ssoConfig = await ssoConfigurationService.getConfiguration(
		organization.id,
	)

	if (!ssoConfig) {
		throw new Response('SSO not configured for this organization', {
			status: 404,
		})
	}

	// Get users who have authenticated through SSO
	const ssoRows = await db
		.select({
			user: {
				id: User.id,
				name: User.name,
				email: User.email,
				username: User.username,
			},
			image: { id: UserImage.id, altText: UserImage.altText },
			organizationRole: {
				id: OrganizationRole.id,
				name: OrganizationRole.name,
				level: OrganizationRole.level,
			},
			active: UserOrganization.active,
			isDefault: UserOrganization.isDefault,
			department: UserOrganization.department,
			createdAt: UserOrganization.createdAt,
			updatedAt: UserOrganization.updatedAt,
			ssoSession: {
				id: SSOSession.id,
				providerUserId: SSOSession.providerUserId,
				createdAt: SSOSession.createdAt,
				updatedAt: SSOSession.updatedAt,
			},
			providerName: SSOConfiguration.providerName,
		})
		.from(User)
		.innerJoin(UserOrganization, eq(UserOrganization.userId, User.id))
		.innerJoin(
			OrganizationRole,
			eq(UserOrganization.organizationRoleId, OrganizationRole.id),
		)
		.leftJoin(UserImage, eq(UserImage.userId, User.id))
		.innerJoin(Session, eq(Session.userId, User.id))
		.innerJoin(SSOSession, eq(SSOSession.sessionId, Session.id))
		.innerJoin(
			SSOConfiguration,
			eq(SSOSession.ssoConfigId, SSOConfiguration.id),
		)
		.where(
			and(
				eq(UserOrganization.organizationId, organization.id),
				eq(SSOSession.ssoConfigId, ssoConfig.id),
			),
		)
		.orderBy(desc(SSOSession.updatedAt))

	// Transform the data to match the expected interface
	const usersById = new Map<
		string,
		(typeof ssoRows)[number] & {
			ssoSessions: unknown[]
		}
	>()
	for (const row of ssoRows) {
		const current = usersById.get(row.user.id)
		if (current) {
			current.ssoSessions.push({
				...row.ssoSession,
				ssoConfig: { providerName: row.providerName },
			})
		} else {
			usersById.set(row.user.id, {
				...row,
				ssoSessions: [
					{ ...row.ssoSession, ssoConfig: { providerName: row.providerName } },
				],
			})
		}
	}
	const transformedSSOUsers = [...usersById.values()]

	// Get available roles
	const availableRoles = await db
		.select({
			id: OrganizationRole.id,
			name: OrganizationRole.name,
			level: OrganizationRole.level,
		})
		.from(OrganizationRole)
		.where(
			or(
				isNull(OrganizationRole.organizationId),
				eq(OrganizationRole.organizationId, organization.id),
			),
		)
		.orderBy(desc(OrganizationRole.level))

	// Get SSO audit logs
	const auditLogs = await db
		.select({
			id: AuditLog.id,
			action: AuditLog.action,
			createdAt: AuditLog.createdAt,
			metadata: AuditLog.metadata,
			details: AuditLog.details,
			user: { id: User.id, name: User.name, username: User.username },
		})
		.from(AuditLog)
		.leftJoin(User, eq(AuditLog.userId, User.id))
		.where(
			and(
				eq(AuditLog.organizationId, organization.id),
				like(AuditLog.action, 'sso_%'),
			),
		)
		.orderBy(desc(AuditLog.createdAt))
		.limit(50)

	return Response.json({
		organization,
		ssoConfig,
		ssoUsers: transformedSSOUsers,
		availableRoles,
		auditLogs: auditLogs.map((log) => ({
			...log,
			metadata: log.metadata ? JSON.parse(log.metadata) : null,
		})),
	})
}

export async function action({ request, params }: Route['ActionArgs']) {
	const adminUserId = await requireUserWithRole(request, 'admin')

	invariant(params.organizationId, 'Organization ID is required')

	const formData = await request.formData()
	const submission = parseWithZod(formData, {
		schema: SSOUserActionSchema,
	})

	if (submission.status !== 'success') {
		return Response.json(
			{ result: submission.reply() },
			{ status: submission.status === 'error' ? 400 : 200 },
		)
	}

	const { intent, userId, roleId, active } = submission.value

	try {
		switch (intent) {
			case 'change_role': {
				if (!roleId) {
					return Response.json(
						{
							result: submission.reply({
								formErrors: ['Role ID is required'],
							}),
						},
						{ status: 400 },
					)
				}

				const [assignableRole] = await db
					.select({ id: OrganizationRole.id })
					.from(OrganizationRole)
					.where(
						and(
							eq(OrganizationRole.id, roleId),
							or(
								isNull(OrganizationRole.organizationId),
								eq(OrganizationRole.organizationId, params.organizationId),
							),
						),
					)
					.limit(1)

				if (!assignableRole) {
					return Response.json(
						{
							result: submission.reply({
								formErrors: ['Role is not available for this organization'],
							}),
						},
						{ status: 400 },
					)
				}

				await db
					.update(UserOrganization)
					.set({
						organizationRoleId: roleId,
					})
					.where(
						and(
							eq(UserOrganization.userId, userId),
							eq(UserOrganization.organizationId, params.organizationId),
						),
					)

				// Log the role change
				await auditLogService.logSSOUserManagement(
					params.organizationId,
					adminUserId, // admin user making the change
					userId, // target user
					'role_changed',
					{ newRoleId: roleId },
				)

				return redirectWithToast(
					`/organizations/${params.organizationId}/sso/users`,
					{
						type: 'success',
						title: 'User Role Updated',
						description: 'The user role has been successfully updated.',
					},
				)
			}

			case 'toggle_status': {
				if (active === undefined) {
					return Response.json(
						{
							result: submission.reply({
								formErrors: ['Active status is required'],
							}),
						},
						{ status: 400 },
					)
				}

				await db
					.update(UserOrganization)
					.set({
						active,
					})
					.where(
						and(
							eq(UserOrganization.userId, userId),
							eq(UserOrganization.organizationId, params.organizationId),
						),
					)

				// Log the status change
				await auditLogService.logSSOUserManagement(
					params.organizationId,
					adminUserId, // admin user making the change
					userId, // target user
					active ? 'activated' : 'deactivated',
					{ active },
				)

				return redirectWithToast(
					`/organizations/${params.organizationId}/sso/users`,
					{
						type: 'success',
						title: `User ${active ? 'Activated' : 'Deactivated'}`,
						description: `The user has been successfully ${active ? 'activated' : 'deactivated'}.`,
					},
				)
			}

			default:
				return Response.json(
					{
						result: submission.reply({
							formErrors: ['Invalid action'],
						}),
					},
					{ status: 400 },
				)
		}
	} catch (error) {
		console.error('SSO user management error:', error)
		return Response.json(
			{
				result: submission.reply({
					formErrors: ['An error occurred while processing the request'],
				}),
			},
			{ status: 500 },
		)
	}
}

export default function AdminOrganizationSSOUsersPage() {
	const data = useLoaderData<typeof loader>()
	const {
		organization: org,
		ssoConfig: ignoredSsoConfig,
		ssoUsers,
		availableRoles,
		auditLogs,
	} = data

	if (!org) {
		throw new Error('Organization not found')
	}

	const organization = org as { id: string; name: string; slug: string }
	const organizationName = organization.name

	const handleRoleChange = (userId: string, roleId: string) => {
		const form = document.createElement('form')
		form.method = 'POST'
		form.style.display = 'none'

		const intentInput = document.createElement('input')
		intentInput.name = 'intent'
		intentInput.value = 'change_role'
		form.appendChild(intentInput)

		const userIdInput = document.createElement('input')
		userIdInput.name = 'userId'
		userIdInput.value = userId
		form.appendChild(userIdInput)

		const roleIdInput = document.createElement('input')
		roleIdInput.name = 'roleId'
		roleIdInput.value = roleId
		form.appendChild(roleIdInput)

		document.body.appendChild(form)
		form.submit()
	}

	const handleUserStatusChange = (userId: string, active: boolean) => {
		const form = document.createElement('form')
		form.method = 'POST'
		form.style.display = 'none'

		const intentInput = document.createElement('input')
		intentInput.name = 'intent'
		intentInput.value = 'toggle_status'
		form.appendChild(intentInput)

		const userIdInput = document.createElement('input')
		userIdInput.name = 'userId'
		userIdInput.value = userId
		form.appendChild(userIdInput)

		const activeInput = document.createElement('input')
		activeInput.name = 'active'
		activeInput.value = active.toString()
		form.appendChild(activeInput)

		document.body.appendChild(form)
		form.submit()
	}

	return (
		<div className="space-y-6">
			{/* Page Header */}
			<div className="flex items-center justify-between">
				<div>
					<h1 className="text-3xl font-bold tracking-tight">
						<Trans>SSO Users</Trans>
					</h1>
					<p className="text-muted-foreground">
						<Trans>
							Manage users who authenticate through SSO for {organizationName}
						</Trans>
					</p>
				</div>
			</div>

			{/* SSO User Management */}
			<SSOUserManagement
				organizationId={organization.id}
				ssoUsers={ssoUsers}
				auditLogs={auditLogs}
				availableRoles={availableRoles}
				onRoleChange={handleRoleChange}
				onUserStatusChange={handleUserStatusChange}
			/>
		</div>
	)
}
