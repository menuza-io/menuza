import Foundation

// MARK: - Site theme (branding)

public struct PublicSiteCustomFont: Codable, Equatable, Sendable {
	public let url: String
	public let format: String

	public init(url: String, format: String) {
		self.url = url
		self.format = format
	}
}

/// Mirrors `PublicSiteTheme` in `apps/sites/src/lib/org.ts`.
///
/// `css` is the org's compiled shadcn theme (CSS custom properties in `oklch()`),
/// which `SiteThemeTokens.parse(css:)` turns into native colors.
public struct PublicSiteTheme: Codable, Equatable, Sendable {
	public let baseColor: String?
	public let theme: String?
	public let radius: String?
	public let mode: String?
	public let headingFont: String?
	public let bodyFont: String?
	public let headingCustomFont: PublicSiteCustomFont?
	public let bodyCustomFont: PublicSiteCustomFont?
	public let css: String?

	public init(
		baseColor: String? = nil,
		theme: String? = nil,
		radius: String? = nil,
		mode: String? = nil,
		headingFont: String? = nil,
		bodyFont: String? = nil,
		headingCustomFont: PublicSiteCustomFont? = nil,
		bodyCustomFont: PublicSiteCustomFont? = nil,
		css: String? = nil
	) {
		self.baseColor = baseColor
		self.theme = theme
		self.radius = radius
		self.mode = mode
		self.headingFont = headingFont
		self.bodyFont = bodyFont
		self.headingCustomFont = headingCustomFont
		self.bodyCustomFont = bodyCustomFont
		self.css = css
	}
}

public struct PublicSiteAnnouncement: Codable, Equatable, Sendable, Identifiable {
	public let id: String
	public let content: String
	public let type: String
	public let linkUrl: String?
	public let linkLabel: String?
	public let linkNewTab: Bool?

	public init(
		id: String,
		content: String,
		type: String,
		linkUrl: String? = nil,
		linkLabel: String? = nil,
		linkNewTab: Bool? = nil
	) {
		self.id = id
		self.content = content
		self.type = type
		self.linkUrl = linkUrl
		self.linkLabel = linkLabel
		self.linkNewTab = linkNewTab
	}
}

public struct PublicSiteIcon: Codable, Equatable, Sendable {
	public let original: String
	public let favicon32: String?
	public let favicon16: String?
	public let appleTouchIcon: String?
}

/// Mirrors `PublicOrganization` in `apps/sites/src/lib/org.ts` — the payload of
/// `GET {app}/resources/sites?slug=…|host=…`.
///
/// The app uses it purely for branding: name, icon, theme, and locale.
public struct PublicOrganization: Codable, Equatable, Sendable, Identifiable {
	public let id: String
	public let name: String
	public let slug: String
	public let customDomain: String?
	public let dataRegion: String?
	public let theme: PublicSiteTheme?
	public let locales: [String]?
	public let defaultLocale: String?
	public let locale: String?
	public let siteIcon: PublicSiteIcon?
	public let announcements: [PublicSiteAnnouncement]?
	public let facebookPixelId: String?
	public let googleTagManagerId: String?
	public let googleAnalyticsId: String?
	public let tiktokPixelId: String?

	public init(
		id: String,
		name: String,
		slug: String,
		customDomain: String? = nil,
		dataRegion: String? = nil,
		theme: PublicSiteTheme? = nil,
		locales: [String]? = nil,
		defaultLocale: String? = nil,
		locale: String? = nil,
		siteIcon: PublicSiteIcon? = nil,
		announcements: [PublicSiteAnnouncement]? = nil,
		facebookPixelId: String? = nil,
		googleTagManagerId: String? = nil,
		googleAnalyticsId: String? = nil,
		tiktokPixelId: String? = nil
	) {
		self.id = id
		self.name = name
		self.slug = slug
		self.customDomain = customDomain
		self.dataRegion = dataRegion
		self.theme = theme
		self.locales = locales
		self.defaultLocale = defaultLocale
		self.locale = locale
		self.siteIcon = siteIcon
		self.announcements = announcements
		self.facebookPixelId = facebookPixelId
		self.googleTagManagerId = googleTagManagerId
		self.googleAnalyticsId = googleAnalyticsId
		self.tiktokPixelId = tiktokPixelId
	}

	/// Region used to pick the tenant-api node that holds this org's customer data.
	public var resolvedDataRegion: String {
		let value = (dataRegion ?? "us").trimmingCharacters(in: .whitespacesAndNewlines)
		return value.isEmpty ? "us" : value.lowercased()
	}

	public var resolvedLocales: [String] {
		let values = (locales ?? []).filter { !$0.isEmpty }
		return values.isEmpty ? ["en"] : values
	}

	public var resolvedDefaultLocale: String {
		(defaultLocale?.isEmpty == false ? defaultLocale : nil) ?? "en"
	}

	public var resolvedLocale: String {
		(locale?.isEmpty == false ? locale : nil) ?? resolvedDefaultLocale
	}

	/// Absolute URL for the org's site icon (`/resources/images?…` is relative to the App).
	public func iconURL(baseURL: URL) -> URL? {
		guard let original = siteIcon?.original, !original.isEmpty else { return nil }
		if original.hasPrefix("http://") || original.hasPrefix("https://") {
			return URL(string: original)
		}
		let path = original.hasPrefix("/") ? original : "/\(original)"
		return URL(string: path, relativeTo: baseURL)
	}
}

// MARK: - Customer

public struct CustomerProfile: Codable, Equatable, Sendable {
	public let id: String?
	public let name: String?
	public let email: String?
	public let phone: String?
	public let needsName: Bool?

	public init(
		id: String? = nil,
		name: String? = nil,
		email: String? = nil,
		phone: String? = nil,
		needsName: Bool? = nil
	) {
		self.id = id
		self.name = name
		self.email = email
		self.phone = phone
		self.needsName = needsName
	}
}

public struct CustomerProfileEnvelope: Codable, Equatable, Sendable {
	public let customer: CustomerProfile?
}

public struct AuthTokens: Codable, Equatable, Sendable {
	public var accessToken: String
	public var refreshToken: String?

	public init(accessToken: String, refreshToken: String? = nil) {
		self.accessToken = accessToken
		self.refreshToken = refreshToken
	}

	public var orgId: String? {
		JWTPayload.decode(accessToken)?.orgId
	}

	public var customerId: String? {
		JWTPayload.decode(accessToken)?.customerId
	}

	public var name: String? {
		JWTPayload.decode(accessToken)?.name
	}

	public var firstName: String? {
		guard let name, !name.isEmpty else { return nil }
		return name.split(separator: " ").first.map(String.init)
	}
}

public struct VerifyResult: Codable, Equatable, Sendable {
	public let success: Bool?
	public let accessToken: String?
	public let refreshToken: String?
	public let needsName: Bool?
	public let error: String?
}
