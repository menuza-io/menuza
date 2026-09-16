package com.epicstartup.tenant.core.session

import com.epicstartup.tenant.core.model.AuthTokens

/**
 * Where the customer's tenant-api tokens live.
 *
 * The web app keeps these in `localStorage` so a US Sites render never touches
 * KSA PII. On Android the equivalent is the Keystore (see
 * `KeystoreTokenStorage`): tokens are stored on the device, never sent to the
 * control plane.
 */
interface TokenStorage {
	fun load(): AuthTokens?

	/**
	 * Returns `false` when the tokens could not be persisted (for example a
	 * Keystore error). Callers keep the in-memory session either way.
	 */
	fun save(tokens: AuthTokens?): Boolean
}

/** Test/fallback storage. Not used by the shipping app. */
class InMemoryTokenStorage(initial: AuthTokens? = null) : TokenStorage {
	@Volatile
	private var tokens: AuthTokens? = initial

	override fun load(): AuthTokens? = tokens

	override fun save(tokens: AuthTokens?): Boolean {
		this.tokens = tokens
		return true
	}
}
