import Foundation

/// The org's resolved branding: colors, corner radius, and typography.
///
/// This is the native equivalent of the `data-site-theme` attributes and
/// `--token` CSS variables that `apps/sites` injects into every page.
public struct SiteTheme: Equatable, Sendable {
	public let tokens: SiteThemeTokens
	/// `light` | `dark` | `system`
	public let mode: String
	public let baseColor: String?
	public let themeName: String?
	public let headingFontID: String
	public let bodyFontID: String
	public let headingCustomFontURL: URL?
	public let bodyCustomFontURL: URL?

	public init(theme: PublicSiteTheme?) {
		self.tokens = SiteThemeTokens.parse(css: theme?.css ?? "")
		self.mode = (theme?.mode?.isEmpty == false ? theme?.mode : nil) ?? "system"
		self.baseColor = theme?.baseColor
		self.themeName = theme?.theme
		self.headingFontID = (theme?.headingFont?.isEmpty == false ? theme?.headingFont : nil) ?? "inter"
		self.bodyFontID = (theme?.bodyFont?.isEmpty == false ? theme?.bodyFont : nil) ?? "inter"
		self.headingCustomFontURL = Self.makeURL(theme?.headingCustomFont?.url)
		self.bodyCustomFontURL = Self.makeURL(theme?.bodyCustomFont?.url)
	}

	private static func makeURL(_ value: String?) -> URL? {
		guard let value, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
			return nil
		}
		return URL(string: value)
	}

	public static let fallback = SiteTheme(theme: nil)

	public func resolvedScheme(systemIsDark: Bool) -> SiteColorScheme {
		switch mode.lowercased() {
		case "dark": return .dark
		case "light": return .light
		default: return systemIsDark ? .dark : .light
		}
	}

	public func color(_ token: SiteColorToken, scheme: SiteColorScheme) -> RGBAColor {
		tokens.color(token, scheme: scheme) ?? SiteThemeDefaults.color(token, scheme: scheme)
	}

	/// CSS `--radius` (rem) → points. Mirrors `rounded-[var(--radius)]` and
	/// `rounded-[calc(var(--radius)*0.7)]` in the Astro components.
	public func radius(scale: Double = 1) -> Double {
		let rem = tokens.radiusRem ?? 0.625
		return rem * 16 * scale
	}

	/// Best-effort mapping from a Sites font id to an iOS font family.
	/// Fonts that are not installed fall back to the system font — the app never
	/// downloads remote fonts, so rendering stays instant and offline-safe.
	public func fontFamily(for role: SiteFontRole) -> String? {
		let id = role == .heading ? headingFontID : bodyFontID
		return SiteTheme.knownFontFamilies[id]
	}

	public static let knownFontFamilies: [String: String] = [
		"geist": "Geist",
		"inter": "Inter",
		"noto-sans": "Noto Sans",
		"nunito-sans": "Nunito Sans",
		"figtree": "Figtree",
		"roboto": "Roboto",
		"raleway": "Raleway",
		"dm-sans": "DM Sans",
		"public-sans": "Public Sans",
		"outfit": "Outfit",
		"oxanium": "Oxanium",
		"manrope": "Manrope",
		"space-grotesk": "Space Grotesk",
		"montserrat": "Montserrat",
		"ibm-plex-sans": "IBM Plex Sans",
		"source-sans-3": "Source Sans 3",
		"instrument-sans": "Instrument Sans",
		"noto-serif": "Noto Serif",
		"roboto-slab": "Roboto Slab",
		"merriweather": "Merriweather",
		"lora": "Lora",
		"jetbrains-mono": "JetBrains Mono",
		"geist-mono": "Geist Mono",
	]
}

public enum SiteFontRole: Equatable, Sendable {
	case heading
	case body
}
