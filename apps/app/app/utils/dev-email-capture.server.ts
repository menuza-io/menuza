import { db, sql } from '@repo/database'
import { isLocalUrl } from '@repo/payments'
import {
	DEV_EMAIL_CAPTURE_CREATE_SQL,
	DEV_EMAIL_CAPTURE_TABLE,
	toCapturedEmail,
	type CapturedEmail,
	type CapturedEmailRow,
} from '#app/utils/dev-email-capture.shared.ts'

export const DEFAULT_CAPTURE_LIMIT = 100
export const MAX_CAPTURE_LIMIT = 500

/**
 * The mock email routes answer only when dev mocks are on AND the deployment
 * is local: `BASE_URL` is a loopback or `.test`/`.localhost` origin (an unset
 * one is not local) and so is the request. `MOCKS=true` alone is not enough:
 * the routes read and clear a table in the app database, and a stray flag on a
 * real deployment must not expose that.
 */
export function requireMockEmailEnabled(request?: Request) {
	if (
		process.env.MOCKS !== 'true' ||
		!isLocalUrl(process.env.BASE_URL?.trim()) ||
		(request && !isLocalUrl(request.url))
	) {
		throw new Response('Not Found', { status: 404 })
	}
}

async function ensureTable() {
	await db.run(sql.raw(DEV_EMAIL_CAPTURE_CREATE_SQL))
}

/** Newest first. `to` matches one recipient exactly, ignoring case. */
export async function listCapturedEmails(
	filters: { to?: string | null; since?: number | null; limit?: number } = {},
): Promise<CapturedEmail[]> {
	await ensureTable()
	const conditions = [sql`1 = 1`]
	const to = filters.to?.trim().toLowerCase()
	if (to) {
		conditions.push(sql`instr(',' || lower(to_addr) || ',', ${`,${to},`}) > 0`)
	}
	if (typeof filters.since === 'number') {
		conditions.push(sql`captured_at >= ${filters.since}`)
	}
	const limit = Math.min(
		Math.max(1, Math.floor(filters.limit ?? DEFAULT_CAPTURE_LIMIT)),
		MAX_CAPTURE_LIMIT,
	)
	const rows = await db.all<CapturedEmailRow>(
		sql`SELECT id, captured_at, to_addr, from_addr, subject, html, text, meta FROM ${sql.raw(DEV_EMAIL_CAPTURE_TABLE)} WHERE ${sql.join(conditions, sql` AND `)} ORDER BY captured_at DESC, rowid DESC LIMIT ${limit}`,
	)
	return rows.map(toCapturedEmail)
}

export async function resetCapturedEmails() {
	await ensureTable()
	await db.run(sql.raw(`DELETE FROM ${DEV_EMAIL_CAPTURE_TABLE}`))
}

export function escapeHtml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;')
}

/** A plain page: every value from a message is escaped and no script runs. */
export function renderMailViewer(messages: readonly CapturedEmail[]): string {
	const rows = messages
		.map(
			(message) => `<tr>
<td>${escapeHtml(message.capturedAt)}</td>
<td>${escapeHtml(message.to)}</td>
<td>${escapeHtml(message.subject)}<details><summary>Text</summary><pre>${escapeHtml(message.text)}</pre></details></td>
</tr>`,
		)
		.join('\n')
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Dev email capture</title>
<style>body{font-family:system-ui,sans-serif;margin:2rem}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;padding:.5rem;text-align:left;vertical-align:top}pre{white-space:pre-wrap}</style>
</head>
<body>
<h1>Dev email capture</h1>
<p>${messages.length} message${messages.length === 1 ? '' : 's'}, newest first. JSON: <a href="/mock-email/dev/messages">/mock-email/dev/messages</a></p>
<table>
<thead><tr><th>Time</th><th>To</th><th>Subject</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
</body>
</html>`
}
