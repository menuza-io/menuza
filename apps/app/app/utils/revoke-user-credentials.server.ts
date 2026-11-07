import {
	and,
	ApiKey,
	db,
	eq,
	gt,
	isNull,
	MCPAuthorization,
	ne,
	or,
	RefreshToken,
	Session,
} from '@repo/database'
import { revokePendingAuthorizationCodes } from '#app/utils/mcp/oauth.server.ts'

/**
 * Revoke refresh tokens, MCP authorizations, and active API keys for a user.
 * Optionally delete sessions (all or all except one).
 */
export async function revokeUserCredentials(options: {
	userId: string
	exceptSessionId?: string | null
	revokePendingMcpCodes?: boolean
}) {
	const now = new Date()
	const sessionDelete = options.exceptSessionId
		? db
				.delete(Session)
				.where(
					and(
						eq(Session.userId, options.userId),
						ne(Session.id, options.exceptSessionId),
					),
				)
		: db.delete(Session).where(eq(Session.userId, options.userId))

	await db.batch([
		db
			.update(RefreshToken)
			.set({ revoked: true })
			.where(
				and(
					eq(RefreshToken.userId, options.userId),
					eq(RefreshToken.revoked, false),
				),
			),
		db
			.update(MCPAuthorization)
			.set({ isActive: false })
			.where(eq(MCPAuthorization.userId, options.userId)),
		db
			.update(ApiKey)
			.set({ expiresAt: now })
			.where(
				and(
					eq(ApiKey.userId, options.userId),
					or(isNull(ApiKey.expiresAt), gt(ApiKey.expiresAt, now)),
				),
			),
		sessionDelete,
	])

	if (options.revokePendingMcpCodes !== false) {
		await revokePendingAuthorizationCodes(options.userId)
	}
}
