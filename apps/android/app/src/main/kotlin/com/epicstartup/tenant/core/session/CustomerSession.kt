package com.epicstartup.tenant.core.session

import com.epicstartup.tenant.core.model.AuthTokens
import com.epicstartup.tenant.core.model.CustomerProfile
import com.epicstartup.tenant.core.model.VerifyResult
import com.epicstartup.tenant.core.net.ApiException
import com.epicstartup.tenant.core.net.TenantApiClient
import com.epicstartup.tenant.core.support.PhoneNumber
import java.util.concurrent.CancellationException
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ExecutionException

/**
 * Owns the customer's tenant-api session for one org.
 *
 * Mirrors the browser behaviour in `apps/sites/src/lib/client-auth.ts` and the
 * iOS `CustomerSession`: a short-lived access token (15 min) plus a rotating
 * refresh token, with a single transparent retry when tenant-api answers `401`.
 *
 * All calls block (the UI layer runs them on a background executor); the refresh
 * itself is coalesced so parallel callers share one rotation — tenant-api
 * revokes the whole family when a refresh token is replayed.
 */
class CustomerSession(
	private val client: TenantApiClient,
	private val storage: TokenStorage = InMemoryTokenStorage(),
) {
	private val lock = Any()

	@Volatile
	private var currentTokens: AuthTokens? = storage.load()

	/** One in-flight refresh shared by every caller. */
	private var refreshFuture: CompletableFuture<AuthTokens>? = null

	/**
	 * Bumped on sign-out so a refresh that was already in flight cannot write
	 * rotated tokens back into a session the customer just ended.
	 */
	@Volatile
	private var sessionGeneration = 0

	val tokens: AuthTokens? get() = currentTokens

	val isSignedIn: Boolean get() = currentTokens != null

	val customerName: String? get() = currentTokens?.name

	val customerFirstName: String? get() = currentTokens?.firstName

	/** Loads a previously stored session (call on launch). */
	fun restore(): AuthTokens? {
		if (currentTokens == null) currentTokens = storage.load()
		return currentTokens
	}

	// MARK: - Auth flows

	fun sendCode(phone: String) {
		val normalized = PhoneNumber.normalize(phone)
		if (!PhoneNumber.isValid(normalized)) {
			throw ApiException(400, "Enter a valid phone number.")
		}
		client.sendCode(normalized)
	}

	fun verify(phone: String, code: String): VerifyResult {
		val result = client.verify(PhoneNumber.normalize(phone), code.trim())
		val accessToken = result.accessToken
		if (!accessToken.isNullOrEmpty()) {
			store(AuthTokens(accessToken = accessToken, refreshToken = result.refreshToken))
		}
		return result
	}

	fun signOut() {
		val previous = endSession()
		client.logout(previous?.refreshToken, previous?.orgId)
	}

	/**
	 * Ends the session without telling tenant-api: used when the stored session
	 * belongs to another tenant, whose credentials must not be sent to *this*
	 * org's regional node (that node may be in the other region).
	 */
	fun clearLocalSession(): AuthTokens? = endSession()

	/**
	 * Ends the session in a single locked step: the generation bump, the
	 * in-memory clear, and the persisted clear happen together, so a refresh
	 * that was already in flight cannot pass its generation check and write
	 * rotated tokens back (in memory or on disk) after the customer left.
	 */
	private fun endSession(): AuthTokens? = synchronized(lock) {
		sessionGeneration += 1
		refreshFuture?.cancel(false)
		refreshFuture = null
		val previous = currentTokens
		currentTokens = null
		storage.save(null)
		previous
	}

	// MARK: - Authorized calls

	/**
	 * Runs an authenticated request, refreshing the access token once on `401`.
	 */
	fun <T> authorized(operation: (String) -> T): T {
		val accessToken = currentTokens?.accessToken ?: throw ApiException.unauthorized()
		val generation = sessionGeneration
		return try {
			operation(accessToken)
		} catch (error: ApiException) {
			if (!error.isUnauthorized) throw error
			// Another caller may have refreshed while this request was in flight.
			// Retrying with that rotated token avoids a redundant refresh (and a
			// second rotation) for a 401 that predates it. A sign-out in the
			// meantime must not be retried against, though.
			val current = currentTokens?.accessToken
			if (generation == sessionGeneration && current != null && current != accessToken) {
				return operation(current)
			}
			// `refresh()` clears the session only for a terminal auth failure and
			// rethrows transient errors, which must not sign the customer out.
			val refreshed = refresh()
			operation(refreshed.accessToken)
		}
	}

	fun profile(): CustomerProfile = authorized { client.fetchProfile(it) }

	fun updateProfile(name: String, email: String?): CustomerProfile {
		val trimmedName = name.trim()
		if (trimmedName.length < 2) throw ApiException(400, "Name is required.")
		val trimmedEmail = email?.trim()
		val generation = sessionGeneration
		val next = authorized { token ->
			client.updateProfile(name = trimmedName, email = trimmedEmail, accessToken = token)
		}
		// `/auth/profile` rotates the refresh token; keep the current one if the
		// response omits it so the session can still be refreshed. Like a
		// refresh, a response that lands after the customer signed out must not
		// adopt its tokens.
		val stored = store(
			AuthTokens(
				accessToken = next.accessToken,
				refreshToken = next.refreshToken ?: currentTokens?.refreshToken,
			),
			generation,
		)
		if (!stored) throw ApiException.unauthorized()
		return profile()
	}

	// MARK: - Refresh

	fun refresh(): AuthTokens {
		val future: CompletableFuture<AuthTokens>
		val owner: Boolean
		synchronized(lock) {
			val existing = refreshFuture
			if (existing != null) {
				future = existing
				owner = false
			} else {
				future = CompletableFuture()
				refreshFuture = future
				owner = true
			}
		}

		if (!owner) return await(future)

		val generation = sessionGeneration
		return try {
			val refreshed = performRefresh(generation)
			future.complete(refreshed)
			refreshed
		} catch (error: Throwable) {
			future.completeExceptionally(error)
			throw error
		} finally {
			// Only clears the slot when it still holds this refresh: sign-out may
			// already have installed a newer one, which must not be discarded.
			synchronized(lock) {
				if (refreshFuture === future) refreshFuture = null
			}
		}
	}

	private fun performRefresh(generation: Int): AuthTokens {
		val tokens = currentTokens
		val refreshToken = tokens?.refreshToken ?: throw ApiException.unauthorized()
		val orgId = tokens.orgId ?: throw ApiException.unauthorized()

		return try {
			val refreshed = client.refresh(refreshToken = refreshToken, orgId = orgId)
			// tenant-api rotates refresh tokens; keep the newest one.
			val merged = AuthTokens(
				accessToken = refreshed.accessToken,
				refreshToken = refreshed.refreshToken ?: refreshToken,
			)
			if (!store(merged, generation)) {
				// The customer signed out while this refresh was in flight.
				throw ApiException.unauthorized()
			}
			merged
		} catch (error: ApiException) {
			if (error.isUnauthorized || error.statusCode == 403) {
				// The refresh token is dead (expired, revoked, or replayed).
				clearTokens(generation)
			}
			throw error
		}
		// Timeout, offline, 5xx: the session may still be valid, so keep it.
	}

	/**
	 * Returns `false` when the session ended (or was replaced) while the caller
	 * was in flight, in which case the tokens must not be adopted.
	 *
	 * The in-memory update and the persisted write share the lock with
	 * [endSession], so a sign-out cannot be undone by a save that lands late.
	 * A Keystore failure only costs the session on next launch; the customer
	 * stays signed in for this run rather than being dropped mid-flow.
	 */
	private fun store(tokens: AuthTokens, generation: Int? = null): Boolean {
		synchronized(lock) {
			if (generation != null && generation != sessionGeneration) return false
			currentTokens = tokens
			storage.save(tokens)
		}
		return true
	}

	private fun clearTokens(generation: Int? = null) {
		synchronized(lock) {
			if (generation != null && generation != sessionGeneration) return
			currentTokens = null
			storage.save(null)
		}
	}

	/** Waits for the in-flight refresh, unwrapping its failure. */
	private fun await(future: CompletableFuture<AuthTokens>): AuthTokens = try {
		future.get()
	} catch (error: ExecutionException) {
		// Rethrow what the owner saw — an `ApiException` carries the status the
		// caller needs (401 clears the session, 5xx is transient) and would
		// otherwise be flattened into a transport failure.
		throw error.cause ?: ApiException(0, "Network error")
	} catch (error: CancellationException) {
		throw ApiException.unauthorized()
	} catch (error: InterruptedException) {
		Thread.currentThread().interrupt()
		throw ApiException(0, "Request interrupted")
	}
}
