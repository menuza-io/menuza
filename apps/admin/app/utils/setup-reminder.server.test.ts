import { randomUUID } from 'node:crypto'
import { db, eq, Organization, SetupReminder, User } from '@repo/database'
import { afterEach, describe, expect, it } from 'vitest'
import { listSetupReminders } from './setup-reminder.server.ts'
import { setupReminderAnswerSchema } from './setup-reminder.ts'

const orgIds: string[] = []
afterEach(async () => {
	for (const id of orgIds.splice(0)) {
		await db.delete(Organization).where(eq(Organization.id, id))
	}
})

describe('setup reminder history in Admin (#271)', () => {
	it('lists every reminder sent, newest first, as ids, steps and counts only', async () => {
		const [organization] = await db
			.insert(Organization)
			.values({ name: 'Cafe', slug: `cafe-${randomUUID().slice(0, 8)}` })
			.returning()
		orgIds.push(organization!.id)
		const [admin] = await db
			.insert(User)
			.values({
				username: `admin-${randomUUID().slice(0, 8)}`,
				email: `a-${randomUUID()}@example.com`,
			})
			.returning()
		await db.insert(SetupReminder).values([
			{
				organizationId: organization!.id,
				kind: 'auto',
				day: 1,
				stepKey: 'launch_menu',
				doneCount: 1,
				totalCount: 6,
				recipientCount: 1,
				sentAt: new Date('2027-02-02T03:00:00Z'),
			},
			{
				organizationId: organization!.id,
				kind: 'manual',
				stepKey: 'launch_menu',
				doneCount: 1,
				totalCount: 6,
				recipientCount: 2,
				sentById: admin!.id,
				sentAt: new Date('2027-02-03T10:00:00Z'),
			},
		])
		const rows = await listSetupReminders(organization!.id)
		expect(rows.map((row) => [row.kind, row.day, row.recipientCount])).toEqual([
			['manual', null, 2],
			['auto', 1, 1],
		])
		expect(Object.keys(rows[0]!).sort()).toEqual([
			'day',
			'doneCount',
			'id',
			'kind',
			'recipientCount',
			'sentAt',
			'stepKey',
			'totalCount',
		])
	})
})

describe('the App answer Admin accepts', () => {
	it('accepts the known statuses and nothing else', () => {
		for (const answer of [
			{ status: 'nobody_to_notify' },
			{ status: 'sent', recipients: 2 },
			{ status: 'limit', nextAt: '2027-02-04T10:00:00.000Z' },
			{ status: 'excluded', reason: 'test' },
			{ status: 'live' },
		]) {
			expect(setupReminderAnswerSchema.safeParse(answer).success).toBe(true)
		}
		expect(
			setupReminderAnswerSchema.safeParse({ status: 'hacked' }).success,
		).toBe(false)
	})
})
