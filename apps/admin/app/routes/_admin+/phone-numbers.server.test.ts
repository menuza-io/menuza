import { randomUUID } from 'node:crypto'
import { AuditAction, auditService } from '@repo/audit'
import {
	authSessionStorage,
	getSessionExpirationDate,
	sessionKey,
} from '@repo/auth'
import {
	db,
	eq,
	Organization,
	PhoneAgentNumber,
	PlatformPhoneNumber,
	Role,
	Session,
	User,
	_RoleToUser,
} from '@repo/database'
import { RouterContextProvider } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import {
	action,
	getReassignmentHold,
	NUMBER_QUARANTINE_MS,
} from './phone-numbers.server.ts'

const DAY_MS = 24 * 60 * 60 * 1000

async function createOrganization() {
	const id = randomUUID()
	const [organization] = await db
		.insert(Organization)
		.values({ name: `Business ${id.slice(0, 6)}`, slug: `org-${id}` })
		.returning()
	return organization!
}

async function setup() {
	const id = randomUUID()
	const [user] = await db
		.insert(User)
		.values({ username: id, email: `${id}@example.com` })
		.returning()
	await db
		.insert(Role)
		.values({ name: 'admin', description: 'admin role' })
		.onConflictDoNothing()
	const role = await db.query.Role.findFirst({ where: eq(Role.name, 'admin') })
	await db.insert(_RoleToUser).values({ A: role!.id, B: user!.id })
	const [session] = await db
		.insert(Session)
		.values({ userId: user!.id, expirationDate: getSessionExpirationDate() })
		.returning()
	const authSession = await authSessionStorage.getSession()
	authSession.set(sessionKey, session!.id)
	const cookie = await authSessionStorage.commitSession(authSession)

	const previous = await createOrganization()
	const next = await createOrganization()
	// Scopes are opaque to the core, so any id will do.
	const scopeId = `scope_${id.slice(0, 8)}`
	const [number] = await db
		.insert(PlatformPhoneNumber)
		.values({
			e164: `+1415${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`,
			assignedOrganizationId: previous.id,
			assignedAt: new Date(),
		})
		.returning()

	async function post(body: Record<string, string>) {
		const url = 'http://localhost:3004/phone-numbers'
		return action({
			request: new Request(url, {
				method: 'POST',
				headers: { Cookie: cookie },
				body: new URLSearchParams(body),
			}),
			params: {},
			context: new RouterContextProvider(),
			url: new URL(url),
			pattern: '/phone-numbers',
		} as unknown as Parameters<typeof action>[0])
	}

	async function readNumber() {
		const [row] = await db
			.select()
			.from(PlatformPhoneNumber)
			.where(eq(PlatformPhoneNumber.id, number!.id))
		return row!
	}

	return {
		user: user!,
		previous,
		next,
		scopeId,
		number: number!,
		post,
		readNumber,
	}
}

describe('getReassignmentHold', () => {
	const now = new Date('2026-03-01T12:00:00Z')
	const released = {
		assignedOrganizationId: null,
		assignedAt: null,
		releasedAt: new Date(now.getTime() - 5 * DAY_MS),
		releasedFromOrganizationId: 'org_a',
		releasedWithVerifiedForwarding: true,
	}

	it('holds a recently released number for other organizations', () => {
		expect(getReassignmentHold(released, 'org_b', now)).toEqual({
			releasedAt: released.releasedAt,
			previousOrganizationId: 'org_a',
			hadVerifiedForwarding: true,
			until: new Date(released.releasedAt.getTime() + NUMBER_QUARANTINE_MS),
		})
	})

	it('lets the organization that released it take it back', () => {
		expect(getReassignmentHold(released, 'org_a', now)).toBeNull()
	})

	it('lifts the hold after 30 days', () => {
		const later = new Date(released.releasedAt.getTime() + 30 * DAY_MS)
		expect(getReassignmentHold(released, 'org_b', later)).toBeNull()
	})

	it('never holds a number that was not released', () => {
		expect(
			getReassignmentHold(
				{ ...released, releasedAt: null, releasedFromOrganizationId: null },
				'org_b',
				now,
			),
		).toBeNull()
	})

	it('holds a number orphaned by a deleted organization indefinitely', () => {
		expect(
			getReassignmentHold(
				{
					...released,
					assignedAt: new Date('2025-01-01T00:00:00Z'),
					releasedAt: null,
					releasedFromOrganizationId: null,
				},
				'org_b',
				now,
			),
		).toMatchObject({ until: null, previousOrganizationId: null })
	})
})

describe('platform phone number reassignment', () => {
	it('records the release and the verified forwarding on unassign', async () => {
		const { previous, scopeId, number, post, readNumber } = await setup()
		vi.spyOn(auditService, 'log').mockResolvedValue(undefined)
		await db.insert(PhoneAgentNumber).values({
			organizationId: previous.id,
			scopeId,
			platformNumberId: number.id,
			e164: number.e164,
			mode: 'forwarding',
			forwardedFrom: '+14155550199',
			isActive: true,
			verifiedAt: new Date(),
		})

		expect(await post({ _action: 'unassign', id: number.id })).toEqual({
			ok: true,
		})
		const row = await readNumber()
		expect(row).toMatchObject({
			assignedOrganizationId: null,
			assignedAt: null,
			releasedFromOrganizationId: previous.id,
			releasedWithVerifiedForwarding: true,
		})
		expect(row.releasedAt).toBeInstanceOf(Date)
		const connections = await db
			.select()
			.from(PhoneAgentNumber)
			.where(eq(PhoneAgentNumber.platformNumberId, number.id))
		expect(connections).toEqual([])
	})

	it('blocks giving a recently released number to another organization', async () => {
		const { previous, next, number, post, readNumber } = await setup()
		vi.spyOn(auditService, 'log').mockResolvedValue(undefined)
		await post({ _action: 'unassign', id: number.id })

		const result = await post({
			_action: 'assign',
			id: number.id,
			organization: next.slug,
		})
		expect(result).toMatchObject({
			ok: false,
			quarantine: {
				hadVerifiedForwarding: false,
				previousOrganization: { name: previous.name, slug: previous.slug },
			},
		})
		expect((await readNumber()).assignedOrganizationId).toBeNull()
	})

	it('lets the same organization take the number straight back', async () => {
		const { previous, number, post, readNumber } = await setup()
		const audit = vi.spyOn(auditService, 'log').mockResolvedValue(undefined)
		await post({ _action: 'unassign', id: number.id })

		expect(
			await post({
				_action: 'assign',
				id: number.id,
				organization: previous.slug,
			}),
		).toEqual({ ok: true })
		const row = await readNumber()
		expect(row.assignedOrganizationId).toBe(previous.id)
		expect(row.releasedAt).toBeNull()
		expect(audit).toHaveBeenLastCalledWith(
			expect.objectContaining({
				action: AuditAction.ADMIN_PHONE_NUMBER_ASSIGNED,
			}),
		)
	})

	it('reassigns on explicit confirmation and audits it', async () => {
		const { user, previous, next, number, post, readNumber } = await setup()
		const audit = vi.spyOn(auditService, 'log').mockResolvedValue(undefined)
		await post({ _action: 'unassign', id: number.id })

		expect(
			await post({
				_action: 'assign',
				id: number.id,
				organization: next.id,
				confirmReassign: 'on',
			}),
		).toEqual({ ok: true })
		const row = await readNumber()
		expect(row.assignedOrganizationId).toBe(next.id)
		expect(row.releasedFromOrganizationId).toBeNull()
		expect(audit).toHaveBeenLastCalledWith(
			expect.objectContaining({
				action: AuditAction.ADMIN_PHONE_NUMBER_FORCE_REASSIGNED,
				userId: user.id,
				organizationId: next.id,
				metadata: expect.objectContaining({
					previousOrganizationId: previous.id,
					hadVerifiedForwarding: false,
				}),
			}),
		)
		const lastCall = audit.mock.lastCall?.[0]
		expect(JSON.stringify(lastCall?.metadata)).not.toContain(
			number.e164.slice(1),
		)
	})

	it('assigns freely once the hold has passed', async () => {
		const { next, number, post, readNumber } = await setup()
		vi.spyOn(auditService, 'log').mockResolvedValue(undefined)
		await post({ _action: 'unassign', id: number.id })
		await db
			.update(PlatformPhoneNumber)
			.set({ releasedAt: new Date(Date.now() - NUMBER_QUARANTINE_MS - 1000) })
			.where(eq(PlatformPhoneNumber.id, number.id))

		expect(
			await post({ _action: 'assign', id: number.id, organization: next.id }),
		).toEqual({ ok: true })
		expect((await readNumber()).assignedOrganizationId).toBe(next.id)
	})
})
