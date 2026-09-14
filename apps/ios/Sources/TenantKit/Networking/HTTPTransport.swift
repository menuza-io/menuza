import Foundation

#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Transport seam so `TenantAPIClient` and `CustomerSession` are testable without
/// a network (and so the Linux test suite can run without URLSession quirks).
public protocol HTTPTransport: Sendable {
	func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

public struct URLSessionTransport: HTTPTransport {
	private let session: URLSession

	public init(session: URLSession = .shared) {
		self.session = session
	}

	public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
		let (data, response) = try await session.data(for: request)
		guard let http = response as? HTTPURLResponse else {
			throw APIError(statusCode: 0, message: "Unexpected response type")
		}
		return (data, http)
	}
}

/// Errors surfaced by the tenant APIs.
public struct APIError: Error, Equatable, LocalizedError {
	public let statusCode: Int
	public let message: String

	public init(statusCode: Int, message: String) {
		self.statusCode = statusCode
		self.message = message
	}

	public var isUnauthorized: Bool { statusCode == 401 }
	public var isNotFound: Bool { statusCode == 404 }
	public var isRateLimited: Bool { statusCode == 429 }
	public var isTransportFailure: Bool { statusCode == 0 }

	public var errorDescription: String? { message }

	/// tenant-api returns `{ error, error_description? }`; the App returns
	/// `{ error }` or a plain-text 404. Prefer the most specific message.
	public static func from(statusCode: Int, data: Data) -> APIError {
		if let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
			if let description = object["error_description"] as? String, !description.isEmpty {
				return APIError(statusCode: statusCode, message: description)
			}
			if let error = object["error"] as? String, !error.isEmpty {
				return APIError(statusCode: statusCode, message: error)
			}
			if let message = object["message"] as? String, !message.isEmpty {
				return APIError(statusCode: statusCode, message: message)
			}
		}
		let text = String(data: data, encoding: .utf8)?
			.trimmingCharacters(in: .whitespacesAndNewlines)
		if let text, !text.isEmpty, text.count < 200 {
			return APIError(statusCode: statusCode, message: text)
		}
		return APIError(statusCode: statusCode, message: "Request failed (\(statusCode))")
	}

	public static let unauthorized = APIError(statusCode: 401, message: "Please sign in again.")
	public static let notBoundToTenant = APIError(
		statusCode: 0,
		message: "This app is not connected to a site yet."
	)
}
