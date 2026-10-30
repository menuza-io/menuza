import { and, asc, db, eq, SocialAccount } from '@repo/database'
import { decryptAsync, encryptAsync, getEncryptionKey } from '@repo/security'
import { type MetaAccount } from './meta.server.ts'
import { type SocialPlatform } from './platforms.ts'

/**
 * The organization's connected Facebook Pages and Instagram accounts. Page
 * tokens are stored encrypted with INTEGRATION_ENCRYPTION_KEY and never leave
 * the App server.
 */

const key = () => getEncryptionKey('INTEGRATION_ENCRYPTION_KEY')

export type SocialAccountSummary = {
	id: string
	platform: SocialPlatform
	name: string
	username: string | null
	status: 'active' | 'needs_reauth'
	createdAt: Date
}

export async function listSocialAccounts(
	organizationId: string,
): Promise<SocialAccountSummary[]> {
	const rows = await db
		.select({
			id: SocialAccount.id,
			platform: SocialAccount.platform,
			name: SocialAccount.name,
			username: SocialAccount.username,
			status: SocialAccount.status,
			createdAt: SocialAccount.createdAt,
		})
		.from(SocialAccount)
		.where(eq(SocialAccount.organizationId, organizationId))
		.orderBy(asc(SocialAccount.platform), asc(SocialAccount.name))
	return rows as SocialAccountSummary[]
}

/** Adds or refreshes the accounts the member allowed (matched by Meta id). */
export async function saveSocialAccounts(
	owner: { userId: string; organization: { id: string } },
	accounts: MetaAccount[],
) {
	for (const account of accounts) {
		const values = {
			name: account.name.slice(0, 200),
			username: account.username?.slice(0, 200) ?? null,
			accessToken: await encryptAsync(account.accessToken, key()),
			status: 'active',
			connectedById: owner.userId,
		}
		await db
			.insert(SocialAccount)
			.values({
				organizationId: owner.organization.id,
				platform: account.platform,
				externalId: account.externalId,
				...values,
			})
			.onConflictDoUpdate({
				target: [
					SocialAccount.organizationId,
					SocialAccount.platform,
					SocialAccount.externalId,
				],
				set: values,
			})
	}
}

/**
 * Forgets an account. Posts already sent keep their history; scheduled posts
 * fail for this account when their time comes.
 */
export async function deleteSocialAccount(
	organizationId: string,
	accountId: string,
): Promise<boolean> {
	const deleted = await db
		.delete(SocialAccount)
		.where(
			and(
				eq(SocialAccount.id, accountId),
				eq(SocialAccount.organizationId, organizationId),
			),
		)
		.returning({ id: SocialAccount.id })
	return deleted.length > 0
}

/** The account with its decrypted token, for publishing only. */
export async function readSocialAccountForPublishing(accountId: string) {
	const [row] = await db
		.select()
		.from(SocialAccount)
		.where(eq(SocialAccount.id, accountId))
		.limit(1)
	if (!row) return null
	const accessToken = await decryptAsync(row.accessToken, key()).catch(
		() => null,
	)
	return {
		id: row.id,
		organizationId: row.organizationId,
		platform: row.platform as SocialPlatform,
		externalId: row.externalId,
		status: row.status,
		accessToken,
	}
}

export async function markSocialAccountNeedsReauth(accountId: string) {
	await db
		.update(SocialAccount)
		.set({ status: 'needs_reauth' })
		.where(eq(SocialAccount.id, accountId))
}
