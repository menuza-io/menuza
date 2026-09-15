package com.epicstartup.tenant.core.support

/**
 * Reads the (already server-verified) access-token claims the browser app also
 * reads in `apps/sites/src/lib/client-auth.ts`.
 *
 * The token is a JWT signed by tenant-api; the app only *reads* claims for UI
 * (name, org id) and never trusts them for authorization.
 */
data class JwtPayload(
	val customerId: String? = null,
	val orgId: String? = null,
	val orgSlug: String? = null,
	val name: String? = null,
	/** `exp` (seconds since the epoch), when present. */
	val expiresAtSeconds: Long? = null,
) {
	val isExpired: Boolean
		get() = expiresAtSeconds?.let { it * 1000 <= System.currentTimeMillis() } ?: false

	companion object {
		fun decode(token: String): JwtPayload? {
			val segments = token.split('.')
			if (segments.size < 2) return null
			val bytes = base64UrlDecode(segments[1]) ?: return null
			val json = parseJsonObject(bytes) ?: return null

			fun string(key: String): String? {
				val value = json.optString(key, "")
				return value.ifEmpty { null }
			}

			val expiresAt = when (val raw = json.opt("exp")) {
				is Number -> raw.toLong()
				is String -> raw.toLongOrNull()
				else -> null
			}

			return JwtPayload(
				customerId = string("customerId") ?: string("sub"),
				orgId = string("orgId"),
				orgSlug = string("orgSlug"),
				name = string("name"),
				expiresAtSeconds = expiresAt,
			)
		}

		/**
		 * Decodes base64url without `android.util.Base64`, so the session code
		 * stays runnable in plain JVM unit tests.
		 */
		fun base64UrlDecode(value: String): ByteArray? {
			val alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
			val cleaned = value.replace('-', '+').replace('_', '/').filter { !it.isWhitespace() }
			val output = ByteArray(cleaned.length / 4 * 3 + 3)
			var written = 0
			var buffer = 0
			var bits = 0
			for (character in cleaned) {
				if (character == '=') break
				val index = alphabet.indexOf(character)
				if (index < 0) return null
				buffer = (buffer shl 6) or index
				bits += 6
				if (bits >= 8) {
					bits -= 8
					output[written] = ((buffer shr bits) and 0xFF).toByte()
					written += 1
				}
			}
			return output.copyOf(written)
		}
	}
}

/** Convenience: the claims of an access token, or `null` when unreadable. */
fun decodeJwt(token: String): JwtPayload? = JwtPayload.decode(token)
