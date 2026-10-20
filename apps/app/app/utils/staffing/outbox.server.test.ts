import { faker } from '@faker-js/faker'
import { db, eq, Organization, sql, StaffingOutbox } from '@repo/database'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestOrganization, createTestUser } from '#tests/test-utils.ts'
import {
	cancelPendingStaffingOutbox,
	drainStaffingOutbox,
	enqueueStaffingOutbox,
	flushStaffingOutboxFor,
	OUTBOX_BACKOFF_MAX_MS,
	OUTBOX_DONE_RETENTION_MS,
	OUTBOX_FAILED_RETENTION_MS,
	OUTBOX_MAX_ATTEMPTS,
	outboxBackoffMs,
} from './outbox.server.ts'

const regional = vi.hoisted(() => ({ post: vi.fn() }))
vi.mock('./regional-internal.server.ts', () => ({
	postRegionalStaffInternal: regional.post,
}))

type Sent = { dataRegion: string; path: string; body: Record<string, unknown> }

function reply(status: number, body: unknown = {}) {
	return new Response(JSON.stringify(body), { status })
}

async function provisionedOrg(
	options: { dataRegion?: 'us' | 'ksa'; hasProvisionedDb?: boolean } = {},
) {
	const user = await createTestUser()
	const organization = await createTestOrganization(user.id)
	await db
		.update(Organization)
		.set({
			hasProvisionedDb: options.hasProvisionedDb ?? true,
			dataRegion: options.dataRegion ?? 'us',
		})
		.where(eq(Organization.id, organization.id))
	return organization.id
}

function userId() {
	return `user_${faker.string.alphanumeric(12)}`
}

async function rowsFor(organizationId: string) {
	return db
		.select()
		.from(StaffingOutbox)
		.where(eq(StaffingOutbox.organizationId, organizationId))
		.orderBy(sql`rowid`)
}

let sent: Sent[]
const NOW = new Date('2026-10-11T12:00:00Z')

beforeEach(() => {
	sent = []
	regional.post.mockReset().mockImplementation(async (args: Sent) => {
		sent.push(args)
		return reply(200, { ok: true })
	})
})

afterEach(() => {
	vi.restoreAllMocks()
})

describe('outboxBackoffMs', () => {
	it('doubles from one minute and caps at a day', () => {
		expect(outboxBackoffMs(1)).toBe(60_000)
		expect(outboxBackoffMs(2)).toBe(120_000)
		expect(outboxBackoffMs(3)).toBe(240_000)
		expect(outboxBackoffMs(30)).toBe(OUTBOX_BACKOFF_MAX_MS)
		expect(outboxBackoffMs(0)).toBe(60_000)
	})
})

describe('enqueueStaffingOutbox', () => {
	it('stores ids only', async () => {
		const orgId = await provisionedOrg()
		const user = userId()
		const id = await enqueueStaffingOutbox({
			organizationId: orgId,
			kind: 'link_user',
			payload: { staffMemberId: 'staff_1', userId: user },
		})
		expect(id).toBeTruthy()
		const [row] = await rowsFor(orgId)
		expect(row).toMatchObject({
			kind: 'link_user',
			status: 'pending',
			attempts: 0,
			payload: { staffMemberId: 'staff_1', userId: user },
		})
	})

	it('rejects extra fields, non-id values and unknown kinds', async () => {
		const orgId = await provisionedOrg()
		await expect(
			enqueueStaffingOutbox({
				organizationId: orgId,
				kind: 'link_user',
				payload: {
					staffMemberId: 's1',
					userId: 'u1',
					email: 'rana@example.com',
				},
			}),
		).rejects.toThrow()
		await expect(
			enqueueStaffingOutbox({
				organizationId: orgId,
				kind: 'erase_user',
				payload: { userId: 'rana@example.com' },
			}),
		).rejects.toThrow()
		await expect(
			enqueueStaffingOutbox({
				organizationId: orgId,
				kind: 'terminate' as never,
				payload: { userId: 'u1' },
			}),
		).rejects.toThrow()
		expect(await rowsFor(orgId)).toHaveLength(0)
	})

	it('writes nothing for an organization without a regional database', async () => {
		const orgId = await provisionedOrg({ hasProvisionedDb: false })
		expect(
			await enqueueStaffingOutbox({
				organizationId: orgId,
				kind: 'unlink_user',
				payload: { userId: 'u1' },
			}),
		).toBeNull()
		expect(await rowsFor(orgId)).toHaveLength(0)
	})
})

describe('drainStaffingOutbox', () => {
	it('delivers each kind to its path with ids only, in the organization’s region', async () => {
		const usOrg = await provisionedOrg()
		const ksaOrg = await provisionedOrg({ dataRegion: 'ksa' })
		const user = userId()
		await enqueueStaffingOutbox({
			organizationId: usOrg,
			kind: 'link_user',
			payload: { staffMemberId: 'staff_1', userId: user },
		})
		await enqueueStaffingOutbox({
			organizationId: ksaOrg,
			kind: 'unlink_user',
			payload: { userId: user },
		})
		await enqueueStaffingOutbox({
			organizationId: ksaOrg,
			kind: 'erase_user',
			payload: { userId: user },
		})

		const result = await drainStaffingOutbox({
			organizationId: undefined,
			now: new Date(Date.now() + 1000),
		})
		expect(result.done).toBeGreaterThanOrEqual(3)
		const mine = sent.filter(
			(call) => call.body.orgId === usOrg || call.body.orgId === ksaOrg,
		)
		expect(mine).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					dataRegion: 'us',
					path: 'link-user',
					body: { orgId: usOrg, staffMemberId: 'staff_1', userId: user },
				}),
				expect.objectContaining({
					dataRegion: 'ksa',
					path: 'unlink-user',
					body: { orgId: ksaOrg, userId: user },
				}),
				expect.objectContaining({
					dataRegion: 'ksa',
					path: 'erase-user',
					body: { orgId: ksaOrg, userId: user },
				}),
			]),
		)
		for (const call of mine) {
			expect(Object.keys(call.body).sort()).not.toContain('email')
		}
		for (const row of [...(await rowsFor(usOrg)), ...(await rowsFor(ksaOrg))]) {
			expect(row.status).toBe('done')
			expect(row.attempts).toBe(1)
			expect(row.lastError).toBeNull()
		}
	})

	it('retries a failing node with exponential backoff, then delivers', async () => {
		const orgId = await provisionedOrg()
		const user = userId()
		await enqueueStaffingOutbox({
			organizationId: orgId,
			kind: 'unlink_user',
			payload: { userId: user },
		})
		regional.post.mockResolvedValue(
			reply(503, { error: 'down', detail: 'Rana' }),
		)

		const t0 = new Date(Date.now() + 1000)
		await drainStaffingOutbox({ organizationId: orgId, now: t0 })
		let [row] = await rowsFor(orgId)
		expect(row).toMatchObject({
			status: 'pending',
			attempts: 1,
			lastError: 'down',
		})
		expect(row!.nextAttemptAt.getTime()).toBe(t0.getTime() + 60_000)

		// Not due yet: nothing is sent.
		regional.post.mockClear()
		const early = await drainStaffingOutbox({
			organizationId: orgId,
			now: new Date(t0.getTime() + 30_000),
		})
		expect(early.attempted).toBe(0)
		expect(regional.post).not.toHaveBeenCalled()

		const t1 = new Date(t0.getTime() + 61_000)
		await drainStaffingOutbox({ organizationId: orgId, now: t1 })
		;[row] = await rowsFor(orgId)
		expect(row).toMatchObject({ status: 'pending', attempts: 2 })
		expect(row!.nextAttemptAt.getTime()).toBe(t1.getTime() + 120_000)

		regional.post.mockResolvedValue(reply(200))
		await drainStaffingOutbox({
			organizationId: orgId,
			now: new Date(t1.getTime() + 121_000),
		})
		;[row] = await rowsFor(orgId)
		expect(row).toMatchObject({ status: 'done', attempts: 3, lastError: null })
	})

	it('never stores a response body, only a short code', async () => {
		const orgId = await provisionedOrg()
		await enqueueStaffingOutbox({
			organizationId: orgId,
			kind: 'erase_user',
			payload: { userId: userId() },
		})
		regional.post.mockResolvedValue(
			reply(500, { error: 'Failed for rana@example.com +14155550123' }),
		)
		await drainStaffingOutbox({
			organizationId: orgId,
			now: new Date(Date.now() + 1000),
		})
		const [row] = await rowsFor(orgId)
		expect(row!.lastError).toMatch(/^[a-z0-9_.:-]+$/)
		expect(row!.lastError).not.toContain('@')
		expect(row!.lastError).not.toContain('+1415')
	})

	it('treats a network failure as retryable', async () => {
		const orgId = await provisionedOrg()
		await enqueueStaffingOutbox({
			organizationId: orgId,
			kind: 'unlink_user',
			payload: { userId: userId() },
		})
		regional.post.mockRejectedValue(
			Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:3007'), {
				name: 'TypeError',
			}),
		)
		await drainStaffingOutbox({
			organizationId: orgId,
			now: new Date(Date.now() + 1000),
		})
		const [row] = await rowsFor(orgId)
		expect(row).toMatchObject({ status: 'pending', attempts: 1 })
		expect(row!.lastError).toBe('network:typeerror')
	})

	it.each([404, 409, 400, 403])(
		'gives up at once on a %s, which retrying cannot fix',
		async (status) => {
			const orgId = await provisionedOrg()
			await enqueueStaffingOutbox({
				organizationId: orgId,
				kind: 'link_user',
				payload: { staffMemberId: 's1', userId: userId() },
			})
			regional.post.mockResolvedValue(
				reply(status, { error: 'staff_not_found' }),
			)
			const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
			const result = await drainStaffingOutbox({
				organizationId: orgId,
				now: new Date(Date.now() + 1000),
			})
			expect(result.failed).toBe(1)
			const [row] = await rowsFor(orgId)
			expect(row).toMatchObject({
				status: 'failed',
				attempts: 1,
				lastError: 'staff_not_found',
			})
			expect(errorSpy).toHaveBeenCalled()
		},
	)

	it('marks a row failed after the last allowed attempt', async () => {
		const orgId = await provisionedOrg()
		await enqueueStaffingOutbox({
			organizationId: orgId,
			kind: 'erase_user',
			payload: { userId: userId() },
		})
		await db
			.update(StaffingOutbox)
			.set({ attempts: OUTBOX_MAX_ATTEMPTS - 1 })
			.where(eq(StaffingOutbox.organizationId, orgId))
		regional.post.mockResolvedValue(reply(502))
		vi.spyOn(console, 'error').mockImplementation(() => {})
		await drainStaffingOutbox({
			organizationId: orgId,
			now: new Date(Date.now() + 1000),
		})
		const [row] = await rowsFor(orgId)
		expect(row).toMatchObject({
			status: 'failed',
			attempts: OUTBOX_MAX_ATTEMPTS,
		})
	})

	it('keeps events for one login in order: an erase waits behind a failing unlink', async () => {
		const orgId = await provisionedOrg()
		const user = userId()
		const other = userId()
		await enqueueStaffingOutbox({
			organizationId: orgId,
			kind: 'unlink_user',
			payload: { userId: user },
		})
		await enqueueStaffingOutbox({
			organizationId: orgId,
			kind: 'erase_user',
			payload: { userId: user },
		})
		await enqueueStaffingOutbox({
			organizationId: orgId,
			kind: 'unlink_user',
			payload: { userId: other },
		})
		regional.post.mockImplementation(async (args: Sent) => {
			sent.push(args)
			return args.path === 'unlink-user' && args.body.userId === user
				? reply(503)
				: reply(200)
		})
		const result = await drainStaffingOutbox({
			organizationId: orgId,
			now: new Date(Date.now() + 1000),
		})
		// The other login is not held up; the erase is not even attempted.
		expect(sent.map((call) => `${call.path}:${call.body.userId}`)).toEqual([
			`unlink-user:${user}`,
			`unlink-user:${other}`,
		])
		expect(result).toMatchObject({ done: 1, retried: 1, waiting: 1 })
		const rows = await rowsFor(orgId)
		expect(rows.map((row) => row.status)).toEqual([
			'pending',
			'pending',
			'done',
		])
	})

	it('delivers a login’s queued events back to back when none fail', async () => {
		const orgId = await provisionedOrg()
		const user = userId()
		for (const kind of ['unlink_user', 'erase_user'] as const) {
			await enqueueStaffingOutbox({
				organizationId: orgId,
				kind,
				payload: { userId: user },
			})
		}
		await drainStaffingOutbox({
			organizationId: orgId,
			now: new Date(Date.now() + 1000),
		})
		expect(sent.map((call) => call.path)).toEqual(['unlink-user', 'erase-user'])
	})

	it('does not deliver the same row twice when drains overlap', async () => {
		const orgId = await provisionedOrg()
		await enqueueStaffingOutbox({
			organizationId: orgId,
			kind: 'unlink_user',
			payload: { userId: userId() },
		})
		const now = new Date(Date.now() + 1000)
		await Promise.all([
			drainStaffingOutbox({ organizationId: orgId, now }),
			drainStaffingOutbox({ organizationId: orgId, now }),
		])
		expect(sent.filter((call) => call.body.orgId === orgId)).toHaveLength(1)
	})

	it('sends to the region the organization is in now', async () => {
		const orgId = await provisionedOrg({ dataRegion: 'us' })
		await enqueueStaffingOutbox({
			organizationId: orgId,
			kind: 'unlink_user',
			payload: { userId: userId() },
		})
		await db
			.update(Organization)
			.set({ dataRegion: 'ksa' })
			.where(eq(Organization.id, orgId))
		await drainStaffingOutbox({
			organizationId: orgId,
			now: new Date(Date.now() + 1000),
		})
		expect(sent.find((call) => call.body.orgId === orgId)?.dataRegion).toBe(
			'ksa',
		)
	})

	it('fails rows with an unreadable payload instead of sending them', async () => {
		const orgId = await provisionedOrg()
		await db.insert(StaffingOutbox).values({
			organizationId: orgId,
			kind: 'link_user',
			payload: { staffMemberId: 's1', userId: 'u1', email: 'rana@example.com' },
		})
		vi.spyOn(console, 'error').mockImplementation(() => {})
		await drainStaffingOutbox({
			organizationId: orgId,
			now: new Date(Date.now() + 1000),
		})
		expect(regional.post).not.toHaveBeenCalled()
		const [row] = await rowsFor(orgId)
		expect(row).toMatchObject({
			status: 'failed',
			lastError: 'invalid_payload',
		})
	})

	it('purges old finished rows but keeps recent ones', async () => {
		const orgId = await provisionedOrg()
		const old = new Date(NOW.getTime() - OUTBOX_DONE_RETENTION_MS - 1000)
		const oldFailed = new Date(
			NOW.getTime() - OUTBOX_FAILED_RETENTION_MS - 1000,
		)
		const recent = new Date(NOW.getTime() - 1000)
		const insert = async (status: string, updatedAt: Date) => {
			const [row] = await db
				.insert(StaffingOutbox)
				.values({
					organizationId: orgId,
					kind: 'unlink_user',
					payload: { userId: 'u1' },
					status,
					updatedAt,
					nextAttemptAt: updatedAt,
				})
				.returning({ id: StaffingOutbox.id })
			// `updatedAt` is rewritten on update, so set it directly through insert.
			return row!.id
		}
		const oldDone = await insert('done', old)
		const recentDone = await insert('done', recent)
		const oldFail = await insert('failed', oldFailed)
		const recentFail = await insert('failed', old)
		const result = await drainStaffingOutbox({
			organizationId: orgId,
			now: NOW,
			purge: true,
		})
		expect(result.purged).toBeGreaterThanOrEqual(2)
		const ids = (await rowsFor(orgId)).map((row) => row.id)
		expect(ids).not.toContain(oldDone)
		expect(ids).not.toContain(oldFail)
		expect(ids).toContain(recentDone)
		expect(ids).toContain(recentFail)
	})
})

describe('flushStaffingOutboxFor', () => {
	it('delivers only that login’s events and never throws', async () => {
		const orgId = await provisionedOrg()
		const mine = userId()
		const theirs = userId()
		for (const user of [mine, theirs]) {
			await enqueueStaffingOutbox({
				organizationId: orgId,
				kind: 'unlink_user',
				payload: { userId: user },
			})
		}
		await new Promise((resolve) => setTimeout(resolve, 5))
		await flushStaffingOutboxFor(orgId, mine)
		expect(sent.map((call) => call.body.userId)).toEqual([mine])

		regional.post.mockRejectedValue(new Error('boom'))
		await expect(flushStaffingOutboxFor(orgId, theirs)).resolves.toBeUndefined()
		const rows = await rowsFor(orgId)
		expect(
			rows.find((row) => (row.payload as any).userId === theirs),
		).toMatchObject({ status: 'pending', attempts: 1 })
	})
})

describe('cancelPendingStaffingOutbox', () => {
	it('fails what is pending for the organization and nothing else', async () => {
		const orgId = await provisionedOrg()
		const otherOrg = await provisionedOrg()
		for (const id of [orgId, otherOrg]) {
			await enqueueStaffingOutbox({
				organizationId: id,
				kind: 'unlink_user',
				payload: { userId: 'u1' },
			})
		}
		expect(await cancelPendingStaffingOutbox(orgId, 'region_changed')).toBe(1)
		expect((await rowsFor(orgId))[0]).toMatchObject({
			status: 'failed',
			lastError: 'region_changed',
		})
		expect((await rowsFor(otherOrg))[0]!.status).toBe('pending')
	})
})
