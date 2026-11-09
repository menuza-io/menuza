import {
	DEFAULT_TARGET_FOOD_COST_BP,
	defaultUnitSystem,
	type InventorySettings,
	type InventoryStatus,
	type UpdateInventorySettings,
} from '@repo/inventory'
import {
	invCounts,
	invDeliveries,
	invItems,
	invSettings,
	invStorageAreas,
} from '@repo/tenant-db'
import { and, count, eq, isNull } from 'drizzle-orm'
import { InventoryError } from '../lib/inventory-http.ts'
import {
	type InventoryIdempotency,
	type InventoryReader,
	withInventoryWrite,
} from '../lib/inventory-write.ts'
import { recordInventoryAudit } from './inventory-audit.ts'

const SETTINGS_ID = 'default'

type SettingsRow = typeof invSettings.$inferSelect

function toSettings(row: SettingsRow): InventorySettings {
	return {
		targetFoodCostBp: row.targetFoodCostBp,
		unitSystem: row.unitSystem,
		countDayOfWeek: row.countDayOfWeek ?? null,
		anyStaffCanReceive: row.anyStaffCanReceive,
		version: row.version,
		updatedAt: row.updatedAt,
	}
}

/** What an organization that never saved its settings gets (version 0). */
export function defaultInventorySettings(
	region: 'us' | 'ksa',
): InventorySettings {
	return {
		targetFoodCostBp: DEFAULT_TARGET_FOOD_COST_BP,
		unitSystem: defaultUnitSystem(region),
		countDayOfWeek: null,
		anyStaffCanReceive: false,
		version: 0,
		updatedAt: null,
	}
}

export async function getInventorySettings(
	db: InventoryReader,
	region: 'us' | 'ksa',
): Promise<InventorySettings> {
	const row = await db
		.select()
		.from(invSettings)
		.where(eq(invSettings.id, SETTINGS_ID))
		.get()
	return row ? toSettings(row) : defaultInventorySettings(region)
}

/**
 * Saves a change to the settings. `expectedVersion` must be the version the
 * client read (0 before the first save), otherwise 409 `stale_version`.
 * Writes one audit row with the fields that changed.
 */
export async function updateInventorySettings(
	orgId: string,
	input: {
		region: 'us' | 'ksa'
		change: UpdateInventorySettings
		actorId: string
		idempotency?: InventoryIdempotency | null
	},
): Promise<InventorySettings> {
	return withInventoryWrite(
		{ orgId, idempotency: input.idempotency },
		async (tx, ctx) => {
			const current = await getInventorySettings(tx, input.region)
			if (current.version !== input.change.expectedVersion) {
				throw new InventoryError('stale_version', 409, {
					currentVersion: current.version,
				})
			}
			const next = {
				targetFoodCostBp:
					input.change.targetFoodCostBp ?? current.targetFoodCostBp,
				unitSystem: input.change.unitSystem ?? current.unitSystem,
				countDayOfWeek:
					input.change.countDayOfWeek === undefined
						? current.countDayOfWeek
						: input.change.countDayOfWeek,
				anyStaffCanReceive:
					input.change.anyStaffCanReceive ??
					current.anyStaffCanReceive ??
					false,
				version: current.version + 1,
				updatedAt: ctx.now,
			}
			await tx
				.insert(invSettings)
				.values({ id: SETTINGS_ID, ...next })
				.onConflictDoUpdate({ target: invSettings.id, set: next })

			const detail: Record<string, string | number | boolean | null> = {
				version: next.version,
			}
			for (const key of [
				'targetFoodCostBp',
				'unitSystem',
				'countDayOfWeek',
				'anyStaffCanReceive',
			] as const) {
				if (next[key] !== current[key]) detail[key] = next[key]
			}
			await recordInventoryAudit(tx, {
				actorKind: 'operator',
				actorId: input.actorId,
				action: 'settings.update',
				resourceType: 'settings',
				resourceId: SETTINGS_ID,
				detail,
				at: ctx.now,
			})
			return { ...next }
		},
	)
}

/** Setup checklist facts for one location (`GET /status`). */
export async function getInventoryStatus(
	db: InventoryReader,
	locationId: string,
): Promise<InventoryStatus> {
	const [items, storageAreas, approvedCounts, deliveries] = await Promise.all([
		db
			.select({ n: count() })
			.from(invItems)
			.where(isNull(invItems.archivedAt))
			.get(),
		db
			.select({ n: count() })
			.from(invStorageAreas)
			.where(
				and(
					eq(invStorageAreas.locationId, locationId),
					isNull(invStorageAreas.archivedAt),
				),
			)
			.get(),
		db
			.select({ n: count() })
			.from(invCounts)
			.where(
				and(
					eq(invCounts.locationId, locationId),
					eq(invCounts.status, 'approved'),
				),
			)
			.get(),
		db
			.select({ n: count() })
			.from(invDeliveries)
			.where(
				and(
					eq(invDeliveries.locationId, locationId),
					eq(invDeliveries.status, 'received'),
				),
			)
			.get(),
	])
	return {
		locationId,
		items: Number(items?.n ?? 0),
		storageAreas: Number(storageAreas?.n ?? 0),
		approvedCounts: Number(approvedCounts?.n ?? 0),
		deliveries: Number(deliveries?.n ?? 0),
	}
}
