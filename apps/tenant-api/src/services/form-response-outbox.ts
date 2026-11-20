import { and, asc, eq, lte } from 'drizzle-orm'
import { parseFormNotify, plainFormName } from '@repo/common/form-alerts'
import {
	formResponseOutbox,
	getTenantDb,
	websiteForms,
	type TenantDatabase,
} from '@repo/tenant-db'
import { postFormResponseEvent } from '../lib/form-notify.ts'

/**
 * Drains the queued "new response" events to the App (#142). A row is written
 * in the submission's own transaction, so a spam-blocked or invalid submission
 * never queues one, and is sent right after the commit (the notification then
 * appears within seconds). The hourly orders tick retries what the App could
 * not take. Ids and counts only.
 */

const BATCH = 50
export const FORM_OUTBOX_MAX_ATTEMPTS = 8

export function formOutboxRetryDelayMs(attempts: number): number {
	return Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 60 * 60 * 1000)
}

export type FormOutboxTotals = { sent: number; retry: number; failed: number }

export async function drainFormResponseOutbox(
	orgId: string,
	options: { now?: number; db?: TenantDatabase } = {},
): Promise<FormOutboxTotals> {
	const now = options.now ?? Date.now()
	const db = options.db ?? (await getTenantDb(orgId))
	const totals: FormOutboxTotals = { sent: 0, retry: 0, failed: 0 }
	const due = await db
		.select()
		.from(formResponseOutbox)
		.where(
			and(
				eq(formResponseOutbox.status, 'pending'),
				lte(formResponseOutbox.nextAttemptAt, new Date(now)),
			),
		)
		.orderBy(asc(formResponseOutbox.createdAt))
		.limit(BATCH)
	for (const row of due) {
		const [form] = await db
			.select({
				id: websiteForms.id,
				name: websiteForms.name,
				notify: websiteForms.notify,
				restricted: websiteForms.restricted,
			})
			.from(websiteForms)
			.where(eq(websiteForms.id, row.formId))
			.limit(1)
		if (!form) {
			// The form was deleted before the event went out: nothing to tell.
			await db
				.update(formResponseOutbox)
				.set({ status: 'sent' })
				.where(eq(formResponseOutbox.id, row.id))
			totals.sent++
			continue
		}
		const notify = parseFormNotify(form.notify)
		const outcome = await postFormResponseEvent({
			orgId,
			eventId: row.id,
			formId: form.id,
			formName: plainFormName(form.name),
			count: 1,
			at: row.createdAt.getTime(),
			notify:
				notify.mode === 'members'
					? { mode: 'members', userIds: notify.userIds }
					: { mode: 'all' },
			restricted: form.restricted,
		})
		if (outcome.status === 'delivered') {
			await db
				.update(formResponseOutbox)
				.set({ status: 'sent' })
				.where(eq(formResponseOutbox.id, row.id))
			totals.sent++
			continue
		}
		const attempts = row.attempts + 1
		if (outcome.status === 'rejected' || attempts >= FORM_OUTBOX_MAX_ATTEMPTS) {
			await db
				.update(formResponseOutbox)
				.set({ status: 'failed', attempts })
				.where(eq(formResponseOutbox.id, row.id))
			totals.failed++
		} else {
			await db
				.update(formResponseOutbox)
				.set({
					attempts,
					nextAttemptAt: new Date(now + formOutboxRetryDelayMs(attempts)),
				})
				.where(eq(formResponseOutbox.id, row.id))
			totals.retry++
		}
	}
	return totals
}
