import { randomUUID } from 'node:crypto'
import {
	addDays,
	currentBusinessDate,
	experienceSeatingsOn,
	scheduleSeatingMins,
	setupExperienceScheduleInputSchema,
	type SetupExperienceInput,
	type SetupExperienceScheduleInput,
	type SetupExperienceScheduleUpdate,
	type SetupExperienceUpdate,
} from '@repo/reservations'
import {
	rsvAreas,
	rsvExperienceSchedules,
	rsvExperiences,
	rsvPolicies,
	rsvServices,
	type RsvExperienceRow,
	type RsvExperienceScheduleRow,
	type TenantDatabase,
} from '@repo/tenant-db'
import { and, asc, eq, inArray, isNull, ne } from 'drizzle-orm'
import { type z } from 'zod'
import { badRequest, conflict, notFound } from '../lib/http.ts'
import { assertLocalizedMap, loadLocaleOrg } from '../lib/reservations-i18n.ts'
import {
	bumpDayVersionsInTx,
	withSetupWrite,
} from '../lib/reservations-write.ts'
import { toScheduleInput } from './rsv-experience-engine.ts'
import {
	ensureLocationSettingsRow,
	writeSetupAuditLog,
} from './rsv-setup-service.ts'
import { queryInChunks } from '../lib/chunked-in.ts'

/**
 * Operator Experiences setup (`architecture.md` 4.1, 7.2).
 *
 * Decisions kept in one place:
 * - Schedules are sub-resources (`/experiences/:id/schedules[/:scheduleId]`);
 *   the experience body never carries them, so there is one way to edit them.
 * - Currency is copied from the location settings on create and never accepted
 *   from the client.
 * - Archiving is a soft status change: bookings keep `experience_id` and the
 *   set-null foreign key never fires. `archived` is terminal.
 * - Publishing needs at least one schedule that has not wholly passed, every
 *   schedule must offer a seating, a table-less experience must be cover capped
 *   (a pool without a cap would oversell), and every referenced area, service
 *   and policy must still be active in the same location. A name in any locale
 *   is enough: public pages fall back to the first available locale.
 * - Every write runs inside `withSetupWrite`, so it serializes with that
 *   organization's reservation writes and rolls back as one unit.
 */

export type ExperienceStatus = RsvExperienceRow['status']

export type SerializedSchedule = {
	id: string
	experienceId: string
	fromDate: string
	toDate: string
	daysMask: number
	seatingMins: number[] | null
	startMin: number | null
	endMin: number | null
	intervalMin: number | null
	turnMin: number
	coversCapPerSeating: number | null
	coversCapPerDay: number | null
	areaIds: string[] | null
	serviceId: string | null
	/** The resolved start minutes, for editors and previews. */
	seatings: number[]
}

export type SerializedExperience = {
	id: string
	locationId: string
	slug: string
	kind: RsvExperienceRow['kind']
	nameI18n: Record<string, string>
	descriptionI18n: Record<string, string> | null
	imageUrl: string | null
	priceMinor: number | null
	pricePerCover: boolean
	currency: string
	policyId: string | null
	partyMin: number
	partyMax: number
	usesTables: boolean
	exclusive: boolean
	status: ExperienceStatus
	sort: number
	version: number
	schedules: SerializedSchedule[]
}

export function serializeSchedule(
	row: RsvExperienceScheduleRow,
): SerializedSchedule {
	return {
		id: row.id,
		experienceId: row.experienceId,
		fromDate: row.fromDate,
		toDate: row.toDate,
		daysMask: row.daysMask,
		seatingMins: row.seatingMins,
		startMin: row.startMin,
		endMin: row.endMin,
		intervalMin: row.intervalMin,
		turnMin: row.turnMin,
		coversCapPerSeating: row.coversCapPerSeating,
		coversCapPerDay: row.coversCapPerDay,
		areaIds: row.areaIds,
		serviceId: row.serviceId,
		seatings: scheduleSeatingMins(row),
	}
}

export function serializeExperience(
	row: RsvExperienceRow,
	schedules: readonly RsvExperienceScheduleRow[],
): SerializedExperience {
	return {
		id: row.id,
		locationId: row.locationId,
		slug: row.slug,
		kind: row.kind,
		nameI18n: row.nameI18n,
		descriptionI18n: row.descriptionI18n,
		imageUrl: row.imageUrl,
		priceMinor: row.priceMinor,
		pricePerCover: row.pricePerCover,
		currency: row.currency,
		policyId: row.policyId,
		partyMin: row.partyMin,
		partyMax: row.partyMax,
		usesTables: row.usesTables,
		exclusive: row.exclusive,
		status: row.status,
		sort: row.sort,
		version: row.version,
		schedules: schedules.map(serializeSchedule),
	}
}

type Issue = { path: string; code: string }

function invalid(issues: Issue[]) {
	return badRequest('invalid', 'invalid', { issues })
}

function issuesFromZod(error: z.ZodError): Issue[] {
	return error.issues.slice(0, 20).map((issue) => ({
		path: issue.path.join('.'),
		code: issue.code,
	}))
}

async function schedulesFor(
	db: TenantDatabase,
	experienceId: string,
): Promise<RsvExperienceScheduleRow[]> {
	return db
		.select()
		.from(rsvExperienceSchedules)
		.where(eq(rsvExperienceSchedules.experienceId, experienceId))
		.orderBy(
			asc(rsvExperienceSchedules.fromDate),
			asc(rsvExperienceSchedules.id),
		)
		.all()
}

async function loadExperienceRow(
	db: TenantDatabase,
	locationId: string,
	experienceId: string,
): Promise<RsvExperienceRow> {
	const row = await db
		.select()
		.from(rsvExperiences)
		.where(
			and(
				eq(rsvExperiences.id, experienceId),
				eq(rsvExperiences.locationId, locationId),
			),
		)
		.get()
	if (!row) throw notFound('not_found')
	return row
}

export async function listExperiences(
	db: TenantDatabase,
	locationId: string,
): Promise<SerializedExperience[]> {
	const rows = await db
		.select()
		.from(rsvExperiences)
		.where(eq(rsvExperiences.locationId, locationId))
		.orderBy(asc(rsvExperiences.sort), asc(rsvExperiences.slug))
		.all()
	const out: SerializedExperience[] = []
	for (const row of rows) {
		out.push(serializeExperience(row, await schedulesFor(db, row.id)))
	}
	return out
}

export async function getExperience(
	db: TenantDatabase,
	locationId: string,
	experienceId: string,
): Promise<SerializedExperience> {
	const row = await loadExperienceRow(db, locationId, experienceId)
	return serializeExperience(row, await schedulesFor(db, row.id))
}

async function assertSlugFree(
	tx: TenantDatabase,
	locationId: string,
	slug: string,
	exceptId?: string,
) {
	const clash = await tx
		.select({ id: rsvExperiences.id })
		.from(rsvExperiences)
		.where(
			and(
				eq(rsvExperiences.locationId, locationId),
				eq(rsvExperiences.slug, slug),
				ne(rsvExperiences.status, 'archived'),
				...(exceptId ? [ne(rsvExperiences.id, exceptId)] : []),
			),
		)
		.get()
	if (clash) throw conflict('slug_taken', 'slug_taken', { field: 'slug' })
}

/** Policy, areas and service must belong to this location and be active. */
async function assertReferences(
	tx: TenantDatabase,
	locationId: string,
	refs: {
		policyId?: string | null
		areaIds?: readonly string[] | null
		serviceId?: string | null
	},
	pathPrefix = '',
) {
	const issues: Issue[] = []
	if (refs.policyId) {
		const policy = await tx
			.select({ id: rsvPolicies.id })
			.from(rsvPolicies)
			.where(
				and(
					eq(rsvPolicies.id, refs.policyId),
					eq(rsvPolicies.locationId, locationId),
					isNull(rsvPolicies.archivedAt),
				),
			)
			.get()
		if (!policy)
			issues.push({ path: `${pathPrefix}policyId`, code: 'invalid_reference' })
	}
	if (refs.areaIds && refs.areaIds.length > 0) {
		const unique = [...new Set(refs.areaIds)]
		const found = await queryInChunks(unique, (chunk) =>
			tx
				.select({ id: rsvAreas.id })
				.from(rsvAreas)
				.where(
					and(
						eq(rsvAreas.locationId, locationId),
						isNull(rsvAreas.archivedAt),
						inArray(rsvAreas.id, chunk),
					),
				)
				.all(),
		)
		if (found.length !== unique.length) {
			issues.push({ path: `${pathPrefix}areaIds`, code: 'invalid_reference' })
		}
	}
	if (refs.serviceId) {
		const service = await tx
			.select({ id: rsvServices.id })
			.from(rsvServices)
			.where(
				and(
					eq(rsvServices.id, refs.serviceId),
					eq(rsvServices.locationId, locationId),
					isNull(rsvServices.archivedAt),
				),
			)
			.get()
		if (!service) {
			issues.push({ path: `${pathPrefix}serviceId`, code: 'invalid_reference' })
		}
	}
	if (issues.length > 0) throw invalid(issues)
}

function assertVersion(
	row: RsvExperienceRow,
	schedules: readonly RsvExperienceScheduleRow[],
	expected: number | undefined,
) {
	if (expected !== undefined && expected !== row.version) {
		throw conflict('stale_version', 'stale_version', {
			version: row.version,
			current: serializeExperience(row, schedules),
		})
	}
}

/** Everything that must hold for a published experience to be offered. */
function publishIssues(
	row: Pick<RsvExperienceRow, 'usesTables'>,
	schedules: readonly RsvExperienceScheduleRow[],
	today: string,
): Issue[] {
	const issues: Issue[] = []
	if (schedules.length === 0) {
		issues.push({ path: 'schedules', code: 'schedules_required' })
		return issues
	}
	if (!schedules.some((s) => s.toDate >= today)) {
		issues.push({ path: 'schedules', code: 'schedule_in_past' })
	}
	for (const [i, s] of schedules.entries()) {
		if (scheduleSeatingMins(s).length === 0) {
			issues.push({ path: `schedules.${i}.seatings`, code: 'required' })
		}
		if (
			!row.usesTables &&
			s.coversCapPerSeating === null &&
			s.coversCapPerDay === null
		) {
			issues.push({
				path: `schedules.${i}.coversCapPerSeating`,
				code: 'cap_required',
			})
		}
	}
	return issues
}

/** Business dates inside the bookable window on which a schedule offers a seating. */
function scheduleDates(
	schedule: RsvExperienceScheduleRow,
	today: string,
	horizonDays: number,
): string[] {
	const from = schedule.fromDate > today ? schedule.fromDate : today
	const last = addDays(today, horizonDays + 1)
	const to = schedule.toDate < last ? schedule.toDate : last
	const out: string[] = []
	for (let d = from, guard = 0; d <= to && guard < 400; d = addDays(d, 1)) {
		guard++
		if (experienceSeatingsOn([toScheduleInput(schedule)], d).length > 0) {
			out.push(d)
		}
	}
	return out
}

async function settingsClock(
	tx: TenantDatabase,
	orgId: string,
	locationId: string,
	now: number,
) {
	const settings = await ensureLocationSettingsRow(tx, orgId, locationId)
	return {
		settings,
		today: currentBusinessDate(now, settings.timeZone, settings.dayStartMin),
	}
}

/**
 * Cached public availability keys off the day version, and exclusive windows
 * also change regular availability, so any change that can alter what is
 * offered bumps every affected date in the bookable window.
 */
async function bumpAffectedDates(
	tx: TenantDatabase,
	clock: Awaited<ReturnType<typeof settingsClock>>,
	locationId: string,
	scheduleSets: ReadonlyArray<readonly RsvExperienceScheduleRow[]>,
	now: number,
) {
	const dates = new Set<string>()
	for (const set of scheduleSets) {
		for (const s of set) {
			for (const d of scheduleDates(
				s,
				clock.today,
				clock.settings.horizonDays,
			)) {
				dates.add(d)
			}
		}
	}
	if (dates.size > 0) {
		await bumpDayVersionsInTx(tx, locationId, [...dates].sort(), now)
	}
}

// ---------------------------------------------------------------------------
// Experiences
// ---------------------------------------------------------------------------

export async function createExperience(
	db: TenantDatabase,
	params: {
		orgId: string
		actorId: string
		locationId: string
		input: SetupExperienceInput
		now?: number
	},
): Promise<SerializedExperience> {
	const now = params.now ?? Date.now()
	const { locationId } = params
	const localeOrg = await loadLocaleOrg(params.orgId)
	const input = {
		...params.input,
		nameI18n: assertLocalizedMap(params.input.nameI18n, localeOrg, 'nameI18n', {
			requireDefault: true,
		}),
		descriptionI18n: params.input.descriptionI18n
			? assertLocalizedMap(
					params.input.descriptionI18n,
					localeOrg,
					'descriptionI18n',
				)
			: params.input.descriptionI18n,
	}
	return withSetupWrite(
		db,
		async (tx) => {
			const { settings } = await settingsClock(
				tx,
				params.orgId,
				locationId,
				now,
			)
			await assertSlugFree(tx, locationId, input.slug)
			await assertReferences(tx, locationId, { policyId: input.policyId })
			const id = `exp_${randomUUID()}`
			await tx.insert(rsvExperiences).values({
				id,
				locationId,
				slug: input.slug,
				kind: input.kind,
				nameI18n: input.nameI18n as Record<string, string>,
				descriptionI18n: (input.descriptionI18n ?? null) as Record<
					string,
					string
				> | null,
				imageUrl: input.imageUrl ?? null,
				priceMinor: input.priceMinor ?? null,
				pricePerCover: input.pricePerCover,
				currency: settings.currency,
				policyId: input.policyId ?? null,
				partyMin: input.partyMin,
				partyMax: input.partyMax,
				usesTables: input.usesTables,
				exclusive: input.exclusive,
				status: 'draft',
				sort: input.sort,
				version: 1,
			})
			await writeSetupAuditLog(tx, {
				actorId: params.actorId,
				locationId,
				action: 'experience.create',
				entityType: 'experience',
				entityId: id,
				changes: { slug: input.slug, status: 'draft' },
			})
			return getExperience(tx, locationId, id)
		},
		params.orgId,
	)
}

const EXPERIENCE_PATCH_KEYS = [
	'slug',
	'kind',
	'nameI18n',
	'descriptionI18n',
	'imageUrl',
	'priceMinor',
	'pricePerCover',
	'policyId',
	'partyMin',
	'partyMax',
	'usesTables',
	'exclusive',
	'sort',
] as const

export async function updateExperience(
	db: TenantDatabase,
	params: {
		orgId: string
		actorId: string
		locationId: string
		experienceId: string
		patch: SetupExperienceUpdate
		now?: number
	},
): Promise<SerializedExperience> {
	const now = params.now ?? Date.now()
	const { locationId } = params
	const localeOrg = await loadLocaleOrg(params.orgId)
	const patch = {
		...params.patch,
		...(params.patch.nameI18n
			? {
					nameI18n: assertLocalizedMap(
						params.patch.nameI18n,
						localeOrg,
						'nameI18n',
						{ requireDefault: true },
					),
				}
			: {}),
		...(params.patch.descriptionI18n
			? {
					descriptionI18n: assertLocalizedMap(
						params.patch.descriptionI18n,
						localeOrg,
						'descriptionI18n',
					),
				}
			: {}),
	}
	return withSetupWrite(
		db,
		async (tx) => {
			const current = await loadExperienceRow(
				tx,
				locationId,
				params.experienceId,
			)
			const schedules = await schedulesFor(tx, current.id)
			assertVersion(current, schedules, patch.expectedVersion)
			if (current.status === 'archived') {
				throw conflict('experience_archived', 'experience_archived')
			}

			const partyMin = patch.partyMin ?? current.partyMin
			const partyMax = patch.partyMax ?? current.partyMax
			if (partyMin > partyMax) {
				throw invalid([{ path: 'partyMin', code: 'custom' }])
			}
			if (patch.slug !== undefined && patch.slug !== current.slug) {
				await assertSlugFree(tx, locationId, patch.slug, current.id)
			}
			if (patch.policyId) {
				await assertReferences(tx, locationId, { policyId: patch.policyId })
			}
			const usesTables = patch.usesTables ?? current.usesTables
			if (current.status === 'published') {
				const { today } = await settingsClock(tx, params.orgId, locationId, now)
				const issues = publishIssues({ usesTables }, schedules, today).filter(
					(i) => i.code === 'cap_required',
				)
				if (issues.length > 0) throw invalid(issues)
			}

			const set: Partial<typeof rsvExperiences.$inferInsert> = {
				version: current.version + 1,
			}
			const changed: string[] = []
			for (const key of EXPERIENCE_PATCH_KEYS) {
				if (patch[key] === undefined) continue
				;(set as Record<string, unknown>)[key] = patch[key]
				changed.push(key)
			}
			await tx
				.update(rsvExperiences)
				.set(set)
				.where(eq(rsvExperiences.id, current.id))

			if (current.status === 'published') {
				const clock = await settingsClock(tx, params.orgId, locationId, now)
				await bumpAffectedDates(tx, clock, locationId, [schedules], now)
			}
			await writeSetupAuditLog(tx, {
				actorId: params.actorId,
				locationId,
				action: 'experience.update',
				entityType: 'experience',
				entityId: current.id,
				changes: { fields: changed },
			})
			return getExperience(tx, locationId, current.id)
		},
		params.orgId,
	)
}

type TransitionParams = {
	orgId: string
	actorId: string
	locationId: string
	experienceId: string
	expectedVersion?: number
	now?: number
}

async function transition(
	db: TenantDatabase,
	params: TransitionParams,
	rule: {
		action: 'publish' | 'unpublish' | 'archive'
		from: readonly ExperienceStatus[]
		to: ExperienceStatus
		check?: (
			row: RsvExperienceRow,
			schedules: RsvExperienceScheduleRow[],
			today: string,
		) => Issue[]
	},
): Promise<SerializedExperience> {
	const now = params.now ?? Date.now()
	const { locationId } = params
	return withSetupWrite(
		db,
		async (tx) => {
			const current = await loadExperienceRow(
				tx,
				locationId,
				params.experienceId,
			)
			const schedules = await schedulesFor(tx, current.id)
			assertVersion(current, schedules, params.expectedVersion)
			if (!rule.from.includes(current.status)) {
				throw conflict(
					'invalid_status_transition',
					'invalid_status_transition',
					{
						status: current.status,
					},
				)
			}
			const clock = await settingsClock(tx, params.orgId, locationId, now)
			if (rule.check) {
				const issues = rule.check(current, schedules, clock.today)
				if (issues.length > 0) throw invalid(issues)
			}
			if (rule.action === 'publish') {
				// Slug uniqueness only binds non-archived rows, and a draft is one.
				await assertReferences(tx, locationId, {
					policyId: current.policyId,
					areaIds: schedules.flatMap((s) => s.areaIds ?? []),
				})
				for (const s of schedules) {
					await assertReferences(tx, locationId, { serviceId: s.serviceId })
				}
			}
			await tx
				.update(rsvExperiences)
				.set({ status: rule.to, version: current.version + 1 })
				.where(eq(rsvExperiences.id, current.id))
			await bumpAffectedDates(tx, clock, locationId, [schedules], now)
			await writeSetupAuditLog(tx, {
				actorId: params.actorId,
				locationId,
				action: `experience.${rule.action}`,
				entityType: 'experience',
				entityId: current.id,
				changes: { from: current.status, to: rule.to },
			})
			return getExperience(tx, locationId, current.id)
		},
		params.orgId,
	)
}

export function publishExperience(
	db: TenantDatabase,
	params: TransitionParams,
) {
	return transition(db, params, {
		action: 'publish',
		from: ['draft'],
		to: 'published',
		check: (row, schedules, today) => publishIssues(row, schedules, today),
	})
}

export function unpublishExperience(
	db: TenantDatabase,
	params: TransitionParams,
) {
	return transition(db, params, {
		action: 'unpublish',
		from: ['published'],
		to: 'draft',
	})
}

export function archiveExperience(
	db: TenantDatabase,
	params: TransitionParams,
) {
	return transition(db, params, {
		action: 'archive',
		from: ['draft', 'published'],
		to: 'archived',
	})
}

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------

type ScheduleWriteParams = {
	orgId: string
	actorId: string
	locationId: string
	experienceId: string
	now?: number
}

async function afterScheduleChange(
	tx: TenantDatabase,
	params: ScheduleWriteParams,
	current: RsvExperienceRow,
	before: readonly RsvExperienceScheduleRow[],
	after: readonly RsvExperienceScheduleRow[],
	detail: { schedule: 'create' | 'update' | 'delete'; scheduleId: string },
) {
	const now = params.now ?? Date.now()
	await tx
		.update(rsvExperiences)
		.set({ version: current.version + 1 })
		.where(eq(rsvExperiences.id, current.id))
	if (current.status === 'published') {
		const clock = await settingsClock(tx, params.orgId, params.locationId, now)
		await bumpAffectedDates(tx, clock, params.locationId, [before, after], now)
	}
	await writeSetupAuditLog(tx, {
		actorId: params.actorId,
		locationId: params.locationId,
		action: 'experience.update',
		entityType: 'experience',
		entityId: current.id,
		changes: detail,
	})
}

function scheduleValues(input: SetupExperienceScheduleInput) {
	return {
		fromDate: input.fromDate,
		toDate: input.toDate,
		daysMask: input.daysMask,
		seatingMins: input.seatingMins ?? null,
		startMin: input.startMin ?? null,
		endMin: input.endMin ?? null,
		intervalMin: input.intervalMin ?? null,
		turnMin: input.turnMin,
		coversCapPerSeating: input.coversCapPerSeating ?? null,
		coversCapPerDay: input.coversCapPerDay ?? null,
		areaIds: input.areaIds ?? null,
		serviceId: input.serviceId ?? null,
	}
}

function assertPublishedStillValid(
	current: RsvExperienceRow,
	after: readonly RsvExperienceScheduleRow[],
	today: string,
) {
	if (current.status !== 'published') return
	const issues = publishIssues(current, after, today)
	if (issues.length > 0) throw invalid(issues)
}

export async function createExperienceSchedule(
	db: TenantDatabase,
	params: ScheduleWriteParams & { input: SetupExperienceScheduleInput },
): Promise<SerializedExperience> {
	const { locationId, input } = params
	return withSetupWrite(
		db,
		async (tx) => {
			const current = await loadExperienceRow(
				tx,
				locationId,
				params.experienceId,
			)
			const before = await schedulesFor(tx, current.id)
			assertVersion(current, before, input.expectedVersion)
			if (current.status === 'archived') {
				throw conflict('experience_archived', 'experience_archived')
			}
			await assertReferences(tx, locationId, {
				areaIds: input.areaIds,
				serviceId: input.serviceId,
			})
			if (current.status === 'published' && !current.usesTables) {
				if (
					input.coversCapPerSeating == null &&
					input.coversCapPerDay == null
				) {
					throw invalid([{ path: 'coversCapPerSeating', code: 'cap_required' }])
				}
			}
			const id = `exs_${randomUUID()}`
			await tx
				.insert(rsvExperienceSchedules)
				.values({ id, experienceId: current.id, ...scheduleValues(input) })
			const after = await schedulesFor(tx, current.id)
			await afterScheduleChange(tx, params, current, before, after, {
				schedule: 'create',
				scheduleId: id,
			})
			return getExperience(tx, locationId, current.id)
		},
		params.orgId,
	)
}

export async function updateExperienceSchedule(
	db: TenantDatabase,
	params: ScheduleWriteParams & {
		scheduleId: string
		patch: SetupExperienceScheduleUpdate
	},
): Promise<SerializedExperience> {
	const { locationId, patch } = params
	return withSetupWrite(
		db,
		async (tx) => {
			const current = await loadExperienceRow(
				tx,
				locationId,
				params.experienceId,
			)
			const before = await schedulesFor(tx, current.id)
			assertVersion(current, before, patch.expectedVersion)
			if (current.status === 'archived') {
				throw conflict('experience_archived', 'experience_archived')
			}
			const existing = before.find((s) => s.id === params.scheduleId)
			if (!existing) throw notFound('not_found')

			// Switching between explicit and stepped seatings replaces the other mode.
			const { expectedVersion: ignoredVersion, ...fields } = patch
			void ignoredVersion
			const merged: Record<string, unknown> = {
				fromDate: existing.fromDate,
				toDate: existing.toDate,
				daysMask: existing.daysMask,
				seatingMins: existing.seatingMins,
				startMin: existing.startMin,
				endMin: existing.endMin,
				intervalMin: existing.intervalMin,
				turnMin: existing.turnMin,
				coversCapPerSeating: existing.coversCapPerSeating,
				coversCapPerDay: existing.coversCapPerDay,
				areaIds: existing.areaIds,
				serviceId: existing.serviceId,
				...fields,
			}
			const touchesStepped =
				fields.startMin !== undefined ||
				fields.endMin !== undefined ||
				fields.intervalMin !== undefined
			if (fields.seatingMins != null && !touchesStepped) {
				merged.startMin = null
				merged.endMin = null
				merged.intervalMin = null
			} else if (touchesStepped && fields.seatingMins === undefined) {
				merged.seatingMins = null
			}
			const parsed = setupExperienceScheduleInputSchema.safeParse(merged)
			if (!parsed.success) throw invalid(issuesFromZod(parsed.error))
			await assertReferences(tx, locationId, {
				areaIds: fields.areaIds,
				serviceId: fields.serviceId,
			})
			await tx
				.update(rsvExperienceSchedules)
				.set(scheduleValues(parsed.data))
				.where(eq(rsvExperienceSchedules.id, existing.id))
			const after = await schedulesFor(tx, current.id)
			if (current.status === 'published') {
				const { today } = await settingsClock(
					tx,
					params.orgId,
					locationId,
					params.now ?? Date.now(),
				)
				assertPublishedStillValid(current, after, today)
			}
			await afterScheduleChange(tx, params, current, before, after, {
				schedule: 'update',
				scheduleId: existing.id,
			})
			return getExperience(tx, locationId, current.id)
		},
		params.orgId,
	)
}

export async function deleteExperienceSchedule(
	db: TenantDatabase,
	params: ScheduleWriteParams & {
		scheduleId: string
		expectedVersion?: number
	},
): Promise<SerializedExperience> {
	const { locationId } = params
	return withSetupWrite(
		db,
		async (tx) => {
			const current = await loadExperienceRow(
				tx,
				locationId,
				params.experienceId,
			)
			const before = await schedulesFor(tx, current.id)
			assertVersion(current, before, params.expectedVersion)
			if (current.status === 'archived') {
				throw conflict('experience_archived', 'experience_archived')
			}
			const existing = before.find((s) => s.id === params.scheduleId)
			if (!existing) throw notFound('not_found')
			const after = before.filter((s) => s.id !== existing.id)
			if (current.status === 'published') {
				const { today } = await settingsClock(
					tx,
					params.orgId,
					locationId,
					params.now ?? Date.now(),
				)
				assertPublishedStillValid(current, after, today)
			}
			await tx
				.delete(rsvExperienceSchedules)
				.where(eq(rsvExperienceSchedules.id, existing.id))
			await afterScheduleChange(tx, params, current, before, after, {
				schedule: 'delete',
				scheduleId: existing.id,
			})
			return getExperience(tx, locationId, current.id)
		},
		params.orgId,
	)
}
