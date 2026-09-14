import Foundation
import SwiftUI
import TenantKit

/// Localization plumbing for the SwiftUI layer.
///
/// Translations live in `<locale>.lproj/Localizable.strings` for the same
/// content locales the org Sites app ships (`en`, `ar`, `es`, `fr`, `de`, `zh`).
extension AppLanguage {
	/// Looks the key up in the `.lproj` bundle for this language, falling back to
	/// the main bundle when a translation is missing.
	func string(_ key: String) -> String {
		if
			let path = Bundle.main.path(forResource: code, ofType: "lproj"),
			let bundle = Bundle(path: path)
		{
			let value = bundle.localizedString(forKey: key, value: nil, table: nil)
			if value != key { return value }
		}
		return NSLocalizedString(key, comment: "")
	}

	func format(_ key: String, _ arguments: CVarArg...) -> String {
		String(format: string(key), arguments: arguments)
	}
}

private struct AppLanguageKey: EnvironmentKey {
	static let defaultValue = AppLanguage(code: "en")
}

extension EnvironmentValues {
	var appLanguage: AppLanguage {
		get { self[AppLanguageKey.self] }
		set { self[AppLanguageKey.self] = newValue }
	}
}

/// Languages this build actually ships translations for.
enum AppLocalizations {
	static var available: [String] {
		let shipped = Bundle.main.localizations
			.map { SiteLocale.normalized($0) }
			.filter { SiteLocale.contentLocales.contains($0) }
		let unique = Array(Set(shipped))
		return unique.isEmpty ? ["en"] : SiteLocale.contentLocales.filter { unique.contains($0) }
	}
}
