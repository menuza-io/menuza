import { db, eq, OrganizationNote } from '@repo/database'
import { describe, expect, it } from 'vitest'
import {
	addOrganizationMember,
	createAuthenticatedRequest,
	createTestNote,
	createTestSession,
	createTestUser,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'
import { action } from './notes.reorder.tsx'

async function setPosition(id: string, position: number | null) {
	await db
		.update(OrganizationNote)
		.set({ position })
		.where(eq(OrganizationNote.id, id))
}

async function drag(
	orgSlug: string,
	cookie: string,
	noteId: string,
	position: number,
) {
	const form = new FormData()
	form.set('noteId', noteId)
	form.set('position', String(position))
	const request = createAuthenticatedRequest(
		`http://localhost:3000/${orgSlug}/notes/reorder`,
		{ method: 'POST', body: form },
		cookie,
	)
	return (await action({
		request,
		params: { orgSlug },
		context: {},
	} as never)) as Response
}

// What the board shows: positioned notes ascending, unpositioned last.
async function visibleOrder(ids: string[]) {
	const rows = await Promise.all(
		ids.map(async (id) => {
			const [row] = await db
				.select({
					id: OrganizationNote.id,
					position: OrganizationNote.position,
				})
				.from(OrganizationNote)
				.where(eq(OrganizationNote.id, id))
			return row!
		}),
	)
	return rows
		.sort(
			(a, b) =>
				(a.position ?? Number.POSITIVE_INFINITY) -
				(b.position ?? Number.POSITIVE_INFINITY),
		)
		.map((row) => row.id)
}

describe('notes reorder', () => {
	it('ignores hidden private notes when placing the dragged card', async () => {
		const { user: admin, organization } = await setupTestOrgWithUser('admin')
		const member = await createTestUser()
		await addOrganizationMember(member.id, organization.id, 'org_role_member')
		const { cookie } = await createTestSession(member.id)

		const hidden = await createTestNote(organization.id, admin.id, {
			isPublic: false,
		})
		const a = await createTestNote(organization.id, admin.id)
		const b = await createTestNote(organization.id, admin.id)
		const moved = await createTestNote(organization.id, member.id)
		await setPosition(hidden.id, 1)
		await setPosition(a.id, 2)
		await setPosition(b.id, 3)
		await setPosition(moved.id, 4)

		// The member sees [a, b] and drops the card at index 1: between a and b.
		const response = await drag(organization.slug, cookie, moved.id, 1)
		expect(response.status).toBe(204)
		expect(await visibleOrder([a.id, moved.id, b.id])).toEqual([
			a.id,
			moved.id,
			b.id,
		])
	})

	it('treats notes without a position as last, like the board', async () => {
		const { user: admin, organization } = await setupTestOrgWithUser('admin')
		const { cookie } = await createTestSession(admin.id)
		const a = await createTestNote(organization.id, admin.id)
		const b = await createTestNote(organization.id, admin.id)
		const unpositioned = await createTestNote(organization.id, admin.id)
		const moved = await createTestNote(organization.id, admin.id)
		await setPosition(a.id, 1)
		await setPosition(b.id, 2)
		await setPosition(unpositioned.id, null)
		await setPosition(moved.id, 3)

		// Board shows [a, b, unpositioned]; drop at index 1 means between a and b.
		await drag(organization.slug, cookie, moved.id, 1)
		expect(await visibleOrder([a.id, moved.id, b.id, unpositioned.id])).toEqual(
			[a.id, moved.id, b.id, unpositioned.id],
		)
	})
})
