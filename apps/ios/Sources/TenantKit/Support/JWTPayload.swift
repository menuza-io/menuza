import Foundation

/// Reads the (already verified server-side) access-token claims the browser app
/// also reads in `apps/sites/src/lib/client-auth.ts`.
///
/// The token is a JWT signed by tenant-api; the app only *reads* claims for UI
/// (name, org id) and never trusts them for authorization.
public struct JWTPayload: Equatable, Sendable {
	public let customerId: String?
	public let orgId: String?
	public let orgSlug: String?
	public let name: String?
	public let expiresAt: Date?

	public init(
		customerId: String? = nil,
		orgId: String? = nil,
		orgSlug: String? = nil,
		name: String? = nil,
		expiresAt: Date? = nil
	) {
		self.customerId = customerId
		self.orgId = orgId
		self.orgSlug = orgSlug
		self.name = name
		self.expiresAt = expiresAt
	}

	public var isExpired: Bool {
		guard let expiresAt else { return false }
		return expiresAt.timeIntervalSinceNow <= 0
	}

	public static func decode(_ token: String) -> JWTPayload? {
		let segments = token.split(separator: ".", omittingEmptySubsequences: false)
		guard segments.count >= 2 else { return nil }
		guard let data = base64URLDecode(String(segments[1])) else { return nil }
		guard
			let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
		else {
			return nil
		}

		func string(_ key: String) -> String? {
			if let value = object[key] as? String, !value.isEmpty { return value }
			return nil
		}

		var expiresAt: Date?
		if let exp = object["exp"] as? Double {
			expiresAt = Date(timeIntervalSince1970: exp)
		} else if let exp = object["exp"] as? Int {
			expiresAt = Date(timeIntervalSince1970: Double(exp))
		}

		return JWTPayload(
			customerId: string("customerId") ?? string("sub"),
			orgId: string("orgId"),
			orgSlug: string("orgSlug"),
			name: string("name"),
			expiresAt: expiresAt
		)
	}

	public static func base64URLDecode(_ value: String) -> Data? {
		var base64 = value
			.replacingOccurrences(of: "-", with: "+")
			.replacingOccurrences(of: "_", with: "/")
		let remainder = base64.count % 4
		if remainder > 0 {
			base64 += String(repeating: "=", count: 4 - remainder)
		}
		return Data(base64Encoded: base64, options: [.ignoreUnknownCharacters])
	}
}
