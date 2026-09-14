import Foundation

/// How the app is bound to one tenant (org).
///
/// Sites resolves the org from the request `Host`; a native app has no host, so
/// the binding is captured here and sent to tenant-api as `slug`/`host` plus —
/// in production — an `Origin` header equal to the tenant's public site origin.
/// That keeps tenant-api's existing origin↔org binding rules intact: the app can
/// only ever authenticate customers of the org whose site it claims to be.
public struct SiteAddress: Equatable, Sendable {
	public let slug: String?
	public let host: String?
	public let origin: URL?

	public init(slug: String? = nil, host: String? = nil, origin: URL? = nil) {
		self.slug = slug
		self.host = host
		self.origin = origin
	}

	/// The `Origin` header is only meaningful (and only accepted by tenant-api)
	/// for real https origins. Local dev falls back to slug/host binding, which
	/// tenant-api allows outside production.
	public var authOriginHeader: String? {
		guard let origin, origin.scheme?.lowercased() == "https" else { return nil }
		return origin.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
	}

	/// Whether this address actually binds the app to one tenant.
	public var isBound: Bool {
		!(slug ?? "").isEmpty || !(host ?? "").isEmpty
	}

	/// Picks the binding a running app should use.
	///
	/// A build that ships bound to one tenant (white-label) always wins: the
	/// tenant is baked into the binary, so an address the customer typed into an
	/// earlier un-branded install must not silently re-point the app at another
	/// tenant. Un-branded builds keep whatever the customer chose before.
	public static func resolve(build: SiteAddress, stored: SiteAddress?) -> SiteAddress {
		if build.isBound { return build }
		return stored ?? build
	}

	public var queryItems: [URLQueryItem] {
		var items: [URLQueryItem] = []
		if let host, !host.isEmpty {
			items.append(URLQueryItem(name: "host", value: host))
		} else if let slug, !slug.isEmpty {
			items.append(URLQueryItem(name: "slug", value: slug))
		}
		return items
	}

	/// Parses what a customer types on the "connect to your site" screen:
	/// `acme`, `acme.epic-startup.com`, `https://www.acme.com`, `acme.localhost:3010`.
	public static func parse(_ input: String, brandDomain: String) -> SiteAddress? {
		var value = input.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
		guard !value.isEmpty else { return nil }

		var scheme = "https"
		if let range = value.range(of: "://") {
			scheme = String(value[value.startIndex..<range.lowerBound])
			value = String(value[range.upperBound...])
		}
		value = value.split(separator: "/").first.map(String.init) ?? value
		value = value.split(separator: "?").first.map(String.init) ?? value
		value = value.trimmingCharacters(in: .whitespacesAndNewlines)
		guard !value.isEmpty else { return nil }

		let brand = brandDomain.lowercased()
		let hostname = value.split(separator: ":").first.map(String.init) ?? value

		if !hostname.contains(".") {
			// Bare slug → derive the site origin from the platform domain.
			let slug = hostname
			guard !slug.isEmpty else { return nil }
			let origin = URL(string: "https://\(slug).\(brand)")
			return SiteAddress(slug: slug, host: nil, origin: origin)
		}

		guard let origin = URL(string: "\(scheme)://\(value)") else { return nil }
		if hostname.hasSuffix(".\(brand)") {
			let slug = String(hostname.dropLast(brand.count + 1))
			guard !slug.isEmpty, !slug.contains(".") else {
				return SiteAddress(slug: nil, host: hostname, origin: origin)
			}
			return SiteAddress(slug: slug, host: nil, origin: origin)
		}
		return SiteAddress(slug: nil, host: hostname, origin: origin)
	}

	public var displayName: String {
		host ?? slug ?? "your site"
	}
}
