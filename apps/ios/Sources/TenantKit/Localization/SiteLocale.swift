import Foundation

/// Content locales shared with the org Sites app (`packages/common/src/site-locales.ts`).
public enum SiteLocale {
	public static let contentLocales = ["en", "ar", "es", "fr", "de", "zh"]

	public static let labels: [String: String] = [
		"en": "English",
		"ar": "Arabic",
		"es": "Spanish",
		"fr": "French",
		"de": "German",
		"zh": "Chinese",
	]

	/// Matches `RTL_SITE_LOCALES` on the web side.
	public static let rtlLocales: Set<String> = ["ar"]

	public static func isSupported(_ code: String) -> Bool {
		contentLocales.contains(normalized(code))
	}

	public static func label(_ code: String) -> String {
		labels[normalized(code)] ?? code
	}

	public static func isRTL(_ code: String) -> Bool {
		rtlLocales.contains(normalized(code))
	}

	/// `"ar-SA"` → `"ar"`, `"EN"` → `"en"`.
	public static func normalized(_ code: String) -> String {
		let trimmed = code.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
		guard !trimmed.isEmpty else { return "en" }
		return trimmed.split(separator: "-").first.map(String.init) ?? trimmed
	}

	/// Mirrors `negotiateSiteLocale()`: exact match first, then language-only.
	/// Returns `nil` when nothing matches (callers decide the fallback).
	public static func match(preferred: [String], supported: [String]) -> String? {
		let candidates = supported.map { normalized($0) }

		for preference in preferred {
			let exact = preference.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
			guard !exact.isEmpty else { continue }
			let base = exact.split(separator: "-").first.map(String.init) ?? exact
			if let match = candidates.first(where: { $0 == exact }) ?? candidates.first(where: { $0 == base }) {
				return match
			}
		}

		return nil
	}

	/// Mirrors `negotiateSiteLocale()`: exact match, then language-only, then the
	/// org default, then the first supported locale.
	public static func negotiate(
		preferred: [String],
		supported: [String],
		defaultLocale: String
	) -> String {
		if let match = match(preferred: preferred, supported: supported) { return match }

		let candidates = supported.map { normalized($0) }
		let fallback = normalized(defaultLocale)
		if candidates.contains(fallback) { return fallback }
		return candidates.first ?? "en"
	}
}

/// The language the app UI renders in.
///
/// Resolution order:
/// 1. an explicit customer override (Profile → Language),
/// 2. the device's preferred languages, when the app has that translation,
/// 3. the locale the org negotiated for this device (the `locale` field of the
///    `/resources/sites` payload) — so a KSA tenant still gets Arabic chrome on
///    a phone set to a language we do not ship,
/// 4. the org's default locale, then English.
public struct AppLanguage: Equatable, Sendable {
	public let code: String

	public init(code: String = "en") {
		self.code = SiteLocale.normalized(code)
	}

	public var isRTL: Bool { SiteLocale.isRTL(code) }

	public var displayName: String { SiteLocale.label(code) }

	/// Locale identifier for `Foundation`/SwiftUI formatting (numbers, dates, RTL).
	public var locale: Locale { Locale(identifier: code) }

	public static func resolve(
		organization: PublicOrganization?,
		deviceLanguages: [String],
		appLocales: [String],
		override: String? = nil
	) -> AppLanguage {
		let supported = appLocales.isEmpty ? SiteLocale.contentLocales : appLocales
		let translated = supported.map { SiteLocale.normalized($0) }

		if let override, !override.isEmpty {
			return AppLanguage(
				code: SiteLocale.negotiate(preferred: [override], supported: supported, defaultLocale: "en")
			)
		}

		let deviceMatch = SiteLocale.match(preferred: deviceLanguages, supported: translated)
		if let deviceMatch {
			return AppLanguage(code: deviceMatch)
		}

		if let organization {
			let orgMatch = SiteLocale.negotiate(
				preferred: [organization.resolvedLocale, organization.resolvedDefaultLocale],
				supported: translated,
				defaultLocale: "en"
			)
			return AppLanguage(code: orgMatch)
		}

		return AppLanguage(code: "en")
	}
}
