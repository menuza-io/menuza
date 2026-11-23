import { randomUUID } from 'node:crypto'
import { AuditAction, auditService } from '@repo/audit'
import {
	authSessionStorage,
	getSessionExpirationDate,
	sessionKey,
} from '@repo/auth'
import {
	Organization,
	OrganizationAssignment,
	OrganizationLocation,
	Role,
	Session,
	User,
	UserOrganization,
	_RoleToUser,
	db,
	eq,
} from '@repo/database'
import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { action as assignAction } from '../routes/_admin+/organizations+/$organizationId_+/assignments.tsx'
import { loader as organizationsLoader } from '../routes/_admin+/organizations+/index.tsx'
import {
	assignContact,
	bulkReassign,
	listAssignments,
	unassignContact,
} from './assignments.server.ts'

async function person(name: string, admin = true) {
	const id = randomUUID()
	const [user] = await db
		.insert(User)
		.values({ username: id, email: `${id}@example.com`, name })
		.returning()
	if (admin) {
		await db
			.insert(Role)
			.values({ name: 'admin', description: 'admin role' })
			.onConflictDoNothing()
		const role = await db.query.Role.findFirst({
			where: eq(Role.name, 'admin'),
		})
		await db.insert(_RoleToUser).values({ A: role!.id, B: user!.id })
	}
	return user!
}

async function cookieFor(userId: string) {
	const [session] = await db
		.insert(Session)
		.values({ userId, expirationDate: getSessionExpirationDate() })
		.returning()
	const authSession = await authSessionStorage.getSession()
	authSession.set(sessionKey, session!.id)
	return authSessionStorage.commitSession(authSession)
}

async function restaurant(name = 'Luigi') {
	const id = randomUUID()
	const [organization] = await db
		.insert(Organization)
		.values({ name: `${name} ${id.slice(0, 6)}`, slug: `org-${id}` })
		.returning()
	return organization!
}

let log: MockInstance<typeof auditService.log>
beforeEach(() => {
	vi.restoreAllMocks()
	log = vi.spyOn(auditService, 'log').mockResolvedValue(undefined)
})

describe('Menuza contacts (#272)', () => {
	it('assigns, reassigns and keeps the history, one person per role and scope', async () => {
		const boss = await person('Bea Boss')
		const sara = await person('Sara Support')
		const tom = await person('Tom Team')
		const organization = await restaurant()

		expect(
			await assignContact({
				organizationId: organization.id,
				adminUserId: sara.id,
				role: 'support',
				locationId: null,
				byAgentId: boss.id,
			}),
		).toEqual({ status: 'assigned', replaced: false })
		// The same person again is a no-op.
		expect(
			await assignContact({
				organizationId: organization.id,
				adminUserId: sara.id,
				role: 'support',
				locationId: null,
				byAgentId: boss.id,
			}),
		).toEqual({ status: 'unchanged' })
		expect(
			await assignContact({
				organizationId: organization.id,
				adminUserId: tom.id,
				role: 'support',
				locationId: null,
				byAgentId: boss.id,
			}),
		).toEqual({ status: 'assigned', replaced: true })

		const { open, history } = await listAssignments(organization.id)
		expect(open.map((row) => row.adminName)).toEqual(['Tom Team'])
		expect(history.map((row) => row.adminName)).toEqual(['Sara Support'])
		expect(history[0]).toMatchObject({
			endedByName: 'Bea Boss',
			roleLabel: 'Support',
		})
		expect(history[0]!.endedAt).toBeInstanceOf(Date)

		// Every change is audited with the support member's name.
		expect(log).toHaveBeenCalledWith(
			expect.objectContaining({
				action: AuditAction.ORG_ASSIGNMENT_CHANGED,
				organizationId: organization.id,
				metadata: expect.objectContaining({
					agentName: 'Bea Boss',
					change: 'reassigned',
				}),
			}),
		)
		// A row is never deleted: two rows exist, one ended.
		const rows = await db
			.select()
			.from(OrganizationAssignment)
			.where(eq(OrganizationAssignment.organizationId, organization.id))
		expect(rows).toHaveLength(2)
	})

	it("assigns by location scope and only to the Admin team and the restaurant's own locations", async () => {
		const boss = await person('Bea Boss')
		const sara = await person('Sara Support')
		const outsider = await person('Out Sider', false)
		const organization = await restaurant()
		const other = await restaurant('Other')
		const [location] = await db
			.insert(OrganizationLocation)
			.values({
				organizationId: organization.id,
				name: 'Harbour',
				slug: 'harbour',
			})
			.returning()
		const [foreign] = await db
			.insert(OrganizationLocation)
			.values({
				organizationId: other.id,
				name: 'Elsewhere',
				slug: 'elsewhere',
			})
			.returning()

		expect(
			await assignContact({
				organizationId: organization.id,
				adminUserId: sara.id,
				role: 'support',
				locationId: location!.id,
				byAgentId: boss.id,
			}),
		).toEqual({ status: 'assigned', replaced: false })
		// All locations and one location are separate scopes.
		expect(
			await assignContact({
				organizationId: organization.id,
				adminUserId: boss.id,
				role: 'support',
				locationId: null,
				byAgentId: boss.id,
			}),
		).toEqual({ status: 'assigned', replaced: false })
		expect(
			await assignContact({
				organizationId: organization.id,
				adminUserId: outsider.id,
				role: 'support',
				locationId: null,
				byAgentId: boss.id,
			}),
		).toEqual({ status: 'not_team_member' })
		expect(
			await assignContact({
				organizationId: organization.id,
				adminUserId: sara.id,
				role: 'account_manager',
				locationId: foreign!.id,
				byAgentId: boss.id,
			}),
		).toEqual({ status: 'location_not_found' })
		expect((await listAssignments(organization.id)).open).toHaveLength(2)
	})

	it("gives no extra access: the contact's roles and memberships do not change", async () => {
		const boss = await person('Bea Boss')
		const contact = await person('Cora Contact', false)
		// A team member by role is required; make them one, then compare.
		await db
			.insert(Role)
			.values({ name: 'admin', description: 'admin role' })
			.onConflictDoNothing()
		const role = await db.query.Role.findFirst({
			where: eq(Role.name, 'admin'),
		})
		await db.insert(_RoleToUser).values({ A: role!.id, B: contact.id })
		const organization = await restaurant()
		const rolesBefore = await db
			.select()
			.from(_RoleToUser)
			.where(eq(_RoleToUser.B, contact.id))
		await assignContact({
			organizationId: organization.id,
			adminUserId: contact.id,
			role: 'account_manager',
			locationId: null,
			byAgentId: boss.id,
		})
		expect(
			await db.select().from(_RoleToUser).where(eq(_RoleToUser.B, contact.id)),
		).toEqual(rolesBefore)
		// Being assigned does not make them a member of the restaurant.
		expect(
			await db
				.select()
				.from(UserOrganization)
				.where(eq(UserOrganization.userId, contact.id)),
		).toHaveLength(0)
	})

	it('only Admin can assign: a signed-in non-admin is refused', async () => {
		const stranger = await person('Not Admin', false)
		const sara = await person('Sara Support')
		const organization = await restaurant()
		const body = new FormData()
		body.set('intent', 'assign')
		body.set('role', 'support')
		body.set('adminUserId', sara.id)
		body.set('locationId', 'all')
		let thrown: unknown
		try {
			await assignAction({
				request: new Request(
					`http://localhost:3004/organizations/${organization.id}/assignments`,
					{
						method: 'POST',
						headers: { Cookie: await cookieFor(stranger.id) },
						body,
					},
				),
				params: { organizationId: organization.id },
			} as never)
		} catch (error) {
			thrown = error
		}
		expect(thrown).toBeInstanceOf(Response)
		expect((await listAssignments(organization.id)).open).toHaveLength(0)
	})

	it('"My restaurants" shows only the signed-in Admin\'s, "Unassigned" the rest, and the stuck filter narrows by assignee', async () => {
		const sara = await person('Sara Support')
		const tom = await person('Tom Team')
		const mine = await restaurant('Mine')
		const toms = await restaurant('Toms')
		const nobodys = await restaurant('Nobodys')
		await assignContact({
			organizationId: mine.id,
			adminUserId: sara.id,
			role: 'support',
			locationId: null,
			byAgentId: sara.id,
		})
		await assignContact({
			organizationId: toms.id,
			adminUserId: tom.id,
			role: 'account_manager',
			locationId: null,
			byAgentId: sara.id,
		})

		async function names(query: string) {
			const result = (await organizationsLoader({
				request: new Request(
					`http://localhost:3004/organizations?${query}&pageSize=200`,
					{
						headers: { Cookie: await cookieFor(sara.id) },
					},
				),
			} as never)) as { organizations: Array<{ id: string }> }
			return new Set(result.organizations.map((row) => row.id))
		}

		const myList = await names('assignee=me')
		expect(myList.has(mine.id)).toBe(true)
		expect(myList.has(toms.id)).toBe(false)
		expect(myList.has(nobodys.id)).toBe(false)

		const unassigned = await names('assignee=unassigned')
		expect(unassigned.has(nobodys.id)).toBe(true)
		expect(unassigned.has(mine.id)).toBe(false)
		expect(unassigned.has(toms.id)).toBe(false)

		const tomsList = await names(`assignee=${tom.id}`)
		expect(tomsList.has(toms.id)).toBe(true)
		expect(tomsList.has(mine.id)).toBe(false)

		// Combined with the stuck-in-setup filter, both conditions apply: none of these
		// is on the launch checklist, so the narrowed list is empty.
		expect((await names('assignee=me&setup=stuck')).has(mine.id)).toBe(false)
	})

	it('reassigns everything in bulk when someone leaves, keeping history', async () => {
		const boss = await person('Bea Boss')
		const leaving = await person('Lee Leaving')
		const staying = await person('Sam Staying')
		const a = await restaurant('A')
		const b = await restaurant('B')
		await assignContact({
			organizationId: a.id,
			adminUserId: leaving.id,
			role: 'support',
			locationId: null,
			byAgentId: boss.id,
		})
		await assignContact({
			organizationId: b.id,
			adminUserId: leaving.id,
			role: 'launch_specialist',
			locationId: null,
			byAgentId: boss.id,
		})
		// Sam already holds A's support: it is only ended for Lee, never doubled.
		await db
			.insert(OrganizationAssignment)
			.values({
				organizationId: b.id,
				adminUserId: staying.id,
				role: 'launch_specialist',
				scopeKey: 'all',
			})
			.catch(() => undefined)

		const result = await bulkReassign({
			fromUserId: leaving.id,
			toUserId: staying.id,
			byAgentId: boss.id,
		})
		expect(result).toMatchObject({ status: 'ok' })
		const open = (await listAssignments(a.id)).open
		expect(open.map((row) => row.adminName)).toEqual(['Sam Staying'])
		expect(
			(await listAssignments(a.id)).history.map((row) => row.adminName),
		).toEqual(['Lee Leaving'])
		const openB = (await listAssignments(b.id)).open
		expect(openB).toHaveLength(1)
		expect(openB[0]!.adminName).toBe('Sam Staying')

		expect(
			await bulkReassign({
				fromUserId: leaving.id,
				toUserId: leaving.id,
				byAgentId: boss.id,
			}),
		).toEqual({ status: 'same_person' })
	})

	it('removes a contact and keeps the row as history', async () => {
		const boss = await person('Bea Boss')
		const sara = await person('Sara Support')
		const organization = await restaurant()
		await assignContact({
			organizationId: organization.id,
			adminUserId: sara.id,
			role: 'support',
			locationId: null,
			byAgentId: boss.id,
		})
		const [row] = (await listAssignments(organization.id)).open
		expect(
			await unassignContact({ assignmentId: row!.id, byAgentId: boss.id }),
		).toBe('ok')
		expect(
			await unassignContact({ assignmentId: row!.id, byAgentId: boss.id }),
		).toBe('not_found')
		const { open, history } = await listAssignments(organization.id)
		expect(open).toHaveLength(0)
		expect(history).toHaveLength(1)
	})
})
