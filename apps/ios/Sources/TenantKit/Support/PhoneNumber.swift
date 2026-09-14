import Foundation

/// Phone handling that matches tenant-api's `normalizePhone()` so the same
/// number hashes to the same customer record on both clients.
public enum PhoneNumber {
	/// Mirrors `phone.replace(/[\s\-()]/g, '')` in `apps/tenant-api/src/routes/auth.ts`.
	public static func normalize(_ phone: String) -> String {
		let stripped = phone.filter { character in
			!character.isWhitespace && character != "-" && character != "(" && character != ")"
		}
		return String(stripped)
	}

	/// ASCII digits only, ignoring a single leading `+`. `Character.isNumber`
	/// would also accept Arabic-Indic digits, which the OTP path cannot process.
	private static func digits(_ normalized: String) -> String {
		let withoutPrefix = normalized.hasPrefix("+") ? String(normalized.dropFirst()) : normalized
		return withoutPrefix.filter { $0.isASCII && $0.isNumber }
	}

	/// tenant-api only requires five characters, but a value with letters or
	/// punctuation would be rejected by the SMS provider, so the app gates the
	/// "send code" button on a plausible E.164-ish number.
	public static func isValid(_ phone: String) -> Bool {
		let normalized = normalize(phone)
		let digits = digits(normalized)
		guard digits.count >= 5, digits.count <= 15 else { return false }
		// Reject anything the digits do not account for (letters, stray symbols).
		return digits.count == normalized.count - (normalized.hasPrefix("+") ? 1 : 0)
	}

	/// Country calling codes we format for display. Longest prefix wins, so `966`
	/// beats `9`; an unknown prefix leaves the number ungrouped rather than
	/// guessing (a wrong split is worse than no grouping).
	private static let countryCodes: [String] = [
		"1", "20", "27", "33", "34", "39", "44", "49", "52", "55", "60", "61",
		"62", "65", "66", "81", "82", "84", "86", "90", "91", "92", "94", "95",
		"98", "212", "234", "254", "351", "352", "353", "358", "380", "420",
		"421", "852", "880", "962", "964", "965", "966", "968", "971", "972",
	].sorted { $0.count > $1.count }

	/// Formats a normalized number for display without changing its digits.
	public static func display(_ phone: String) -> String {
		let normalized = normalize(phone)
		guard normalized.hasPrefix("+") else { return normalized }

		let national = String(normalized.dropFirst())
		guard
			let countryCode = countryCodes.first(where: { national.hasPrefix($0) })
		else {
			return normalized
		}

		let rest = Array(national.dropFirst(countryCode.count))
		guard rest.count > 3 else { return normalized }

		var groups: [String] = []
		var remaining = rest
		while remaining.count > 4 {
			groups.append(String(remaining.prefix(3)))
			remaining.removeFirst(3)
		}
		if !remaining.isEmpty { groups.append(String(remaining)) }
		return "+\(countryCode) " + groups.joined(separator: " ")
	}
}
