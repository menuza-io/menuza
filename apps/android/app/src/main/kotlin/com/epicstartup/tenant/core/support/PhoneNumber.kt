package com.epicstartup.tenant.core.support

/**
 * Phone handling that matches tenant-api's `normalizePhone()` so the same
 * number hashes to the same customer record on every client.
 */
object PhoneNumber {

	/** Mirrors `phone.replace(/[\s\-()]/g, '')` in `apps/tenant-api/src/routes/auth.ts`. */
	fun normalize(phone: String): String =
		phone.filter { !it.isWhitespace() && it != '-' && it != '(' && it != ')' }

	/**
	 * ASCII digits only, ignoring a single leading `+`. `Char.isDigit()` would
	 * also accept Arabic-Indic digits, which the OTP path cannot process.
	 */
	private fun digits(normalized: String): String {
		val withoutPrefix = normalized.removePrefix("+")
		return withoutPrefix.filter { it in '0'..'9' }
	}

	/**
	 * tenant-api only requires five characters, but a value with letters or
	 * punctuation would be rejected by the SMS provider, so the app gates the
	 * "send code" button on a plausible E.164-ish number.
	 */
	fun isValid(phone: String): Boolean {
		val normalized = normalize(phone)
		val digits = digits(normalized)
		if (digits.length !in 5..15) return false
		// Reject anything the digits do not account for (letters, stray symbols).
		return digits.length == normalized.length - (if (normalized.startsWith("+")) 1 else 0)
	}

	/**
	 * Country calling codes we format for display. Longest prefix wins, so `966`
	 * beats `9`; an unknown prefix leaves the number ungrouped rather than
	 * guessing (a wrong split is worse than no grouping).
	 */
	private val countryCodes: List<String> = listOf(
		"1", "20", "27", "33", "34", "39", "44", "49", "52", "55", "60", "61",
		"62", "65", "66", "81", "82", "84", "86", "90", "91", "92", "94", "95",
		"98", "212", "234", "254", "351", "352", "353", "358", "380", "420",
		"421", "852", "880", "962", "964", "965", "966", "968", "971", "972",
	).sortedByDescending { it.length }

	/** Formats a normalized number for display without changing its digits. */
	fun display(phone: String): String {
		val normalized = normalize(phone)
		if (!normalized.startsWith("+")) return normalized

		val national = normalized.drop(1)
		val countryCode = countryCodes.firstOrNull { national.startsWith(it) } ?: return normalized
		val rest = national.drop(countryCode.length)
		if (rest.length <= 3) return normalized

		val groups = mutableListOf<String>()
		var remaining = rest
		while (remaining.length > 4) {
			groups += remaining.take(3)
			remaining = remaining.drop(3)
		}
		if (remaining.isNotEmpty()) groups += remaining
		return "+$countryCode " + groups.joinToString(" ")
	}
}
