import { randomUUID } from 'node:crypto'
import { i18n } from '@lingui/core'
import { AuditAction, auditService } from '@repo/audit'
import {
	authSessionStorage,
	getSessionExpirationDate,
	sessionKey,
} from '@repo/auth'
import { getToast } from '@repo/common/toast'
import {
	db,
	eq,
	Organization,
	Role,
	Session,
	User,
	UserOrganization,
	_RoleToUser,
} from '@repo/database'
import { RouterContextProvider } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { action, loader } from './chat-retention.server.ts'

async function setup(role: 'admin' | 'user' = 'admin') {
	const id = randomUUID()
	const [user] = await db
		.insert(User)
		.values({ username: id, email: `${id}@example.com` })
		.returning()
	const [organization] = await db
		.insert(Organization)
		.values({ name: 'Test organization', slug: id, chatRetentionDays: 90 })
		.returning()
	if (!user || !organization) throw new Error('Test setup failed')

	await db
		.insert(Role)
		.values({ name: role, description: `${role} role` })
		.onConflictDoNothing()
	const roleRecord = await db.query.Role.findFirst({
		where: eq(Role.name, role),
	})
	if (!roleRecord) throw new Error('Test role missing')
	await db.insert(_RoleToUser).values({ A: roleRecord.id, B: user.id })
	await db.insert(UserOrganization).values({
		userId: user.id,
		organizationId: organization.id,
		organizationRoleId: 'org_role_admin',
	})
	const [session] = await db
		.insert(Session)
		.values({
			userId: user.id,
			expirationDate: getSessionExpirationDate(),
		})
		.returning()
	if (!session) throw new Error('Test session missing')
	const authSession = await authSessionStorage.getSession()
	authSession.set(sessionKey, session.id)
	const cookie = await authSessionStorage.commitSession(authSession)
	const defaultOrganizationId = organization.id

	function args(days?: string, organizationId = defaultOrganizationId) {
		const url = `http://localhost:3004/organizations/${organizationId}/chat-retention`
		return {
			request: new Request(url, {
				headers: { Cookie: cookie },
				...(days !== undefined
					? {
							method: 'POST',
							body: new URLSearchParams({ intent: 'retention', days }),
						}
					: {}),
			}),
			params: { organizationId },
			context: new RouterContextProvider(),
			url: new URL(url),
			pattern: '/organizations/:organizationId/chat-retention',
		}
	}

	return { user, organization, args }
}

describe('platform admin chat retention', () => {
	it('loads the current organization policy with private caching', async () => {
		const { organization, args } = await setup()
		const result = await loader(args())

		expect(result.data).toEqual({
			organization: { id: organization.id, name: organization.name },
			retentionDays: 90,
		})
		expect(result.init?.headers).toEqual({
			'Cache-Control': 'private, no-store',
		})
	})

	it.each([
		['30', 30],
		['90', 90],
		['365', 365],
		['forever', null],
	] as const)('saves and audits the %s policy', async (value, days) => {
		const { user, organization, args } = await setup()
		const audit = vi.spyOn(auditService, 'log').mockResolvedValue(undefined)

		const response = await action(args(value))
		expect(response).toBeInstanceOf(Response)
		expect((response as Response).status).toBe(302)
		expect((response as Response).headers.get('Location')).toBe(
			`/organizations/${organization.id}/chat-retention`,
		)
		const updated = await db.query.Organization.findFirst({
			where: eq(Organization.id, organization.id),
		})
		expect(updated?.chatRetentionDays).toBe(days)
		expect(audit).toHaveBeenCalledWith(
			expect.objectContaining({
				action: AuditAction.CHAT_RETENTION_UPDATED,
				userId: user.id,
				organizationId: organization.id,
			}),
		)
	})

	it('denies tenant admins without the platform admin role', async () => {
		const { organization, args } = await setup('user')

		await expect(loader(args())).rejects.toMatchObject({ status: 403 })
		await expect(action(args('30'))).rejects.toMatchObject({ status: 403 })
		const unchanged = await db.query.Organization.findFirst({
			where: eq(Organization.id, organization.id),
		})
		expect(unchanged?.chatRetentionDays).toBe(90)
	})

	it.each([
		[
			'en',
			'Message retention updated',
			'The policy will apply on the next daily chat cleanup.',
		],
		[
			'ar',
			'تم تحديث سياسة الاحتفاظ بالرسائل',
			'ستُطبّق السياسة في عملية التنظيف اليومية التالية للمحادثات.',
		],
	] as const)(
		'translates the confirmation for an %s request',
		async (locale, title, description) => {
			const { args } = await setup()
			vi.spyOn(auditService, 'log').mockResolvedValue(undefined)
			const requestArgs = args('30')
			requestArgs.request.headers.set('Accept-Language', locale)
			const previousLocale = i18n.locale
			const response = await action(requestArgs)
			const toastCookie = (response as Response).headers.get('set-cookie')
			expect(toastCookie).not.toBeNull()
			const { toast } = await getToast(
				new Request('http://localhost:3004/', {
					headers: { Cookie: toastCookie! },
				}),
			)

			expect(toast).toMatchObject({ title, description, type: 'success' })
			expect(i18n.locale).toBe(previousLocale)
		},
	)

	it.each(['0', '15', '-30', '30.5', '', 'null'])(
		'rejects invalid retention value %s without updating or auditing',
		async (value) => {
			const { organization, args } = await setup()
			const audit = vi.spyOn(auditService, 'log').mockResolvedValue(undefined)

			const response = await action(args(value))
			expect(response).toMatchObject({
				data: { error: 'Choose a valid retention period.' },
				init: { status: 400 },
			})
			const unchanged = await db.query.Organization.findFirst({
				where: eq(Organization.id, organization.id),
			})
			expect(unchanged?.chatRetentionDays).toBe(90)
			expect(audit).not.toHaveBeenCalled()
		},
	)

	it('returns 404 for missing organizations', async () => {
		const { args } = await setup()

		await expect(loader(args(undefined, 'missing'))).rejects.toMatchObject({
			status: 404,
		})
		await expect(action(args('30', 'missing'))).rejects.toMatchObject({
			status: 404,
		})
	})
})
