import { ApiError, unauthorizedError } from '../api/api-error'
import { type CustomerProfile, type VerifyResult } from '../api/public-site'
import { type TenantApiClient } from '../api/tenant-api-client'
import { isValidPhone, normalizePhone } from '../support/phone-number'
import {
	type AuthTokens,
	firstName,
	tokenName,
	tokenOrgId,
} from './auth-tokens'
import { type TokenStorage } from './token-storage'

/**
 * The customer's tenant-api session for one organization: a short-lived access
 * token plus a rotating refresh token, with one transparent retry after a 401
 * (the browser does the same in apps/sites/src/lib/client-auth.ts).
 */
export class CustomerSession {
	readonly client: TenantApiClient
	readonly #storage: TokenStorage
	#tokens: AuthTokens | null = null
	/**
	 * One refresh shared by every caller: tenant-api rotates refresh tokens and
	 * revokes the family when one is replayed, so two parallel refreshes would
	 * sign the customer out.
	 */
	#refresh: { id: number; promise: Promise<AuthTokens> } | null = null
	#nextRefreshId = 0
	/** Bumped on sign-out, so a refresh already in flight cannot restore the ended session. */
	#generation = 0
	/** Verifications whose answer has not been stored yet. */
	#verifying = 0
	/** Storage writes in call order, so a late write never resurrects cleared tokens. */
	#writes: Promise<unknown> = Promise.resolve()
	readonly #listeners = new Set<() => void>()

	constructor(client: TenantApiClient, storage: TokenStorage) {
		this.client = client
		this.#storage = storage
	}

	get tokens(): AuthTokens | null {
		return this.#tokens
	}

	get isSignedIn(): boolean {
		return this.#tokens !== null
	}

	get customerName(): string | null {
		return this.#tokens ? tokenName(this.#tokens) : null
	}

	get customerFirstName(): string | null {
		return firstName(this.customerName)
	}

	/** Called whenever the tokens change, including when a dead refresh token ends the session. */
	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener)
		return () => {
			this.#listeners.delete(listener)
		}
	}

	/** Loads the stored session (call on launch). */
	async restore(): Promise<AuthTokens | null> {
		if (this.#tokens) return this.#tokens
		const generation = this.#generation
		const stored = await this.#storage.load()
		if (generation === this.#generation && !this.#tokens && stored) {
			this.#tokens = stored
			this.#notify()
		}
		return this.#tokens
	}

	async sendCode(phone: string): Promise<void> {
		const normalized = normalizePhone(phone)
		if (!isValidPhone(normalized)) {
			throw new ApiError(400, 'Enter a valid phone number.', 'invalid_phone')
		}
		await this.client.sendCode(normalized)
	}

	async verify(phone: string, code: string): Promise<VerifyResult> {
		const generation = this.#generation
		this.#verifying += 1
		try {
			const result = await this.client.verify(
				normalizePhone(phone),
				code.trim(),
			)
			if (result.accessToken && result.refreshToken) {
				const tokens = {
					accessToken: result.accessToken,
					refreshToken: result.refreshToken,
				}
				if (!(await this.#store(tokens, generation))) {
					// The sign-in was abandoned while the code was checked: revoke the
					// tokens instead of keeping them for the next launch.
					this.#revoke(tokens)
				} else if (generation !== this.#generation) {
					// Abandoned while the tokens were being saved: take them back out
					// of memory and storage, unless a newer sign-in replaced them.
					if (this.#tokens === tokens) await this.#clear()
					this.#revoke(tokens)
				}
			}
			return result
		} finally {
			this.#verifying -= 1
		}
	}

	/** A verification still in flight will not sign the customer in. */
	abandonPendingVerification(): void {
		if (!this.#tokens || this.#verifying > 0) this.#generation += 1
	}

	/**
	 * Ends the session on the device right away; revoking the refresh token on
	 * the server is best effort and does not hold the caller up when offline.
	 */
	async signOut(): Promise<void> {
		this.#generation += 1
		this.#refresh = null
		const tokens = this.#tokens
		await this.#clear()
		if (tokens) this.#revoke(tokens)
	}

	/**
	 * Forgets the session on this device only. For tokens issued to another
	 * organization: that organization may live in another region, and its
	 * refresh token must never be sent to this organization's node.
	 */
	async discardLocal(): Promise<void> {
		this.#generation += 1
		this.#refresh = null
		await this.#clear()
	}

	#revoke(tokens: AuthTokens): void {
		void this.client.logout(tokens.refreshToken, tokenOrgId(tokens))
	}

	/** Runs an authenticated call, refreshing the access token once on a 401. */
	async authorized<T>(
		operation: (accessToken: string) => Promise<T>,
	): Promise<T> {
		const accessToken = this.#tokens?.accessToken
		if (!accessToken) throw unauthorizedError()
		const generation = this.#generation
		try {
			return await operation(accessToken)
		} catch (error) {
			if (!(error instanceof ApiError)) throw error
			if (!error.isUnauthorized) {
				// The organization is gone: refreshing cannot bring the session back.
				if (error.endsSession) await this.#clear(generation)
				throw error
			}
			// Another caller may have refreshed while this call was in flight:
			// retrying with that token avoids a second rotation for a 401 that
			// predates it. A sign-out in the meantime is never retried against.
			const current = this.#tokens?.accessToken
			if (
				generation === this.#generation &&
				current &&
				current !== accessToken
			) {
				return await operation(current)
			}
			// refresh() clears the session only for a terminal auth failure; a
			// transient error must not sign the customer out.
			const refreshed = await this.refresh()
			return await operation(refreshed.accessToken)
		}
	}

	profile(): Promise<CustomerProfile> {
		return this.authorized((token) => this.client.fetchProfile(token))
	}

	/** `email` null or undefined leaves the stored email alone. */
	async updateProfile(
		name: string,
		email?: string | null,
	): Promise<CustomerProfile> {
		const trimmedName = name.trim()
		if (Array.from(trimmedName).length < 2) {
			throw new ApiError(400, 'Name is required.', 'name_required')
		}
		const trimmedEmail = email == null ? undefined : email.trim()
		const generation = this.#generation
		const next = await this.authorized((token) =>
			this.client.updateProfile(trimmedName, trimmedEmail, token),
		)
		// /auth/profile rotates the refresh token.
		const stored = await this.#store(next, generation)
		if (!stored) throw unauthorizedError()
		return this.profile()
	}

	refresh(): Promise<AuthTokens> {
		if (this.#refresh) return this.#refresh.promise
		this.#nextRefreshId += 1
		const id = this.#nextRefreshId
		const promise = this.#performRefresh(this.#generation).finally(() => {
			// Only clear the slot it still holds: a sign-out may have started a newer refresh.
			if (this.#refresh?.id === id) this.#refresh = null
		})
		this.#refresh = { id, promise }
		return promise
	}

	async #performRefresh(generation: number): Promise<AuthTokens> {
		const tokens = this.#tokens
		const orgId = tokens ? tokenOrgId(tokens) : null
		if (!tokens || !orgId) {
			// Nothing can renew this session.
			if (tokens) await this.#clear(generation)
			throw unauthorizedError()
		}
		try {
			// tenant-api rotates refresh tokens; keep the newest.
			const merged = await this.client.refresh(tokens.refreshToken, orgId)
			if (!(await this.#store(merged, generation))) {
				// The customer signed out while this refresh was in flight.
				throw unauthorizedError()
			}
			return merged
		} catch (error) {
			if (error instanceof ApiError && error.endsSession) {
				// The refresh token is dead (expired, revoked or replayed), or the
				// organization no longer exists on this node.
				await this.#clear(generation)
			}
			// Timeouts, offline, 5xx and any other 403 keep the session: it may
			// still be valid once the region or control plane answers again.
			throw error
		}
	}

	/** `false` when the session ended or changed while the caller was in flight. */
	async #store(tokens: AuthTokens, generation?: number): Promise<boolean> {
		if (generation !== undefined && generation !== this.#generation)
			return false
		this.#tokens = tokens
		this.#notify()
		// A failed write only costs the session on the next launch.
		await this.#persist(tokens)
		return true
	}

	async #clear(generation?: number): Promise<void> {
		if (generation !== undefined && generation !== this.#generation) return
		const hadTokens = this.#tokens !== null
		this.#tokens = null
		if (hadTokens) this.#notify()
		await this.#persist(null)
	}

	#notify(): void {
		for (const listener of this.#listeners) listener()
	}

	#persist(tokens: AuthTokens | null): Promise<unknown> {
		const write = this.#writes.then(
			() => this.#storage.save(tokens),
			() => this.#storage.save(tokens),
		)
		this.#writes = write.catch(() => false)
		return this.#writes
	}
}
