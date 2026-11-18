import { and, asc, eq, gt, isNotNull, isNull, sql } from 'drizzle-orm'
import {
	DEFAULT_TERMINAL_SETTINGS,
	inheritedPatch,
	parseOverrides,
	TERMINAL_SETTING_KEYS,
	type TerminalProfileInput,
	type TerminalProfileView,
	type TerminalSettingKey,
	type TerminalSettings,
} from '@repo/common/terminal-profiles'
import {
	posDevices,
	posPairingCodes,
	posTerminalProfiles,
	runTenantTransaction,
	type PosDevice,
	type TenantDatabase,
} from '@repo/tenant-db'
import {
	planDeviceSettings,
	profileSettingsOrNull,
	storedTerminalSettings,
	terminalSettingsOf,
	type DeviceSettingsPatch,
	type PosFailure,
	type PosResult,
} from './pos-service.ts'
import { diffFields, writeOperatorAudit } from './staff-audit.ts'

const MAX_PROFILES = 50

const fail = (
	status: PosFailure['status'],
	error: string,
	message?: string,
	extra?: Record<string, unknown>,
): PosFailure => ({
	ok: false,
	status,
	error,
	...(message ? { message } : {}),
	...(extra ? { extra } : {}),
})
const ok = <T>(value: T): PosResult<T> => ({ ok: true, value })

/**
 * The caller's permission check for turning Station apps on: runs once for
 * every terminal a change would reach, with the settings that terminal will
 * have afterwards. Returns a failure to refuse the whole change.
 */
export type TerminalChangeCheck = (
	device: PosDevice,
	patch: DeviceSettingsPatch,
) => Promise<PosFailure | null>

const isUnique = (error: unknown) => {
	let current: unknown = error
	for (let depth = 0; depth < 5 && current; depth++) {
		if (/UNIQUE/i.test(current instanceof Error ? current.message : ''))
			return true
		current = (current as { cause?: unknown }).cause
	}
	return false
}

function viewOf(
	row: typeof posTerminalProfiles.$inferSelect,
	counts: { terminals: number; codes: number },
): TerminalProfileView {
	return {
		id: row.id,
		name: row.name,
		settings: profileSettingsOrNull(row.settings) ?? DEFAULT_TERMINAL_SETTINGS,
		version: row.version,
		terminalCount: counts.terminals,
		pendingCodeCount: counts.codes,
		updatedAt: row.updatedAt,
	}
}

async function usage(
	db: TenantDatabase,
	now: number,
): Promise<Map<string, { terminals: number; codes: number }>> {
	const out = new Map<string, { terminals: number; codes: number }>()
	const bump = (id: string, key: 'terminals' | 'codes') => {
		const row = out.get(id) ?? { terminals: 0, codes: 0 }
		row[key] += 1
		out.set(id, row)
	}
	const devices = await db
		.select({ profileId: posDevices.profileId })
		.from(posDevices)
		.where(and(isNotNull(posDevices.profileId), isNull(posDevices.revokedAt)))
	for (const d of devices) if (d.profileId) bump(d.profileId, 'terminals')
	const codes = await db
		.select({ profileId: posPairingCodes.profileId })
		.from(posPairingCodes)
		.where(
			and(
				isNotNull(posPairingCodes.profileId),
				isNull(posPairingCodes.usedAt),
				gt(posPairingCodes.expiresAt, now),
			),
		)
	for (const c of codes) if (c.profileId) bump(c.profileId, 'codes')
	return out
}

export async function listProfiles(
	db: TenantDatabase,
	now = Date.now(),
): Promise<TerminalProfileView[]> {
	const [rows, counts] = await Promise.all([
		db
			.select()
			.from(posTerminalProfiles)
			.orderBy(asc(posTerminalProfiles.name)),
		usage(db, now),
	])
	return rows.map((row) =>
		viewOf(row, counts.get(row.id) ?? { terminals: 0, codes: 0 }),
	)
}

export async function createProfile(
	db: TenantDatabase,
	input: TerminalProfileInput,
	by: string,
	now = Date.now(),
): Promise<PosResult<TerminalProfileView>> {
	const [{ total } = { total: 0 }] = await db
		.select({ total: sql<number>`count(*)` })
		.from(posTerminalProfiles)
	if (Number(total) >= MAX_PROFILES)
		return fail(409, 'too_many_profiles', 'Remove a profile first.')
	const id = crypto.randomUUID()
	try {
		await db.insert(posTerminalProfiles).values({
			id,
			name: input.name,
			settings: JSON.stringify(input.settings),
			version: 1,
			createdBy: by,
			updatedBy: by,
			createdAt: now,
			updatedAt: now,
		})
	} catch (error) {
		if (isUnique(error))
			return fail(409, 'name_taken', 'A profile with that name exists.')
		throw error
	}
	await writeOperatorAudit(db, by, null, {
		action: 'pos.profile.created',
		entityType: 'pos_terminal_profile',
		entityId: id,
		changes: { name: input.name },
	}).catch(() => undefined)
	const [row] = await db
		.select()
		.from(posTerminalProfiles)
		.where(eq(posTerminalProfiles.id, id))
	return ok(viewOf(row!, { terminals: 0, codes: 0 }))
}

/** Lowest-level write: one terminal gets exactly `set`. */
type Applied = {
	device: PosDevice
	set: Partial<typeof posDevices.$inferInsert>
}

/**
 * Edits a profile and writes the change to every terminal that inherits it and
 * does not override the setting. The change is checked for all of them first
 * (the rules a manager's own edit follows, and the caller's permission
 * check): if any one would be refused, none is written and the refusal names
 * the terminals.
 */
export async function updateProfile(
	db: TenantDatabase,
	id: string,
	input: TerminalProfileInput & { expectedVersion: number },
	by: string,
	options: { check?: TerminalChangeCheck; now?: number } = {},
): Promise<
	PosResult<{ profile: TerminalProfileView; updatedTerminals: number }>
> {
	const now = options.now ?? Date.now()
	let applied: Applied[] = []
	let result: PosResult<{ updatedTerminals: number }>
	try {
		result = await runTenantTransaction(db, async (tx) => {
			const [row] = await tx
				.select()
				.from(posTerminalProfiles)
				.where(eq(posTerminalProfiles.id, id))
				.limit(1)
			if (!row) return fail(404, 'not_found')
			if (row.version !== input.expectedVersion)
				return fail(409, 'stale_version', 'The profile changed elsewhere.')
			const devices = await tx
				.select()
				.from(posDevices)
				.where(and(eq(posDevices.profileId, id), isNull(posDevices.revokedAt)))
				.orderBy(asc(posDevices.terminalCode))
			const plans: Applied[] = []
			const conflicts: Array<{ terminalCode: string; error: string }> = []
			for (const device of devices) {
				const overrides = parseOverrides(device.profileOverrides)
				const patch = inheritedPatch(
					input.settings,
					storedTerminalSettings(device),
					overrides,
				) as DeviceSettingsPatch
				const planned =
					Object.keys(patch).length > 0
						? planDeviceSettings(device, patch, now)
						: null
				if (planned && !planned.ok) {
					conflicts.push({
						terminalCode: device.terminalCode,
						error: planned.error,
					})
					continue
				}
				const set = planned?.value ?? {}
				// An override that now equals the profile is no longer a difference.
				const after = terminalSettingsOf({ ...device, ...set })
				const nextOverrides = JSON.stringify(
					overrides.filter((key) => after[key] !== input.settings[key]),
				)
				if (!planned) {
					if (nextOverrides !== device.profileOverrides)
						plans.push({ device, set: { profileOverrides: nextOverrides } })
					continue
				}
				const denied = options.check ? await options.check(device, patch) : null
				if (denied) return denied
				plans.push({
					device,
					set: { ...set, profileOverrides: nextOverrides },
				})
			}
			if (conflicts.length > 0)
				return fail(
					422,
					'profile_conflict',
					'Some terminals cannot take this change.',
					{ terminals: conflicts },
				)
			try {
				await tx
					.update(posTerminalProfiles)
					.set({
						name: input.name,
						settings: JSON.stringify(input.settings),
						version: row.version + 1,
						updatedBy: by,
						updatedAt: now,
					})
					.where(eq(posTerminalProfiles.id, id))
			} catch (error) {
				if (isUnique(error))
					return fail(409, 'name_taken', 'A profile with that name exists.')
				throw error
			}
			for (const plan of plans)
				await tx
					.update(posDevices)
					.set(plan.set)
					.where(eq(posDevices.id, plan.device.id))
			applied = plans
			return ok({ updatedTerminals: plans.length })
		})
	} catch (error) {
		if (isUnique(error))
			return fail(409, 'name_taken', 'A profile with that name exists.')
		throw error
	}
	if (!result.ok) return result
	await writeOperatorAudit(db, by, null, {
		action: 'pos.profile.changed',
		entityType: 'pos_terminal_profile',
		entityId: id,
		changes: { name: input.name, terminals: result.value.updatedTerminals },
	}).catch(() => undefined)
	for (const { device, set } of applied) {
		const changes = diffFields(
			terminalSettingsOf(device) as Record<string, unknown>,
			terminalSettingsOf({ ...device, ...set }) as Record<string, unknown>,
		)
		if (Object.keys(changes).length > 0)
			await writeOperatorAudit(db, by, null, {
				action: 'pos.terminal.changed',
				entityType: 'pos_device',
				entityId: device.id,
				changes: { ...changes, viaProfile: id },
			}).catch(() => undefined)
	}
	const [row] = await db
		.select()
		.from(posTerminalProfiles)
		.where(eq(posTerminalProfiles.id, id))
	const counts = (await usage(db, now)).get(id) ?? { terminals: 0, codes: 0 }
	return ok({
		profile: viewOf(row!, counts),
		updatedTerminals: result.value.updatedTerminals,
	})
}

/**
 * A profile in use is never deleted: not while a terminal inherits it and not
 * while a pairing code waits to start one on it. Removed terminals do not
 * count; they are detached.
 */
export async function deleteProfile(
	db: TenantDatabase,
	id: string,
	by: string,
	now = Date.now(),
): Promise<PosResult<true>> {
	const result = await runTenantTransaction(db, async (tx) => {
		const [row] = await tx
			.select({ id: posTerminalProfiles.id, name: posTerminalProfiles.name })
			.from(posTerminalProfiles)
			.where(eq(posTerminalProfiles.id, id))
			.limit(1)
		if (!row) return fail(404, 'not_found')
		const terminals = await tx
			.select({ id: posDevices.id })
			.from(posDevices)
			.where(and(eq(posDevices.profileId, id), isNull(posDevices.revokedAt)))
		const codes = await tx
			.select({ id: posPairingCodes.id })
			.from(posPairingCodes)
			.where(
				and(
					eq(posPairingCodes.profileId, id),
					isNull(posPairingCodes.usedAt),
					gt(posPairingCodes.expiresAt, now),
				),
			)
		if (terminals.length > 0 || codes.length > 0)
			return fail(
				409,
				'profile_in_use',
				'Move its terminals to another profile first.',
				{ terminals: terminals.length, pendingCodes: codes.length },
			)
		await tx
			.update(posDevices)
			.set({ profileId: null, profileOverrides: '[]' })
			.where(eq(posDevices.profileId, id))
		await tx
			.update(posPairingCodes)
			.set({ profileId: null })
			.where(eq(posPairingCodes.profileId, id))
		await tx.delete(posTerminalProfiles).where(eq(posTerminalProfiles.id, id))
		return ok(row.name)
	})
	if (!result.ok) return result
	await writeOperatorAudit(db, by, null, {
		action: 'pos.profile.deleted',
		entityType: 'pos_terminal_profile',
		entityId: id,
		changes: { name: result.value },
	}).catch(() => undefined)
	return ok(true)
}

async function loadProfileSettings(db: TenantDatabase, id: string) {
	const [row] = await db
		.select()
		.from(posTerminalProfiles)
		.where(eq(posTerminalProfiles.id, id))
		.limit(1)
	const settings = row ? profileSettingsOrNull(row.settings) : null
	return row && settings ? { row, settings } : null
}

async function loadDevice(db: TenantDatabase, id: string) {
	const [device] = await db
		.select()
		.from(posDevices)
		.where(and(eq(posDevices.id, id), isNull(posDevices.revokedAt)))
		.limit(1)
	return device ?? null
}

async function audit(
	db: TenantDatabase,
	by: string,
	device: PosDevice,
	set: Partial<typeof posDevices.$inferInsert>,
	extra: Record<string, unknown>,
) {
	const changes = diffFields(
		terminalSettingsOf(device) as Record<string, unknown>,
		terminalSettingsOf({ ...device, ...set }) as Record<string, unknown>,
	)
	await writeOperatorAudit(db, by, null, {
		action: 'pos.terminal.changed',
		entityType: 'pos_device',
		entityId: device.id,
		changes: { ...changes, ...extra },
	}).catch(() => undefined)
}

/**
 * Puts a terminal on a profile (every setting takes the profile's value and
 * nothing is overridden), or detaches it (`null`: it keeps the values it has).
 */
export async function assignProfile(
	db: TenantDatabase,
	deviceId: string,
	profileId: string | null,
	by: string,
	options: { check?: TerminalChangeCheck; now?: number } = {},
): Promise<PosResult<true>> {
	const now = options.now ?? Date.now()
	const device = await loadDevice(db, deviceId)
	if (!device) return fail(404, 'not_found')
	if (profileId === null) {
		await db
			.update(posDevices)
			.set({ profileId: null, profileOverrides: '[]' })
			.where(eq(posDevices.id, deviceId))
		await audit(db, by, device, {}, { profileId: null })
		return ok(true)
	}
	const profile = await loadProfileSettings(db, profileId)
	if (!profile)
		return fail(422, 'profile_not_found', 'That profile does not exist.')
	const patch = inheritedPatch(
		profile.settings,
		storedTerminalSettings(device),
		[],
	) as DeviceSettingsPatch
	let set: Partial<typeof posDevices.$inferInsert> = {}
	if (Object.keys(patch).length > 0) {
		const planned = planDeviceSettings(device, patch, now)
		if (!planned.ok) return planned
		const denied = options.check ? await options.check(device, patch) : null
		if (denied) return denied
		set = planned.value
	}
	set = { ...set, profileId, profileOverrides: '[]' }
	await db.update(posDevices).set(set).where(eq(posDevices.id, deviceId))
	await audit(db, by, device, set, { profileId })
	return ok(true)
}

/** Sets overridden settings back to the profile's values ('all' or named keys). */
export async function resetOverrides(
	db: TenantDatabase,
	deviceId: string,
	keys: readonly TerminalSettingKey[] | 'all',
	by: string,
	options: { check?: TerminalChangeCheck; now?: number } = {},
): Promise<PosResult<true>> {
	const now = options.now ?? Date.now()
	const device = await loadDevice(db, deviceId)
	if (!device) return fail(404, 'not_found')
	if (!device.profileId)
		return fail(409, 'no_profile', 'This terminal has no profile.')
	const profile = await loadProfileSettings(db, device.profileId)
	if (!profile) return fail(409, 'no_profile', 'This terminal has no profile.')
	const overrides = parseOverrides(device.profileOverrides)
	const reset = new Set<TerminalSettingKey>(
		keys === 'all' ? overrides : keys.filter((key) => overrides.includes(key)),
	)
	if (reset.size === 0) return ok(true)
	const current = storedTerminalSettings(device)
	const patch: Record<string, unknown> = {}
	for (const key of TERMINAL_SETTING_KEYS)
		if (reset.has(key) && current[key] !== profile.settings[key])
			patch[key] = profile.settings[key]
	let set: Partial<typeof posDevices.$inferInsert> = {}
	if (Object.keys(patch).length > 0) {
		const planned = planDeviceSettings(
			device,
			patch as DeviceSettingsPatch,
			now,
		)
		if (!planned.ok) return planned
		const denied = options.check
			? await options.check(device, patch as DeviceSettingsPatch)
			: null
		if (denied) return denied
		set = planned.value
	}
	set = {
		...set,
		profileOverrides: JSON.stringify(
			overrides.filter((key) => !reset.has(key)),
		),
	}
	await db.update(posDevices).set(set).where(eq(posDevices.id, deviceId))
	await audit(db, by, device, set, { resetOverrides: [...reset] })
	return ok(true)
}

/** Settings a terminal's profile gives, for the Station check-in and the App. */
export type ProfileSummary = { id: string; name: string } | null
export async function profileSummaryFor(
	db: TenantDatabase,
	device: Pick<PosDevice, 'profileId'>,
): Promise<ProfileSummary> {
	if (!device.profileId) return null
	const [row] = await db
		.select({ id: posTerminalProfiles.id, name: posTerminalProfiles.name })
		.from(posTerminalProfiles)
		.where(eq(posTerminalProfiles.id, device.profileId))
		.limit(1)
	return row ?? null
}

export type { TerminalSettings }

/** A profile's settings, or null when there is no such profile. */
export async function getProfileSettings(
	db: TenantDatabase,
	id: string,
): Promise<TerminalSettings | null> {
	return (await loadProfileSettings(db, id))?.settings ?? null
}
