import { TIMESHEET_BATCH_MAX } from '@repo/staffing'
import { type StaffClient } from './staff-client.ts'
import {
	batchResultSchema,
	type BatchResult,
	writeResultSchema,
	type WriteResult,
} from './timesheet-types.ts'
import { type BatchOp, chunk } from './timesheet-view.ts'

/**
 * The timesheet writes, one function each, over the browser-direct client.
 * Every response is parsed, so a node that answers something unexpected fails
 * loudly here instead of half-updating a screen.
 */

const base = '/timesheets'

export async function createCard(
	client: StaffClient,
	body: Record<string, unknown>,
): Promise<WriteResult> {
	return writeResultSchema.parse(
		await client.request(`${base}/entries`, { method: 'POST', json: body }),
	)
}

export async function updateCard(
	client: StaffClient,
	id: string,
	body: Record<string, unknown>,
): Promise<WriteResult> {
	return writeResultSchema.parse(
		await client.request(`${base}/entries/${encodeURIComponent(id)}`, {
			method: 'PATCH',
			json: body,
		}),
	)
}

/** The reason travels in the body: a delete without one is refused. */
export async function voidCard(
	client: StaffClient,
	id: string,
	input: { expectedVersion: number; reason: string },
): Promise<WriteResult> {
	return writeResultSchema.parse(
		await client.request(`${base}/entries/${encodeURIComponent(id)}`, {
			method: 'DELETE',
			json: input,
		}),
	)
}

export async function reviewCard(
	client: StaffClient,
	id: string,
	input: { expectedVersion: number; note?: string },
): Promise<WriteResult> {
	return writeResultSchema.parse(
		await client.request(`${base}/entries/${encodeURIComponent(id)}/review`, {
			method: 'POST',
			json: input,
		}),
	)
}

/**
 * Approve, lock, unlock or reopen cards. The API takes at most 200 at a time,
 * so a long list goes in several requests; each card still gets its own result,
 * and a stale version or a card that needs fixing is skipped without stopping
 * the rest. Unlock and reopen carry the reason; approve and lock may carry a note.
 */
export async function runBatchOp(
	client: StaffClient,
	op: BatchOp,
	entries: ReadonlyArray<{ id: string; version: number }>,
	text?: string,
): Promise<BatchResult> {
	const merged: BatchResult = { results: [], changed: 0, skipped: 0 }
	for (const part of chunk(entries, TIMESHEET_BATCH_MAX)) {
		const needsReason = op === 'unlock' || op === 'reopen'
		const json = {
			entries: part,
			...(text ? (needsReason ? { reason: text } : { note: text }) : {}),
		}
		const result = batchResultSchema.parse(
			await client.request(`${base}/${op}`, { method: 'POST', json }),
		)
		merged.results.push(...result.results)
		merged.changed += result.changed
		merged.skipped += result.skipped
	}
	return merged
}
