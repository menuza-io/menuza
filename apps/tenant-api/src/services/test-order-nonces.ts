import { testOrderNonces, type TenantTransaction } from '@repo/tenant-db'
import { and, eq, isNull } from 'drizzle-orm'

/**
 * Spends a nonce inside the order's own transaction: true when this call spent
 * it. A nonce that was never minted, or is spent already, is false, and the
 * order is refused with `test_code_invalid` (nothing was written yet).
 */
export async function spendTestNonceInTx(
	tx: TenantTransaction,
	nonce: string,
	locationId: string,
	now: number,
): Promise<boolean> {
	const spent = await tx
		.update(testOrderNonces)
		.set({ usedAt: now })
		.where(
			and(
				eq(testOrderNonces.nonce, nonce),
				eq(testOrderNonces.locationId, locationId),
				isNull(testOrderNonces.usedAt),
			),
		)
		.returning({ nonce: testOrderNonces.nonce })
	return spent.length === 1
}
