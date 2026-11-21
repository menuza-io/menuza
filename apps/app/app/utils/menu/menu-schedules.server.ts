import { createId } from '@paralleldrive/cuid2'
import { localDateAndTimeToUtc } from '@repo/common/menu-types'
import {
	and,
	asc,
	db,
	desc,
	eq,
	lte,
	MenuSchedule,
	Organization,
	OrganizationLocation,
	OrganizationMenu,
	type MenuScheduleStatus,
} from '@repo/database'
import { ENV } from 'varlock/env'
import { z } from 'zod'
import { requireMenuWrite } from '#app/utils/menu/access.server.ts'
import { purgeOrganizationSiteCache } from '#app/utils/sites/kv-cache.server.ts'
import { createMenuSnapshot } from './snapshot.server.ts'

/**
 * Scheduled menu changeover (#149).
 *
 * Architecture decision: `apps/jobs-cron/wrangler.jsonc` already uses all 5
 * Cloudflare Workers cron trigger slots, so adding an every-5-minute cron is not
 * possible. Following the #180 `WebsitePublishWorkflow` pattern,
 * `MenuScheduleWorkflow` sleeps until `goLiveAt` (`step.sleepUntil`) and wakes
 * `POST /resources/jobs/menu-schedules` right when the changeover is due,
 * satisfying the "within 5 minutes" acceptance criterion. The existing hourly
 * `0 * * * *` cron sweep also calls `/resources/jobs/menu-schedules` as a
 * backup in case a workflow wake-up could not be started or failed.
 */

/** A Workflow sleeps up to a year; cap schedules at 90 days ahead. */
export const MENU_SCHEDULE_MAX_LEAD_MS = 90 * 24 * 60 * 60_000

export const MENU_SCHEDULE_START_PATH = '/workflows/menu-schedule/start'

export type ScheduleMenuError =
	| 'schedule_in_past'
	| 'schedule_too_far'
	| 'invalid_schedule_time'
	| 'menu_not_found'
	| 'take_off_menu_not_found'
	| 'same_menu'

export interface PendingMenuScheduleSummary {
	id: string
	menuId: string
	goLiveAt: string
	takeOffMenuId: string | null
	status: MenuScheduleStatus
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const TIME_PATTERN = /^\d{2}:\d{2}$/

/**
 * Resolves the organization's primary timezone from its default location
 * (or first location, falling back to `America/New_York`).
 */
export async function resolveOrganizationTimezone(
	organizationId: string,
): Promise<string> {
	const [location] = await db
		.select({ timezone: OrganizationLocation.timezone })
		.from(OrganizationLocation)
		.where(eq(OrganizationLocation.organizationId, organizationId))
		.orderBy(
			desc(OrganizationLocation.isDefault),
			asc(OrganizationLocation.name),
		)
		.limit(1)
	return location?.timezone || 'America/New_York'
}

/**
 * Parses `YYYY-MM-DD` + `HH:MM` in the organization/location timezone into a
 * UTC `Date` using `localDateAndTimeToUtc`.
 */
export function parseScheduleGoLiveAt(
	dateStr: string,
	timeStr: string,
	timezone: string,
): Date | null {
	const trimmedDate = dateStr.trim()
	const trimmedTime = timeStr.trim()
	if (!DATE_PATTERN.test(trimmedDate) || !TIME_PATTERN.test(trimmedTime)) {
		return null
	}
	const [hh, mm] = trimmedTime.split(':').map(Number)
	if (
		hh === undefined ||
		mm === undefined ||
		hh < 0 ||
		hh > 23 ||
		mm < 0 ||
		mm > 59
	) {
		return null
	}
	const utc = localDateAndTimeToUtc(trimmedDate, trimmedTime, timezone)
	return Number.isFinite(utc.getTime()) ? utc : null
}

/**
 * Creates or replaces the pending changeover schedule for a menu.
 *
 * - Refuses times in the past (`<= now`) with `schedule_in_past`.
 * - At most one `pending` schedule exists per menu (`MenuSchedule_pending_menu_key`):
 *   scheduling again atomically cancels any earlier pending schedule for that
 *   menu and inserts the new one in a single `db.batch`.
 * - Does not freeze menu content: at `goLiveAt`, the latest edited version of
 *   the menu goes live.
 */
export async function setMenuSchedule(input: {
	organizationId: string
	userId: string
	menuId: string
	goLiveAt: Date
	takeOffMenuId?: string | null
	now?: Date
}): Promise<
	| { ok: true; id: string; goLiveAt: Date; takeOffMenuId: string | null }
	| { ok: false; error: ScheduleMenuError }
> {
	const now = input.now ?? new Date()
	const goLiveMs = input.goLiveAt.getTime()
	if (!Number.isFinite(goLiveMs)) {
		return { ok: false, error: 'invalid_schedule_time' }
	}
	if (goLiveMs <= now.getTime()) {
		return { ok: false, error: 'schedule_in_past' }
	}
	if (goLiveMs - now.getTime() > MENU_SCHEDULE_MAX_LEAD_MS) {
		return { ok: false, error: 'schedule_too_far' }
	}

	const [targetMenu] = await db
		.select({ id: OrganizationMenu.id })
		.from(OrganizationMenu)
		.where(
			and(
				eq(OrganizationMenu.id, input.menuId),
				eq(OrganizationMenu.organizationId, input.organizationId),
			),
		)
		.limit(1)
	if (!targetMenu) {
		return { ok: false, error: 'menu_not_found' }
	}

	const takeOffMenuId = input.takeOffMenuId?.trim() || null
	if (takeOffMenuId) {
		if (takeOffMenuId === input.menuId) {
			return { ok: false, error: 'same_menu' }
		}
		const [takeOffMenu] = await db
			.select({ id: OrganizationMenu.id })
			.from(OrganizationMenu)
			.where(
				and(
					eq(OrganizationMenu.id, takeOffMenuId),
					eq(OrganizationMenu.organizationId, input.organizationId),
				),
			)
			.limit(1)
		if (!takeOffMenu) {
			return { ok: false, error: 'take_off_menu_not_found' }
		}
	}

	const id = createId()
	await db.batch([
		db
			.update(MenuSchedule)
			.set({ status: 'cancelled', updatedAt: now })
			.where(
				and(
					eq(MenuSchedule.organizationId, input.organizationId),
					eq(MenuSchedule.menuId, input.menuId),
					eq(MenuSchedule.status, 'pending'),
				),
			),
		db.insert(MenuSchedule).values({
			id,
			organizationId: input.organizationId,
			menuId: input.menuId,
			goLiveAt: input.goLiveAt,
			takeOffMenuId,
			status: 'pending',
			createdById: input.userId,
			createdAt: now,
			updatedAt: now,
		}),
	])

	return { ok: true, id, goLiveAt: input.goLiveAt, takeOffMenuId }
}

/**
 * Cancels the pending schedule for a menu (or by schedule id) within an
 * organization. Returns `true` if a pending schedule was cancelled.
 */
export async function cancelMenuSchedule(input: {
	organizationId: string
	menuId?: string
	scheduleId?: string
}): Promise<boolean> {
	if (!input.menuId && !input.scheduleId) return false
	const conditions = [
		eq(MenuSchedule.organizationId, input.organizationId),
		eq(MenuSchedule.status, 'pending'),
	]
	if (input.menuId) {
		conditions.push(eq(MenuSchedule.menuId, input.menuId))
	}
	if (input.scheduleId) {
		conditions.push(eq(MenuSchedule.id, input.scheduleId))
	}
	const cancelled = await db
		.update(MenuSchedule)
		.set({ status: 'cancelled', updatedAt: new Date() })
		.where(and(...conditions))
		.returning({ id: MenuSchedule.id })
	return cancelled.length > 0
}

/** Lists all pending menu schedules for an organization. */
export async function listPendingMenuSchedules(
	organizationId: string,
): Promise<PendingMenuScheduleSummary[]> {
	const rows = await db
		.select({
			id: MenuSchedule.id,
			menuId: MenuSchedule.menuId,
			goLiveAt: MenuSchedule.goLiveAt,
			takeOffMenuId: MenuSchedule.takeOffMenuId,
			status: MenuSchedule.status,
		})
		.from(MenuSchedule)
		.where(
			and(
				eq(MenuSchedule.organizationId, organizationId),
				eq(MenuSchedule.status, 'pending'),
			),
		)
		.orderBy(asc(MenuSchedule.goLiveAt))

	return rows.map((row) => ({
		id: row.id,
		menuId: row.menuId,
		goLiveAt: row.goLiveAt.toISOString(),
		takeOffMenuId: row.takeOffMenuId,
		status: row.status as MenuScheduleStatus,
	}))
}

/** Returns the pending schedule for a single menu, or `null`. */
export async function getPendingMenuScheduleForMenu(
	organizationId: string,
	menuId: string,
): Promise<PendingMenuScheduleSummary | null> {
	const [row] = await db
		.select({
			id: MenuSchedule.id,
			menuId: MenuSchedule.menuId,
			goLiveAt: MenuSchedule.goLiveAt,
			takeOffMenuId: MenuSchedule.takeOffMenuId,
			status: MenuSchedule.status,
		})
		.from(MenuSchedule)
		.where(
			and(
				eq(MenuSchedule.organizationId, organizationId),
				eq(MenuSchedule.menuId, menuId),
				eq(MenuSchedule.status, 'pending'),
			),
		)
		.limit(1)

	if (!row) return null
	return {
		id: row.id,
		menuId: row.menuId,
		goLiveAt: row.goLiveAt.toISOString(),
		takeOffMenuId: row.takeOffMenuId,
		status: row.status as MenuScheduleStatus,
	}
}

/** Loader helper for `menus._index.tsx`: pending schedules keyed by `menuId`. */
export async function loadMenuSchedulesByMenuId(
	organizationId: string,
): Promise<Record<string, PendingMenuScheduleSummary>> {
	const list = await listPendingMenuSchedules(organizationId)
	const map: Record<string, PendingMenuScheduleSummary> = {}
	for (const item of list) {
		map[item.menuId] = item
	}
	return map
}

/** Loader helper for `menus.$menuId.tsx`: pending schedule + timezone. */
export async function loadMenuScheduleCardData(
	organizationId: string,
	menuId: string,
) {
	const [pendingSchedule, timezone] = await Promise.all([
		getPendingMenuScheduleForMenu(organizationId, menuId),
		resolveOrganizationTimezone(organizationId),
	])
	return { pendingSchedule, timezone }
}

/**
 * Best-effort wake-up call to `jobs-cron` to start `MenuScheduleWorkflow` for
 * `goLiveAt`. If `JOBS_CRON_WORKER_URL` is unset or the request fails, the
 * hourly sweep still picks up the due schedule as a fallback.
 */
export async function wakeMenuSchedulerAt(
	scheduleId: string,
	goLiveAt: Date,
): Promise<boolean> {
	const workerUrl =
		typeof ENV.JOBS_CRON_WORKER_URL === 'string'
			? ENV.JOBS_CRON_WORKER_URL.trim()
			: ''
	if (!workerUrl) return false
	try {
		const response = await fetch(
			`${workerUrl.replace(/\/$/, '')}${MENU_SCHEDULE_START_PATH}`,
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${ENV.INTERNAL_COMMAND_TOKEN}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					scheduleId,
					runAt: goLiveAt.toISOString(),
				}),
				signal: AbortSignal.timeout(5_000),
			},
		)
		if (!response.ok) {
			console.error('Menu schedule wake-up refused', {
				scheduleId,
				status: response.status,
			})
			return false
		}
		return true
	} catch {
		console.error('Menu schedule wake-up failed', { scheduleId })
		return false
	}
}

const ScheduleMenuIntentSchema = z.discriminatedUnion('intent', [
	z.object({
		intent: z.literal('schedule-menu'),
		menuId: z.string().min(1).optional(),
		goLiveDate: z.string().min(1),
		goLiveTime: z.string().min(1),
		takeOffMenuId: z.string().optional(),
	}),
	z.object({
		intent: z.literal('cancel-menu-schedule'),
		menuId: z.string().min(1).optional(),
	}),
])

/**
 * Action helper for `menus.$menuId.tsx` and `menus._index.tsx`.
 * Enforces `update:menu:any` via `requireMenuWrite` before parsing or writing.
 */
export async function handleMenuScheduleAction(input: {
	request: Request
	organizationId: string
	menuId?: string
	formData: FormData
}): Promise<Response> {
	const userId = await requireMenuWrite(input.request, input.organizationId)

	const raw = Object.fromEntries(input.formData)
	const parsed = ScheduleMenuIntentSchema.safeParse(raw)
	if (!parsed.success) {
		return Response.json(
			{ ok: false, error: 'invalid_schedule_time' },
			{ status: 400 },
		)
	}

	const targetMenuId = parsed.data.menuId ?? input.menuId
	if (!targetMenuId) {
		return Response.json(
			{ ok: false, error: 'menu_not_found' },
			{ status: 404 },
		)
	}

	if (parsed.data.intent === 'cancel-menu-schedule') {
		const cancelled = await cancelMenuSchedule({
			organizationId: input.organizationId,
			menuId: targetMenuId,
		})
		return Response.json({ ok: true, cancelled })
	}

	const timezone = await resolveOrganizationTimezone(input.organizationId)
	const goLiveAt = parseScheduleGoLiveAt(
		parsed.data.goLiveDate,
		parsed.data.goLiveTime,
		timezone,
	)
	if (!goLiveAt) {
		return Response.json(
			{ ok: false, error: 'invalid_schedule_time' },
			{ status: 400 },
		)
	}

	const result = await setMenuSchedule({
		organizationId: input.organizationId,
		userId,
		menuId: targetMenuId,
		goLiveAt,
		takeOffMenuId: parsed.data.takeOffMenuId || null,
	})
	if (!result.ok) {
		const status = result.error === 'menu_not_found' ? 404 : 400
		return Response.json({ ok: false, error: result.error }, { status })
	}

	await wakeMenuSchedulerAt(result.id, result.goLiveAt)

	return Response.json({
		ok: true,
		schedule: {
			id: result.id,
			menuId: targetMenuId,
			goLiveAt: result.goLiveAt.toISOString(),
			takeOffMenuId: result.takeOffMenuId,
			status: 'pending' as const,
		},
	})
}

type MenuScheduleRow = typeof MenuSchedule.$inferSelect

/**
 * Atomically claims one due `pending` schedule by transitioning it to `done`.
 * Concurrent callers racing for the same schedule will get `null`, making
 * double-runs a no-op.
 */
export async function claimDueMenuSchedule(
	id: string,
	now = new Date(),
): Promise<MenuScheduleRow | null> {
	const [claimed] = await db
		.update(MenuSchedule)
		.set({ status: 'done', updatedAt: now })
		.where(
			and(
				eq(MenuSchedule.id, id),
				eq(MenuSchedule.status, 'pending'),
				lte(MenuSchedule.goLiveAt, now),
			),
		)
		.returning()
	return claimed ?? null
}

/**
 * Executes a claimed menu schedule:
 * 1. Verifies the target menu still exists in the same organization.
 * 2. Takes a `before_schedule` menu snapshot via `createMenuSnapshot`.
 * 3. Sets `menuId` to `'available'` (clearing `unavailableUntil`) and, if
 *    `takeOffMenuId` is set and belongs to the same organization, sets it to
 *    `'unavailable'` in one `db.batch`.
 * 4. Purges the organization's public site KV cache.
 */
export async function runClaimedMenuSchedule(
	schedule: MenuScheduleRow,
	now = new Date(),
): Promise<'applied' | 'skipped'> {
	const [targetMenu] = await db
		.select({ id: OrganizationMenu.id })
		.from(OrganizationMenu)
		.where(
			and(
				eq(OrganizationMenu.id, schedule.menuId),
				eq(OrganizationMenu.organizationId, schedule.organizationId),
			),
		)
		.limit(1)

	if (!targetMenu) {
		return 'skipped'
	}

	let validTakeOffMenuId: string | null = null
	if (schedule.takeOffMenuId && schedule.takeOffMenuId !== schedule.menuId) {
		const [takeOffMenu] = await db
			.select({ id: OrganizationMenu.id })
			.from(OrganizationMenu)
			.where(
				and(
					eq(OrganizationMenu.id, schedule.takeOffMenuId),
					eq(OrganizationMenu.organizationId, schedule.organizationId),
				),
			)
			.limit(1)
		if (takeOffMenu) {
			validTakeOffMenuId = takeOffMenu.id
		}
	}

	await createMenuSnapshot({
		organizationId: schedule.organizationId,
		reason: 'before_schedule',
		userId: schedule.createdById,
	})

	const statements = [
		db
			.update(OrganizationMenu)
			.set({
				availabilityStatus: 'available',
				unavailableUntil: null,
				updatedAt: now,
			})
			.where(
				and(
					eq(OrganizationMenu.id, schedule.menuId),
					eq(OrganizationMenu.organizationId, schedule.organizationId),
				),
			),
	]

	if (validTakeOffMenuId) {
		statements.push(
			db
				.update(OrganizationMenu)
				.set({
					availabilityStatus: 'unavailable',
					unavailableUntil: null,
					updatedAt: now,
				})
				.where(
					and(
						eq(OrganizationMenu.id, validTakeOffMenuId),
						eq(OrganizationMenu.organizationId, schedule.organizationId),
					),
				),
		)
	}

	await db.batch(statements as unknown as Parameters<typeof db.batch>[0])

	const [org] = await db
		.select({
			slug: Organization.slug,
			customDomain: Organization.customDomain,
		})
		.from(Organization)
		.where(eq(Organization.id, schedule.organizationId))
		.limit(1)

	if (org) {
		await purgeOrganizationSiteCache(
			schedule.organizationId,
			org.slug,
			org.customDomain,
		)
	}

	return 'applied'
}

/**
 * Claims and applies every due pending menu schedule (`goLiveAt <= now`).
 * Called by `POST /resources/jobs/menu-schedules` from both
 * `MenuScheduleWorkflow` (at `goLiveAt`) and the hourly fallback sweep.
 */
export async function applyDueMenuSchedules(
	now = new Date(),
	limit = 25,
): Promise<{ applied: number; skipped: number }> {
	const due = await db
		.select({ id: MenuSchedule.id })
		.from(MenuSchedule)
		.where(
			and(eq(MenuSchedule.status, 'pending'), lte(MenuSchedule.goLiveAt, now)),
		)
		.orderBy(asc(MenuSchedule.goLiveAt))
		.limit(limit)

	let applied = 0
	let skipped = 0
	for (const { id } of due) {
		const claimed = await claimDueMenuSchedule(id, now)
		if (!claimed) continue
		const outcome = await runClaimedMenuSchedule(claimed, now)
		if (outcome === 'applied') applied++
		else skipped++
	}

	return { applied, skipped }
}
