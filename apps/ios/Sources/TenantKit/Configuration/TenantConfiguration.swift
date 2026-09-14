import Foundation

#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// How the app reaches the platform.
///
/// Values come from the target's `Info.plist`, which is filled from
/// `Config/Shared.xcconfig` (so a build can be pointed at any environment
/// without touching Swift code).
public struct TenantConfiguration: Equatable, Sendable {
	/// US control-plane App origin — public Sites payloads (`/resources/sites`).
	public var appBaseURL: URL
	/// Regional tenant-api nodes that own customer PII.
	public var tenantAPIBaseURLUS: URL
	public var tenantAPIBaseURLKSA: URL?
	/// Which tenant this build is bound to (empty = ask the customer).
	public var siteAddress: SiteAddress
	public var brandDomain: String
	public var requestTimeout: TimeInterval
	/// `us` | `ksa` — set from the org payload; customer PII never leaves its region.
	public var dataRegion: String

	public init(
		appBaseURL: URL,
		tenantAPIBaseURLUS: URL,
		tenantAPIBaseURLKSA: URL? = nil,
		siteAddress: SiteAddress = SiteAddress(),
		brandDomain: String = "epic-startup.com",
		requestTimeout: TimeInterval = 15,
		dataRegion: String = "us"
	) {
		self.appBaseURL = appBaseURL
		self.tenantAPIBaseURLUS = tenantAPIBaseURLUS
		self.tenantAPIBaseURLKSA = tenantAPIBaseURLKSA
		self.siteAddress = siteAddress
		self.brandDomain = brandDomain
		self.requestTimeout = requestTimeout
		self.dataRegion = dataRegion
	}

	public var isBoundToTenant: Bool {
		!(siteAddress.slug ?? "").isEmpty || !(siteAddress.host ?? "").isEmpty
	}

	/// The regional tenant-api node that owns this org's customer data.
	public var tenantAPIBaseURL: URL {
		tenantAPIBaseURL(forDataRegion: dataRegion)
	}

	public func tenantAPIBaseURL(forDataRegion region: String) -> URL {
		let normalized = region.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
		if normalized == "ksa", let ksa = tenantAPIBaseURLKSA {
			return ksa
		}
		return tenantAPIBaseURLUS
	}

	/// Local development defaults, matching `.env.schema` in `apps/sites`.
	public static let localDevelopment = TenantConfiguration(
		appBaseURL: URL(string: "http://localhost:3001")!,
		tenantAPIBaseURLUS: URL(string: "http://localhost:3007")!,
		tenantAPIBaseURLKSA: URL(string: "http://localhost:3009")!,
		siteAddress: SiteAddress(),
		brandDomain: "epic-startup.test"
	)

	/// Reads `YES`/`NO` strings (xcconfig substitution) as well as real booleans.
	private static func boolean(_ value: Any?) -> Bool? {
		switch value {
		case let number as NSNumber: return number.boolValue
		case let text as String:
			switch text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
			case "yes", "true", "1": return true
			case "no", "false", "0", "": return false
			default: return nil
			}
		default: return nil
		}
	}

	public static func from(infoDictionary: [String: Any]?) -> TenantConfiguration {
		let info = infoDictionary ?? [:]
		let fallback = TenantConfiguration.localDevelopment
		let useTLS = boolean(info["EpicUseTLS"]) ?? true
		let scheme = useTLS ? "https" : "http"

		func url(_ key: String, fallback fallbackURL: URL?) -> URL? {
			guard let raw = info[key] as? String else { return fallbackURL }
			let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
			guard !trimmed.isEmpty else { return fallbackURL }
			if trimmed.contains("://") { return URL(string: trimmed) }
			return URL(string: "\(scheme)://\(trimmed)")
		}

		func string(_ key: String) -> String? {
			guard let raw = info[key] as? String else { return nil }
			let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
			return trimmed.isEmpty ? nil : trimmed
		}

		let brandDomain = string("EpicBrandDomain") ?? fallback.brandDomain
		let slug = string("EpicSiteSlug")
		let host = string("EpicSiteHost")
		let origin = url("EpicSiteOrigin", fallback: nil)

		return TenantConfiguration(
			appBaseURL: url("EpicAppBaseURL", fallback: fallback.appBaseURL) ?? fallback.appBaseURL,
			tenantAPIBaseURLUS: url("EpicTenantAPIUSBaseURL", fallback: fallback.tenantAPIBaseURLUS)
				?? fallback.tenantAPIBaseURLUS,
			tenantAPIBaseURLKSA: url("EpicTenantAPIKSABaseURL", fallback: fallback.tenantAPIBaseURLKSA),
			siteAddress: SiteAddress(slug: slug, host: host, origin: origin),
			brandDomain: brandDomain,
			requestTimeout: (info["EpicRequestTimeout"] as? NSNumber)?.doubleValue ?? fallback.requestTimeout
		)
	}
}
