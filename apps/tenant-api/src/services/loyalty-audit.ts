import { type LoyaltyActorKind } from '@repo/loyalty'
import { loyaltyAuditLog } from '@repo/tenant-db'
import { type LoyaltyTx } from '../lib/loyalty-write.ts'

/**
 * Operator and system decisions on the program: ids, amounts, codes and the
 * operator's note. Never names, phones or cart contents. Person erasure
 * redacts the `changes` of rows about the erased member, their purchases,
 * redemptions and refunds (the only update the audit log allows).
 */
export type LoyaltyAuditEntry = {
	actorKind: LoyaltyActorKind
	actorId?: string | null
	locationId?: string | null
	action: string
	entityType:
		| 'program'
		| 'reward'
		| 'member'
		| 'purchase'
		| 'redemption'
		| 'refund'
		| 'approval'
		| 'balance'
		| 'outbox'
	entityId: string
	changes?: Record<string, string | number | boolean | null>
	at: number
}

export async function recordLoyaltyAudit(
	tx: LoyaltyTx,
	entry: LoyaltyAuditEntry,
): Promise<void> {
	await tx.insert(loyaltyAuditLog).values({
		at: entry.at,
		actorKind: entry.actorKind,
		actorId: entry.actorId ?? null,
		locationId: entry.locationId ?? null,
		action: entry.action,
		entityType: entry.entityType,
		entityId: entry.entityId,
		changes: entry.changes ?? null,
	})
}
