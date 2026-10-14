import { randomUUID } from 'node:crypto'
import { and, eq, isNull } from 'drizzle-orm'
import { SCHEDULE_LINK_TTL_MS, type ScheduleLinkStatus } from '@repo/staffing'
import { scheduleLinks, type ScheduleLinkRow } from '@repo/tenant-db'
import {
	deriveScheduleLinkToken,
	hashScheduleLinkToken,
} from '../lib/schedule-link.ts'
import { timingSafeEqualString } from '../lib/secrets.ts'
import { type StaffDb } from './staff-audit.ts'

/**
 * A person's schedule link: one live link per person, created the first time an
 * email needs it and reused (and extended) by every later one. Revoking keeps
 * the row as history and the next email makes a fresh link.
 */

/** Actor recorded when the roster, not a manager, ends a link. */
export const LINK_SYSTEM_ACTOR = 'system'

async function liveLink(
	db: StaffDb,
	staffId: string,
): Promise<ScheduleLinkRow | null> {
	const [row] = await db
		.select()
		.from(scheduleLinks)
		.where(
			and(eq(scheduleLinks.staffId, staffId), isNull(scheduleLinks.revokedAt)),
		)
		.limit(1)
	return row ?? null
}

/**
 * The token for this person's live link, creating or extending it. The same
 * person always gets the same token until it is revoked.
 */
export async function ensureScheduleLink(
	db: StaffDb,
	orgId: string,
	staffId: string,
	now: number,
): Promise<{ token: string; expiresAt: number }> {
	const wanted = now + SCHEDULE_LINK_TTL_MS
	for (let attempt = 0; attempt < 3; attempt++) {
		const existing = await liveLink(db, staffId)
		if (existing) {
			if (existing.expiresAt < wanted) {
				await db
					.update(scheduleLinks)
					.set({ expiresAt: wanted })
					.where(eq(scheduleLinks.id, existing.id))
			}
			return {
				token: deriveScheduleLinkToken(orgId, existing.id, staffId),
				expiresAt: Math.max(existing.expiresAt, wanted),
			}
		}
		const id = randomUUID()
		const token = deriveScheduleLinkToken(orgId, id, staffId)
		const inserted = await db
			.insert(scheduleLinks)
			.values({
				id,
				staffId,
				tokenHash: hashScheduleLinkToken(token),
				createdAt: now,
				expiresAt: wanted,
			})
			.onConflictDoNothing()
			.returning({ id: scheduleLinks.id })
		if (inserted.length > 0) return { token, expiresAt: wanted }
		// Another sender created it first: read theirs.
	}
	throw new Error('Could not create a schedule link')
}

/** Ends the person's live link, if any. Returns whether one was live. */
export async function revokeScheduleLink(
	db: StaffDb,
	staffId: string,
	now: number,
	by: string,
): Promise<boolean> {
	const revoked = await db
		.update(scheduleLinks)
		.set({ revokedAt: now, revokedBy: by })
		.where(
			and(eq(scheduleLinks.staffId, staffId), isNull(scheduleLinks.revokedAt)),
		)
		.returning({ id: scheduleLinks.id })
	return revoked.length > 0
}

export async function scheduleLinkStatus(
	db: StaffDb,
	staffId: string,
	now: number,
): Promise<ScheduleLinkStatus> {
	const row = await liveLink(db, staffId)
	return {
		staffId,
		active: Boolean(row && row.expiresAt > now),
		createdAt: row?.createdAt ?? null,
		lastUsedAt: row?.lastUsedAt ?? null,
		expiresAt: row?.expiresAt ?? null,
	}
}

export type LinkCheck =
	| { ok: true; link: ScheduleLinkRow }
	| { ok: false; code: 'invalid_link' | 'link_revoked' | 'link_expired' }

/**
 * Checks a presented token against the stored hash (constant time). An unknown
 * link and a wrong secret answer the same, so a link id cannot be probed.
 */
export async function checkScheduleLink(
	db: StaffDb,
	token: string,
	linkId: string,
	now: number,
): Promise<LinkCheck> {
	const [link] = await db
		.select()
		.from(scheduleLinks)
		.where(eq(scheduleLinks.id, linkId))
		.limit(1)
	// Hash even when the link is unknown so timing does not tell which ids exist.
	const presented = hashScheduleLinkToken(token)
	if (!link || !timingSafeEqualString(presented, link.tokenHash)) {
		return { ok: false, code: 'invalid_link' }
	}
	if (link.revokedAt !== null) return { ok: false, code: 'link_revoked' }
	if (link.expiresAt <= now) return { ok: false, code: 'link_expired' }
	return { ok: true, link }
}

const TOUCH_INTERVAL_MS = 5 * 60 * 1000

/** Records use, at most every few minutes (a page load makes several calls). */
export async function touchScheduleLink(
	db: StaffDb,
	link: ScheduleLinkRow,
	now: number,
) {
	if (link.lastUsedAt !== null && now - link.lastUsedAt < TOUCH_INTERVAL_MS) {
		return
	}
	await db
		.update(scheduleLinks)
		.set({ lastUsedAt: now })
		.where(eq(scheduleLinks.id, link.id))
}
