import { randomUUID } from 'node:crypto'
import {
	ConfigFlag,
	db,
	eq,
	inArray,
	Organization,
	OrganizationLocation,
} from '@repo/database'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { postToApp } from './app-service.server.ts'
import {
	loadLaunchStatus,
	stuckInSetupCondition,
} from './launch-status.server.ts'

vi.mock('./app-service.server.ts', () => ({ postToApp: vi.fn() }))

const DAY = 86_400_000
const created: string[] = []

afterEach(async () => {
	vi.mocked(postToApp).mockReset()
	if (created.length) {
		await db.delete(Organization).where(inArray(Organization.id, created))
		created.length = 0
	}
})

async function createOrganization({
	daysAgo,
	launch,
	live,
}: {
	daysAgo: number
	launch: boolean
	live: boolean
}) {
	const slug = `launch-${randomUUID().slice(0, 8)}`
	const [org] = await db
		.insert(Organization)
		.values({
			name: slug,
			slug,
			createdAt: new Date(Date.now() - daysAgo * DAY),
		})
		.returning({ id: Organization.id })
	created.push(org!.id)
	if (launch) {
		await db.insert(ConfigFlag).values({
			key: 'launch.checklist',
			value: true,
			level: 'organization',
			organizationId: org!.id,
		})
	}
	await db.insert(OrganizationLocation).values({
		organizationId: org!.id,
		name: 'Main',
		slug: 'main',
		liveAt: live ? new Date() : null,
	})
	return org!.id
}

describe('stuckInSetupCondition', () => {
	it('finds organizations on the checklist with no live location after 14 days', async () => {
		const stuck = await createOrganization({
			daysAgo: 20,
			launch: true,
			live: false,
		})
		const recent = await createOrganization({
			daysAgo: 3,
			launch: true,
			live: false,
		})
		const live = await createOrganization({
			daysAgo: 20,
			launch: true,
			live: true,
		})
		const notOnChecklist = await createOrganization({
			daysAgo: 20,
			launch: false,
			live: false,
		})
		const rows = await db
			.select({ id: Organization.id })
			.from(Organization)
			.where(await stuckInSetupCondition(new Date()))
		const ids = rows.map((row) => row.id)
		expect(ids).toContain(stuck)
		for (const id of [recent, live, notOnChecklist]) {
			expect(ids).not.toContain(id)
		}
		// The relational query the organizations list uses agrees.
		const listed = await db.query.Organization.findMany({
			where: await stuckInSetupCondition(new Date()),
			columns: { id: true },
		})
		expect(listed.map((row) => row.id)).toContain(stuck)
		expect(
			await db.select().from(Organization).where(eq(Organization.id, stuck)),
		).toHaveLength(1)
	})
})

describe('loadLaunchStatus', () => {
	it('keeps state and dates only, whatever else the answer carries', async () => {
		vi.mocked(postToApp).mockResolvedValue({
			status: 'answered',
			response: Response.json({
				enabled: true,
				createdAt: '2026-05-01T00:00:00.000Z',
				daysSinceSignup: 20,
				firstOrderAt: null,
				regionAnswered: true,
				customerName: 'Ada',
				locations: [
					{
						id: 'loc_1',
						name: 'Olaya',
						live: false,
						liveAt: null,
						requiredDone: 3,
						requiredTotal: 6,
						guestPhone: '+15550001111',
						steps: [
							{
								key: 'launch_menu',
								optional: false,
								state: 'todo',
								completedAt: null,
								skippedAt: null,
								contactEmail: 'ada@example.com',
							},
						],
					},
				],
			}),
		})
		const result = await loadLaunchStatus('org_1')
		expect(result.status).toBe('ok')
		const text = JSON.stringify(result)
		for (const pii of ['Ada', '555', 'example.com']) {
			expect(text).not.toContain(pii)
		}
		expect(postToApp).toHaveBeenCalledWith(
			'/resources/launch-status',
			{ organizationId: 'org_1' },
			expect.any(Object),
		)
	})

	it('reports an App it cannot reach as unavailable', async () => {
		vi.mocked(postToApp).mockResolvedValue({ status: 'unreachable' })
		expect(await loadLaunchStatus('org_1')).toEqual({ status: 'unavailable' })
	})
})
