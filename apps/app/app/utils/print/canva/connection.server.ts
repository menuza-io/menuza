import { and, db, eq, PrintCanvaConnection } from '@repo/database'
import { decryptAsync, encryptAsync, getEncryptionKey } from '@repo/security'
import { type PrintShopAccess } from '../access.server.ts'
import {
	canvaApi,
	CanvaError,
	refreshCanvaTokens,
	revokeCanvaToken,
	type CanvaApi,
	type CanvaTokens,
} from './client.server.ts'

/**
 * A member's Canva connection (one per organization and user). Tokens are
 * stored encrypted with INTEGRATION_ENCRYPTION_KEY and never leave the App
 * server. Canva refresh tokens are single use: a refresh is written only if
 * the stored token is still the one we used, so two requests refreshing at
 * once cannot leave a spent token behind. The connection is forgotten only
 * when Canva says the grant itself is gone (`invalid_grant`), never on a
 * passing error.
 */

type Owner = Pick<PrintShopAccess, 'userId'> & {
	organization: { id: string }
}

/**
 * How long a refused refresh waits for a concurrent one to be stored, and how
 * often it looks. A slow or retried response from another request can take a
 * few seconds; deleting the connection too early would throw away the token
 * that request is about to store. Mutable only so tests can shorten it.
 */
export const CONCURRENT_REFRESH_WAIT = { totalMs: 5_000, stepMs: 250 }

/** Refresh this long before the access token runs out. */
const REFRESH_MARGIN_MS = 2 * 60_000

const key = () => getEncryptionKey('INTEGRATION_ENCRYPTION_KEY')

const ownedBy = (owner: Owner) =>
	and(
		eq(PrintCanvaConnection.organizationId, owner.organization.id),
		eq(PrintCanvaConnection.userId, owner.userId),
	)

export async function getCanvaConnection(owner: Owner) {
	const [row] = await db
		.select({
			displayName: PrintCanvaConnection.displayName,
			createdAt: PrintCanvaConnection.createdAt,
		})
		.from(PrintCanvaConnection)
		.where(ownedBy(owner))
		.limit(1)
	return row ?? null
}

export async function saveCanvaConnection(
	owner: Owner,
	tokens: CanvaTokens,
	profile: { userId: string | null; displayName: string | null },
) {
	const values = {
		accessToken: await encryptAsync(tokens.accessToken, key()),
		refreshToken: await encryptAsync(tokens.refreshToken, key()),
		expiresAt: tokens.expiresAt,
		scope: tokens.scope,
		canvaUserId: profile.userId,
		displayName: profile.displayName,
	}
	await db
		.insert(PrintCanvaConnection)
		.values({
			organizationId: owner.organization.id,
			userId: owner.userId,
			...values,
		})
		.onConflictDoUpdate({
			target: [
				PrintCanvaConnection.organizationId,
				PrintCanvaConnection.userId,
			],
			set: values,
		})
}

/** Disconnects: revokes the grant at Canva (best effort) and forgets it. */
export async function deleteCanvaConnection(owner: Owner) {
	const [row] = await db
		.select({ refreshToken: PrintCanvaConnection.refreshToken })
		.from(PrintCanvaConnection)
		.where(ownedBy(owner))
		.limit(1)
	await db.delete(PrintCanvaConnection).where(ownedBy(owner))
	if (row) {
		const token = await decryptAsync(row.refreshToken, key()).catch(() => null)
		if (token) await revokeCanvaToken(token)
	}
}

async function readTokens(owner: Owner) {
	const [row] = await db
		.select()
		.from(PrintCanvaConnection)
		.where(ownedBy(owner))
		.limit(1)
	if (!row) return null
	return {
		row,
		accessToken: await decryptAsync(row.accessToken, key()),
		refreshToken: await decryptAsync(row.refreshToken, key()),
	}
}

async function refresh(
	owner: Owner,
	current: NonNullable<Awaited<ReturnType<typeof readTokens>>>,
): Promise<string> {
	let tokens: CanvaTokens
	try {
		tokens = await refreshCanvaTokens(current.refreshToken)
	} catch (error) {
		if (error instanceof CanvaError && error.code === 'invalid_grant') {
			return recoverFromInvalidGrant(owner, current)
		}
		throw error
	}
	return storeRefreshed(owner, current, tokens)
}

/**
 * Canva refused our refresh token. Usually another request spent it a moment
 * ago and has not stored the new one yet, so wait for the row to change. Only
 * when it never does, and a second refresh is refused too, is the grant really
 * gone: then forget that row (never a connection saved meanwhile).
 */
async function recoverFromInvalidGrant(
	owner: Owner,
	current: NonNullable<Awaited<ReturnType<typeof readTokens>>>,
): Promise<string> {
	const deadline = Date.now() + CONCURRENT_REFRESH_WAIT.totalMs
	for (;;) {
		const latest = await readTokens(owner)
		if (!latest) throw new CanvaError('unauthorized', 'Canva is not connected')
		if (latest.row.refreshToken !== current.row.refreshToken) {
			return latest.accessToken
		}
		if (Date.now() >= deadline) break
		await new Promise((resolve) =>
			setTimeout(resolve, CONCURRENT_REFRESH_WAIT.stepMs),
		)
	}
	let tokens: CanvaTokens
	try {
		tokens = await refreshCanvaTokens(current.refreshToken)
	} catch (error) {
		if (!(error instanceof CanvaError && error.code === 'invalid_grant')) {
			throw error
		}
		// The grant is gone (revoked in Canva, or expired): connect again.
		const deleted = await db
			.delete(PrintCanvaConnection)
			.where(
				and(
					ownedBy(owner),
					eq(PrintCanvaConnection.refreshToken, current.row.refreshToken),
				),
			)
			.returning({ id: PrintCanvaConnection.id })
		if (deleted.length === 0) {
			const latest = await readTokens(owner)
			if (latest) return latest.accessToken
		}
		throw new CanvaError('unauthorized', 'Canva is not connected')
	}
	return storeRefreshed(owner, current, tokens)
}

async function storeRefreshed(
	owner: Owner,
	current: NonNullable<Awaited<ReturnType<typeof readTokens>>>,
	tokens: CanvaTokens,
): Promise<string> {
	const updated = await db
		.update(PrintCanvaConnection)
		.set({
			accessToken: await encryptAsync(tokens.accessToken, key()),
			refreshToken: await encryptAsync(tokens.refreshToken, key()),
			expiresAt: tokens.expiresAt,
			scope: tokens.scope,
		})
		.where(
			and(
				ownedBy(owner),
				eq(PrintCanvaConnection.refreshToken, current.row.refreshToken),
			),
		)
		.returning({ id: PrintCanvaConnection.id })
	if (updated.length === 0) {
		// A concurrent refresh won; ours is the spare. Use what it stored.
		const latest = await readTokens(owner)
		if (latest) return latest.accessToken
		throw new CanvaError('unauthorized', 'Canva is not connected')
	}
	return tokens.accessToken
}

/**
 * Runs `work` with this member's Canva API, refreshing the access token
 * first when it is about to run out. If Canva refuses the token anyway, it
 * refreshes and runs `work` again, unless the work is not `idempotent` (an
 * import that may already have made a design): then it refreshes and fails,
 * so the member decides whether to try again.
 */
export async function withCanva<T>(
	owner: Owner,
	work: (api: CanvaApi) => Promise<T>,
	options: { idempotent?: boolean } = {},
): Promise<T> {
	const current = await readTokens(owner)
	if (!current) throw new CanvaError('unauthorized', 'Canva is not connected')
	let accessToken =
		current.row.expiresAt.getTime() - Date.now() < REFRESH_MARGIN_MS
			? await refresh(owner, current)
			: current.accessToken
	try {
		return await work(canvaApi(accessToken))
	} catch (error) {
		if (!(error instanceof CanvaError) || error.code !== 'unauthorized') {
			throw error
		}
		const latest = await readTokens(owner)
		if (!latest) throw error
		accessToken = await refresh(owner, latest)
		if (options.idempotent === false) {
			throw new CanvaError('unavailable', 'Canva refused the token once')
		}
		return work(canvaApi(accessToken))
	}
}
