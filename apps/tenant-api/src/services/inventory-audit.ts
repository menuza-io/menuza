import { type InventoryActorKind } from '@repo/inventory'
import { invAuditLog } from '@repo/tenant-db'
import { type InventoryTx } from '../lib/inventory-write.ts'

/**
 * Who changed what in inventory: ids, quantities, amounts and codes. Never a
 * person's name, phone or email, and never free text (supplier details and
 * notes stay on their own rows).
 */
export type InventoryAuditEntry = {
	actorKind: InventoryActorKind
	actorId?: string | null
	action: string
	resourceType: string
	resourceId: string
	locationId?: string | null
	detail?: Record<string, string | number | boolean | null>
	at: number
}

export async function recordInventoryAudit(
	tx: InventoryTx,
	entry: InventoryAuditEntry,
): Promise<void> {
	await tx.insert(invAuditLog).values({
		actorKind: entry.actorKind,
		actorId: entry.actorId ?? null,
		action: entry.action,
		resourceType: entry.resourceType,
		resourceId: entry.resourceId,
		locationId: entry.locationId ?? null,
		detail: entry.detail ?? null,
		createdAt: entry.at,
	})
}
