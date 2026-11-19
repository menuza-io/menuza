import {
	isTimeExpiryAllowedInRegion,
	LoyaltyDomainError,
	loyaltyProgramConfigSchema,
	loyaltyRewardDefinitionSchema,
	memberMeetsTier,
	tierById,
	type LoyaltyFeatures,
	type LoyaltyOperatorProgram,
	type LoyaltyOperatorReward,
	type LoyaltyProgramConfig,
	type LoyaltyProgramStatus,
	type LoyaltyPublicProgram,
	type LoyaltyPublicReward,
	type LoyaltyRewardDefinition,
	type LoyaltyRewardSnapshot,
	type LoyaltyRewardStatus,
	type LoyaltyTiersConfig,
} from '@repo/loyalty'
import {
	loyaltyProgramVersions,
	loyaltyPrograms,
	loyaltyRewardVersions,
	loyaltyRewards,
} from '@repo/tenant-db'
import { and, asc, desc, eq, lte, sql } from 'drizzle-orm'
import {
	afterActiveLoyaltyCommit,
	type LoyaltyIdempotency,
	type LoyaltyReader,
	type LoyaltyTx,
	withLoyaltyWrite,
} from '../lib/loyalty-write.ts'
import { getReservationsContext } from '../lib/reservations-context.ts'
import { recordLoyaltyAudit } from './loyalty-audit.ts'
import { notifyExpiryEnabledForOrg } from './loyalty-expiry-service.ts'

/**
 * Program and reward definitions. One program per organization (`default`).
 * Every save, pause or activation appends a program version that takes effect
 * at that instant, and a sale earns under the version in force when it
 * finished, so edits never change past awards. Rewards work the same way:
 * every edit or archive appends a reward version, and redemptions keep a
 * snapshot of the version they used.
 */

export const LOYALTY_PROGRAM_ID = 'default'
export const LOYALTY_MAX_REWARDS = 100
const PROGRAM_HISTORY_LIMIT = 50

type ProgramRow = typeof loyaltyPrograms.$inferSelect
type ProgramVersionRow = typeof loyaltyProgramVersions.$inferSelect
type RewardRow = typeof loyaltyRewards.$inferSelect
type RewardVersionRow = typeof loyaltyRewardVersions.$inferSelect

export type ProgramVersion = {
	id: string
	version: number
	status: LoyaltyProgramStatus
	currency: string
	effectiveAt: number
	createdAt: number
	createdBy: string | null
	config: LoyaltyProgramConfig
}

export type CurrentProgram = {
	program: ProgramRow
	current: ProgramVersion
}

function parseProgramVersion(row: ProgramVersionRow): ProgramVersion {
	return {
		id: row.id,
		version: row.version,
		status: row.status,
		currency: row.currency,
		effectiveAt: row.effectiveAt,
		createdAt: row.createdAt,
		createdBy: row.createdBy,
		config: loyaltyProgramConfigSchema.parse(row.config),
	}
}

export async function readProgramInTx(
	db: LoyaltyReader,
): Promise<CurrentProgram | null> {
	const program = await db
		.select()
		.from(loyaltyPrograms)
		.where(eq(loyaltyPrograms.id, LOYALTY_PROGRAM_ID))
		.get()
	if (!program) return null
	const current = await programVersionByNumberInTx(db, program.currentVersion)
	if (!current) return null
	return { program, current }
}

export async function programVersionByNumberInTx(
	db: LoyaltyReader,
	version: number,
): Promise<ProgramVersion | null> {
	const row = await db
		.select()
		.from(loyaltyProgramVersions)
		.where(
			and(
				eq(loyaltyProgramVersions.programId, LOYALTY_PROGRAM_ID),
				eq(loyaltyProgramVersions.version, version),
			),
		)
		.get()
	return row ? parseProgramVersion(row) : null
}

/** The version in force at `at`: the latest that took effect at or before it. */
export async function programVersionAtInTx(
	db: LoyaltyReader,
	at: number,
): Promise<ProgramVersion | null> {
	const row = await db
		.select()
		.from(loyaltyProgramVersions)
		.where(
			and(
				eq(loyaltyProgramVersions.programId, LOYALTY_PROGRAM_ID),
				lte(loyaltyProgramVersions.effectiveAt, at),
			),
		)
		.orderBy(
			desc(loyaltyProgramVersions.effectiveAt),
			desc(loyaltyProgramVersions.version),
		)
		.limit(1)
		.get()
	return row ? parseProgramVersion(row) : null
}

function toOperatorVersion(version: ProgramVersion) {
	return {
		id: version.id,
		version: version.version,
		status: version.status,
		effectiveAt: version.effectiveAt,
		config: version.config,
		createdAt: version.createdAt,
		createdBy: version.createdBy,
	}
}

export async function getOperatorProgram(
	db: LoyaltyReader,
): Promise<LoyaltyOperatorProgram | null> {
	const current = await readProgramInTx(db)
	if (!current) return null
	const history = await db
		.select({
			version: loyaltyProgramVersions.version,
			status: loyaltyProgramVersions.status,
			method: loyaltyProgramVersions.method,
			effectiveAt: loyaltyProgramVersions.effectiveAt,
			createdBy: loyaltyProgramVersions.createdBy,
		})
		.from(loyaltyProgramVersions)
		.where(eq(loyaltyProgramVersions.programId, LOYALTY_PROGRAM_ID))
		.orderBy(desc(loyaltyProgramVersions.version))
		.limit(PROGRAM_HISTORY_LIMIT)
		.all()
	return {
		id: current.program.id,
		status: current.program.status,
		version: current.program.version,
		currencyLocked: current.program.activatedAt !== null,
		current: toOperatorVersion(current.current),
		history,
	}
}

async function insertProgramVersion(
	tx: LoyaltyTx,
	input: {
		version: number
		status: LoyaltyProgramStatus
		config: LoyaltyProgramConfig
		at: number
		actorId: string | null
	},
): Promise<void> {
	await tx.insert(loyaltyProgramVersions).values({
		programId: LOYALTY_PROGRAM_ID,
		version: input.version,
		status: input.status,
		method: input.config.earning.method,
		currency: input.config.currency,
		config: input.config as unknown as Record<string, unknown>,
		effectiveAt: input.at,
		createdAt: input.at,
		createdBy: input.actorId,
	})
}

/**
 * Saves the program configuration as a new version. The first save creates
 * the program as a draft. Once the program has been active its currency is
 * locked; before that, changing it re-issues every reward in the new currency.
 */
export async function saveProgram(
	orgId: string,
	input: {
		expectedVersion: number | null
		config: LoyaltyProgramConfig
		actorId: string
		now?: number
		idempotency?: LoyaltyIdempotency
	},
): Promise<LoyaltyOperatorProgram> {
	const config = loyaltyProgramConfigSchema.parse(input.config)
	const orgCtx = await getReservationsContext(orgId).catch(() => null)
	const regionCheck = isTimeExpiryAllowedInRegion({
		mode: config.expiry.mode,
		currency: config.currency,
		timeZone: config.timeZone,
		addresses:
			orgCtx?.locations.map((loc) =>
				typeof loc.address === 'string'
					? loc.address
					: (loc.address?.formattedAddress ?? loc.address?.city ?? null),
			) ?? [],
	})
	if (!regionCheck.allowed) {
		throw new LoyaltyDomainError('expiry_restricted_region', {
			reason: regionCheck.reason,
			jurisdiction: regionCheck.jurisdiction,
		})
	}
	return withLoyaltyWrite(
		{ orgId, now: input.now, idempotency: input.idempotency },
		async (tx, ctx) => {
			const existing = await readProgramInTx(tx)
			const prevExpiryMode = existing?.current.config.expiry.mode ?? 'never'
			const nextExpiry =
				config.expiry.mode === 'never'
					? { ...config.expiry, enabledAt: null }
					: {
							...config.expiry,
							enabledAt:
								prevExpiryMode === 'never'
									? ctx.now
									: (existing?.current.config.expiry.enabledAt ?? ctx.now),
						}
			const normalizedConfig: LoyaltyProgramConfig = {
				...config,
				expiry: nextExpiry,
			}
			const turnedExpiryOn =
				prevExpiryMode === 'never' && normalizedConfig.expiry.mode !== 'never'

			if (!existing) {
				if (input.expectedVersion !== null) {
					throw new LoyaltyDomainError('stale_version')
				}
				await tx.insert(loyaltyPrograms).values({
					id: LOYALTY_PROGRAM_ID,
					status: 'draft',
					version: 1,
					currentVersion: 1,
					currency: normalizedConfig.currency,
					createdAt: ctx.now,
					updatedAt: ctx.now,
				})
				await insertProgramVersion(tx, {
					version: 1,
					status: 'draft',
					config: normalizedConfig,
					at: ctx.now,
					actorId: input.actorId,
				})
				await recordLoyaltyAudit(tx, {
					actorKind: 'operator',
					actorId: input.actorId,
					action: 'program.created',
					entityType: 'program',
					entityId: LOYALTY_PROGRAM_ID,
					changes: { version: 1, method: normalizedConfig.earning.method },
					at: ctx.now,
				})
				return (await getOperatorProgram(tx))!
			}
			const { program } = existing
			if (input.expectedVersion !== program.version) {
				throw new LoyaltyDomainError('stale_version', {
					currentVersion: program.version,
				})
			}
			const currencyChanged = normalizedConfig.currency !== program.currency
			if (currencyChanged && program.activatedAt !== null) {
				throw new LoyaltyDomainError('config_invalid', {
					field: 'currency',
					reason: 'locked',
				})
			}
			const nextVersion = program.currentVersion + 1
			await insertProgramVersion(tx, {
				version: nextVersion,
				status: program.status,
				config: normalizedConfig,
				at: ctx.now,
				actorId: input.actorId,
			})
			await tx
				.update(loyaltyPrograms)
				.set({
					version: program.version + 1,
					currentVersion: nextVersion,
					currency: normalizedConfig.currency,
					updatedAt: ctx.now,
				})
				.where(eq(loyaltyPrograms.id, LOYALTY_PROGRAM_ID))
			if (currencyChanged) {
				await reissueRewardsInCurrency(tx, normalizedConfig.currency, {
					at: ctx.now,
					actorId: input.actorId,
				})
			}
			await recordLoyaltyAudit(tx, {
				actorKind: 'operator',
				actorId: input.actorId,
				action: 'program.saved',
				entityType: 'program',
				entityId: LOYALTY_PROGRAM_ID,
				changes: {
					version: nextVersion,
					method: normalizedConfig.earning.method,
					currencyChanged,
				},
				at: ctx.now,
			})
			if (turnedExpiryOn) {
				afterActiveLoyaltyCommit((committedOrgId) => {
					void notifyExpiryEnabledForOrg(committedOrgId, { now: ctx.now })
				})
			}
			return (await getOperatorProgram(tx))!
		},
	)
}

/**
 * Activates or pauses the program. Either way a new version takes effect now:
 * sales that finish while paused do not earn, and an offline sale made before
 * the pause still earns under the version of its sale time.
 */
export async function setProgramStatus(
	orgId: string,
	input: {
		expectedVersion: number
		status: 'active' | 'paused'
		actorId: string
		now?: number
		idempotency?: LoyaltyIdempotency
	},
): Promise<LoyaltyOperatorProgram> {
	return withLoyaltyWrite(
		{ orgId, now: input.now, idempotency: input.idempotency },
		async (tx, ctx) => {
			const existing = await readProgramInTx(tx)
			if (!existing) throw new LoyaltyDomainError('program_not_found')
			const { program, current } = existing
			if (input.expectedVersion !== program.version) {
				throw new LoyaltyDomainError('stale_version', {
					currentVersion: program.version,
				})
			}
			if (program.status === input.status) {
				return (await getOperatorProgram(tx))!
			}
			const nextVersion = program.currentVersion + 1
			await insertProgramVersion(tx, {
				version: nextVersion,
				status: input.status,
				config: current.config,
				at: ctx.now,
				actorId: input.actorId,
			})
			await tx
				.update(loyaltyPrograms)
				.set({
					status: input.status,
					version: program.version + 1,
					currentVersion: nextVersion,
					activatedAt:
						program.activatedAt ?? (input.status === 'active' ? ctx.now : null),
					updatedAt: ctx.now,
				})
				.where(eq(loyaltyPrograms.id, LOYALTY_PROGRAM_ID))
			await recordLoyaltyAudit(tx, {
				actorKind: 'operator',
				actorId: input.actorId,
				action:
					input.status === 'active' ? 'program.activated' : 'program.paused',
				entityType: 'program',
				entityId: LOYALTY_PROGRAM_ID,
				changes: { version: nextVersion, from: program.status },
				at: ctx.now,
			})
			return (await getOperatorProgram(tx))!
		},
	)
}

// ---------------------------------------------------------------------------
// Rewards
// ---------------------------------------------------------------------------

function parseRewardVersion(
	reward: RewardRow,
	version: RewardVersionRow,
): {
	status: LoyaltyRewardStatus
	snapshot: LoyaltyRewardSnapshot
	reward: RewardRow
} {
	return {
		status: version.status,
		reward,
		snapshot: {
			rewardId: reward.id,
			version: version.version,
			currency: version.currency,
			definition: loyaltyRewardDefinitionSchema.parse(version.definition),
		},
	}
}

function currentRewardQuery(db: LoyaltyReader) {
	return db
		.select({ reward: loyaltyRewards, version: loyaltyRewardVersions })
		.from(loyaltyRewards)
		.innerJoin(
			loyaltyRewardVersions,
			and(
				eq(loyaltyRewardVersions.rewardId, loyaltyRewards.id),
				eq(loyaltyRewardVersions.version, loyaltyRewards.version),
			),
		)
}

export type CurrentReward = ReturnType<typeof parseRewardVersion>

export async function readRewardInTx(
	db: LoyaltyReader,
	rewardId: string,
): Promise<CurrentReward | null> {
	const row = await currentRewardQuery(db)
		.where(eq(loyaltyRewards.id, rewardId))
		.get()
	return row ? parseRewardVersion(row.reward, row.version) : null
}

export async function readRewardVersionInTx(
	db: LoyaltyReader,
	rewardId: string,
	version: number,
): Promise<LoyaltyRewardSnapshot | null> {
	const reward = await db
		.select()
		.from(loyaltyRewards)
		.where(eq(loyaltyRewards.id, rewardId))
		.get()
	if (!reward) return null
	const row = await db
		.select()
		.from(loyaltyRewardVersions)
		.where(
			and(
				eq(loyaltyRewardVersions.rewardId, rewardId),
				eq(loyaltyRewardVersions.version, version),
			),
		)
		.get()
	return row ? parseRewardVersion(reward, row).snapshot : null
}

/** Active rewards, cheapest first. */
export async function activeRewardsInTx(
	db: LoyaltyReader,
): Promise<LoyaltyRewardSnapshot[]> {
	const rows = await currentRewardQuery(db)
		.where(eq(loyaltyRewards.status, 'active'))
		.orderBy(asc(loyaltyRewards.pointsCost), asc(loyaltyRewards.id))
		.all()
	return rows.map((row) => parseRewardVersion(row.reward, row.version).snapshot)
}

function toOperatorReward(current: CurrentReward): LoyaltyOperatorReward {
	return {
		id: current.reward.id,
		status: current.status,
		version: current.snapshot.version,
		currency: current.snapshot.currency,
		definition: current.snapshot.definition,
		createdAt: current.reward.createdAt,
		updatedAt: current.reward.updatedAt,
	}
}

export async function listOperatorRewards(
	db: LoyaltyReader,
): Promise<LoyaltyOperatorReward[]> {
	const rows = await currentRewardQuery(db)
		.orderBy(asc(loyaltyRewards.status), asc(loyaltyRewards.pointsCost))
		.all()
	return rows.map((row) =>
		toOperatorReward(parseRewardVersion(row.reward, row.version)),
	)
}

async function appendRewardVersion(
	tx: LoyaltyTx,
	input: {
		reward: RewardRow
		definition: LoyaltyRewardDefinition
		status: LoyaltyRewardStatus
		currency: string
		at: number
		actorId: string | null
	},
): Promise<void> {
	const nextVersion = input.reward.version + 1
	await tx.insert(loyaltyRewardVersions).values({
		rewardId: input.reward.id,
		version: nextVersion,
		status: input.status,
		currency: input.currency,
		definition: input.definition as unknown as Record<string, unknown>,
		createdAt: input.at,
		createdBy: input.actorId,
	})
	await tx
		.update(loyaltyRewards)
		.set({
			version: nextVersion,
			status: input.status,
			kind: input.definition.kind,
			name: input.definition.name,
			pointsCost: input.definition.pointsCost,
			currency: input.currency,
			updatedAt: input.at,
		})
		.where(eq(loyaltyRewards.id, input.reward.id))
}

async function reissueRewardsInCurrency(
	tx: LoyaltyTx,
	currency: string,
	meta: { at: number; actorId: string | null },
): Promise<void> {
	const rows = await currentRewardQuery(tx).all()
	for (const row of rows) {
		const current = parseRewardVersion(row.reward, row.version)
		if (current.snapshot.currency === currency) continue
		await appendRewardVersion(tx, {
			reward: row.reward,
			definition: current.snapshot.definition,
			status: current.status,
			currency,
			...meta,
		})
	}
}

export async function createReward(
	orgId: string,
	input: {
		definition: LoyaltyRewardDefinition
		actorId: string
		now?: number
		idempotency?: LoyaltyIdempotency
	},
): Promise<LoyaltyOperatorReward> {
	const definition = loyaltyRewardDefinitionSchema.parse(input.definition)
	return withLoyaltyWrite(
		{ orgId, now: input.now, idempotency: input.idempotency },
		async (tx, ctx) => {
			const program = await readProgramInTx(tx)
			if (!program) throw new LoyaltyDomainError('program_not_found')
			if (
				definition.minTierId &&
				!tierById(program.current.config.tiers, definition.minTierId).tier
			) {
				throw new LoyaltyDomainError('config_invalid', {
					field: 'minTierId',
				})
			}
			const count = await tx
				.select({ count: sql<number>`count(*)` })
				.from(loyaltyRewards)
				.get()
			if (Number(count?.count ?? 0) >= LOYALTY_MAX_REWARDS) {
				throw new LoyaltyDomainError('config_invalid', {
					reason: 'too_many_rewards',
				})
			}
			const [reward] = await tx
				.insert(loyaltyRewards)
				.values({
					status: 'active',
					version: 1,
					kind: definition.kind,
					name: definition.name,
					pointsCost: definition.pointsCost,
					currency: program.program.currency,
					createdAt: ctx.now,
					updatedAt: ctx.now,
				})
				.returning()
			await tx.insert(loyaltyRewardVersions).values({
				rewardId: reward!.id,
				version: 1,
				status: 'active',
				currency: program.program.currency,
				definition: definition as unknown as Record<string, unknown>,
				createdAt: ctx.now,
				createdBy: input.actorId,
			})
			await recordLoyaltyAudit(tx, {
				actorKind: 'operator',
				actorId: input.actorId,
				action: 'reward.created',
				entityType: 'reward',
				entityId: reward!.id,
				changes: {
					version: 1,
					kind: definition.kind,
					pointsCost: definition.pointsCost,
				},
				at: ctx.now,
			})
			return toOperatorReward((await readRewardInTx(tx, reward!.id))!)
		},
	)
}

export async function updateReward(
	orgId: string,
	input: {
		rewardId: string
		expectedVersion: number
		definition: LoyaltyRewardDefinition
		actorId: string
		now?: number
		idempotency?: LoyaltyIdempotency
	},
): Promise<LoyaltyOperatorReward> {
	const definition = loyaltyRewardDefinitionSchema.parse(input.definition)
	return withLoyaltyWrite(
		{ orgId, now: input.now, idempotency: input.idempotency },
		async (tx, ctx) => {
			const current = await readRewardInTx(tx, input.rewardId)
			if (!current) throw new LoyaltyDomainError('reward_not_found')
			if (definition.minTierId) {
				const program = await readProgramInTx(tx)
				if (
					!program ||
					!tierById(program.current.config.tiers, definition.minTierId).tier
				) {
					throw new LoyaltyDomainError('config_invalid', {
						field: 'minTierId',
					})
				}
			}
			if (current.reward.version !== input.expectedVersion) {
				throw new LoyaltyDomainError('stale_version', {
					currentVersion: current.reward.version,
				})
			}
			await appendRewardVersion(tx, {
				reward: current.reward,
				definition,
				status: current.status,
				currency: current.snapshot.currency,
				at: ctx.now,
				actorId: input.actorId,
			})
			await recordLoyaltyAudit(tx, {
				actorKind: 'operator',
				actorId: input.actorId,
				action: 'reward.updated',
				entityType: 'reward',
				entityId: current.reward.id,
				changes: {
					version: current.reward.version + 1,
					kind: definition.kind,
					pointsCost: definition.pointsCost,
				},
				at: ctx.now,
			})
			return toOperatorReward((await readRewardInTx(tx, current.reward.id))!)
		},
	)
}

/**
 * Archives or restores a reward. Archiving stops new redemptions; ones already
 * in progress keep their snapshot and finish normally.
 */
export async function setRewardStatus(
	orgId: string,
	input: {
		rewardId: string
		expectedVersion: number
		status: LoyaltyRewardStatus
		actorId: string
		now?: number
		idempotency?: LoyaltyIdempotency
	},
): Promise<LoyaltyOperatorReward> {
	return withLoyaltyWrite(
		{ orgId, now: input.now, idempotency: input.idempotency },
		async (tx, ctx) => {
			const current = await readRewardInTx(tx, input.rewardId)
			if (!current) throw new LoyaltyDomainError('reward_not_found')
			if (current.reward.version !== input.expectedVersion) {
				throw new LoyaltyDomainError('stale_version', {
					currentVersion: current.reward.version,
				})
			}
			if (current.status === input.status) return toOperatorReward(current)
			await appendRewardVersion(tx, {
				reward: current.reward,
				definition: current.snapshot.definition,
				status: input.status,
				currency: current.snapshot.currency,
				at: ctx.now,
				actorId: input.actorId,
			})
			await recordLoyaltyAudit(tx, {
				actorKind: 'operator',
				actorId: input.actorId,
				action:
					input.status === 'archived' ? 'reward.archived' : 'reward.restored',
				entityType: 'reward',
				entityId: current.reward.id,
				changes: { version: current.reward.version + 1 },
				at: ctx.now,
			})
			return toOperatorReward((await readRewardInTx(tx, current.reward.id))!)
		},
	)
}

export function toPublicReward(
	snapshot: LoyaltyRewardSnapshot,
	options?: {
		tiers?: LoyaltyTiersConfig | null
		memberTierId?: string | null
	},
): LoyaltyPublicReward {
	const definition = snapshot.definition
	const minTierId = definition.minTierId ?? null
	const minTier =
		minTierId && options?.tiers ? tierById(options.tiers, minTierId).tier : null
	const lockedByTier =
		minTierId !== null && options?.tiers?.enabled
			? !memberMeetsTier(options.tiers, options.memberTierId ?? null, minTierId)
			: false
	return {
		id: snapshot.rewardId,
		version: snapshot.version,
		name: definition.name,
		description: definition.description ?? null,
		pointsCost: definition.pointsCost,
		kind: definition.kind,
		discount: definition.kind === 'free_item' ? null : definition.discount,
		itemIds: definition.kind === 'items' ? definition.itemIds : [],
		categoryIds: definition.kind === 'categories' ? definition.categoryIds : [],
		freeItemId: definition.kind === 'free_item' ? definition.itemId : null,
		labels: definition.labels,
		currency: snapshot.currency,
		minTierId,
		minTierName: minTier?.name ?? null,
		lockedByTier,
	}
}

/**
 * What customers see. Nothing until the program has been activated; a paused
 * program still shows, so members can see their balance and history.
 */
export async function getPublicProgram(
	db: LoyaltyReader,
	features: LoyaltyFeatures,
	options?: { memberTierId?: string | null },
): Promise<LoyaltyPublicProgram | null> {
	if (!features.enabled) return null
	const current = await readProgramInTx(db)
	if (!current || current.program.status === 'draft') return null
	const status = current.program.status
	const config = current.current.config
	const rewards = (await activeRewardsInTx(db))
		.filter((reward) => reward.currency === current.program.currency)
		.map((reward) =>
			toPublicReward(reward, {
				tiers: config.tiers,
				memberTierId: options?.memberTierId ?? null,
			}),
		)
	return {
		name: config.name,
		unitLabel: config.unitLabel,
		currency: current.program.currency,
		status,
		earning: config.earning,
		minimumSpendMinor: config.minimumSpendMinor,
		labels: config.labels,
		terms: config.terms.trim() === '' ? null : config.terms,
		rewards,
		redemptionEnabled: features.redemption && status === 'active',
		welcomeBonus:
			config.welcomeBonus.enabled && config.welcomeBonus.points > 0
				? {
						enabled: true,
						points: config.welcomeBonus.points,
						afterFirstPaidOrder: config.welcomeBonus.afterFirstPaidOrder,
					}
				: null,
		tiers:
			config.tiers.enabled && config.tiers.tiers.length > 0
				? {
						metric: config.tiers.metric,
						periodMonths: config.tiers.periodMonths,
						graceDays: config.tiers.graceDays,
						levels: config.tiers.tiers.map((tier) => ({
							id: tier.id,
							name: tier.name,
							threshold: tier.threshold,
							multiplierBp: tier.multiplierBp,
						})),
					}
				: null,
		expiry:
			config.expiry.mode !== 'never'
				? {
						mode: config.expiry.mode,
						months: config.expiry.months,
						enabledAt: config.expiry.enabledAt,
					}
				: null,
		referrals:
			features.referrals && config.referrals.enabled
				? {
						enabled: true,
						referrerPoints: config.referrals.referrerPoints,
						friendPoints: config.referrals.friendPoints,
						friendDiscount: config.referrals.friendDiscount,
						minimumOrderMinor: config.referrals.minimumOrderMinor,
					}
				: null,
	}
}
