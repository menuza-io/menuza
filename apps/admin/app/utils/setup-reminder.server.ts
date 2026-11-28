import { SetupReminder, db, desc, eq } from '@repo/database'
import { type SetupReminderHistoryRow } from './setup-reminder.ts'

/** The reminders sent to this organization, newest first (no address, no body). */
export async function listSetupReminders(
	organizationId: string,
	limit = 10,
): Promise<SetupReminderHistoryRow[]> {
	const rows = await db
		.select()
		.from(SetupReminder)
		.where(eq(SetupReminder.organizationId, organizationId))
		.orderBy(desc(SetupReminder.sentAt))
		.limit(limit)
	return rows.map((row) => ({
		id: row.id,
		kind: row.kind === 'manual' ? 'manual' : 'auto',
		day: row.day,
		stepKey: row.stepKey,
		doneCount: row.doneCount,
		totalCount: row.totalCount,
		recipientCount: row.recipientCount,
		sentAt: row.sentAt.toISOString(),
	}))
}
