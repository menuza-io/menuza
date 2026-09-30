import {
	IntegrationOAuthNonce as IntegrationOAuthNonceTable,
	db,
	and,
	eq,
	gt,
	isNull,
	lt,
} from '@repo/database'

const STATE_EXPIRY_MS = 30 * 60 * 1000

export async function registerOAuthNonce(nonce: string): Promise<void> {
	const expiresAt = new Date(Date.now() + STATE_EXPIRY_MS)
	await db.insert(IntegrationOAuthNonceTable).values({ nonce, expiresAt })
}

export async function consumeOAuthNonce(nonce: string): Promise<boolean> {
	const now = new Date()
	await db
		.delete(IntegrationOAuthNonceTable)
		.where(lt(IntegrationOAuthNonceTable.expiresAt, now))

	const [updated] = await db
		.update(IntegrationOAuthNonceTable)
		.set({ consumedAt: now })
		.where(
			and(
				eq(IntegrationOAuthNonceTable.nonce, nonce),
				isNull(IntegrationOAuthNonceTable.consumedAt),
				gt(IntegrationOAuthNonceTable.expiresAt, now),
			),
		)
		.returning({ nonce: IntegrationOAuthNonceTable.nonce })

	return Boolean(updated)
}

export async function isOAuthNonceConsumed(nonce: string): Promise<boolean> {
	const [row] = await db
		.select({ consumedAt: IntegrationOAuthNonceTable.consumedAt })
		.from(IntegrationOAuthNonceTable)
		.where(eq(IntegrationOAuthNonceTable.nonce, nonce))
		.limit(1)
	return Boolean(row?.consumedAt)
}
