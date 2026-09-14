import Foundation
import XCTest

#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

@testable import TenantKit

/// Records outgoing requests and replays canned responses.
final class StubTransport: HTTPTransport, @unchecked Sendable {
	struct Recorded {
		let request: URLRequest
		let body: [String: Any]
		let url: URL
	}

	private let lock = NSLock()
	private var responses: [(status: Int, data: Data, delayMs: Int)]
	private(set) var recorded: [Recorded] = []

	init(responses: [(status: Int, body: Any)] = []) {
		self.responses = responses.map { response in
			let data = (try? JSONSerialization.data(withJSONObject: response.body)) ?? Data()
			return (response.status, data, 0)
		}
	}

	init(rawResponses: [(status: Int, data: Data)]) {
		self.responses = rawResponses.map { ($0.status, $0.data, 0) }
	}

	/// Like `rawResponses`, but each reply can be delayed — used to pin down
	/// interleavings such as a refresh that lands after a sign-out.
	init(delayedResponses: [(status: Int, data: Data, delayMs: Int)]) {
		self.responses = delayedResponses.map { ($0.status, $0.data, $0.delayMs) }
	}

	func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
		lock.lock()
		let response = responses.isEmpty ? (200, Data("{}".utf8), 0) : responses.removeFirst()
		lock.unlock()

		if response.2 > 0 {
			// Swallow cancellation: a reply already in flight still arrives, which
			// is the case the session-level sign-out guard has to handle.
			try? await Task.sleep(nanoseconds: UInt64(response.2) * 1_000_000)
		}

		lock.lock()
		let body: [String: Any] = {
			guard let data = request.httpBody else { return [:] }
			return (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
		}()
		if let url = request.url {
			recorded.append(Recorded(request: request, body: body, url: url))
		}
		lock.unlock()

		let http = HTTPURLResponse(
			url: request.url ?? URL(string: "https://example.com")!,
			statusCode: response.0,
			httpVersion: "HTTP/1.1",
			headerFields: ["Content-Type": "application/json"]
		)!
		return (response.1, http)
	}

	var lastRequest: Recorded? {
		lock.lock()
		defer { lock.unlock() }
		return recorded.last
	}
}

extension StubTransport {
	static func json(_ object: Any, status: Int = 200) -> (status: Int, body: Any) {
		(status, object)
	}
}

/// Always fails, like an offline device.
struct FailingTransport: HTTPTransport {
	func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
		throw URLError(.notConnectedToInternet)
	}
}

func makeConfiguration(
	slug: String? = "acme",
	host: String? = nil,
	origin: String? = nil,
	region: String = "us"
) -> TenantConfiguration {
	TenantConfiguration(
		appBaseURL: URL(string: "https://app.epic-startup.com")!,
		tenantAPIBaseURLUS: URL(string: "https://tenant-us.epic-startup.com")!,
		tenantAPIBaseURLKSA: URL(string: "https://tenant-ksa.epic-startup.com")!,
		siteAddress: SiteAddress(
			slug: slug,
			host: host,
			origin: origin.flatMap(URL.init(string:))
		),
		brandDomain: "epic-startup.com",
		dataRegion: region
	)
}

/// Unsigned JWT with the same claim shape tenant-api issues.
func makeAccessToken(
	customerId: String = "cust_1",
	orgId: String = "org_1",
	name: String = "Ada Lovelace",
	expiresIn: TimeInterval = 900
) -> String {
	let header = #"{"alg":"HS256","typ":"JWT"}"#
	let payload = """
	{"customerId":"\(customerId)","orgId":"\(orgId)","name":"\(name)","type":"access","exp":\(Int(Date().timeIntervalSince1970 + expiresIn))}
	"""
	func encode(_ value: String) -> String {
		let data = Data(value.utf8)
		return data.base64EncodedString()
			.replacingOccurrences(of: "+", with: "-")
			.replacingOccurrences(of: "/", with: "_")
			.replacingOccurrences(of: "=", with: "")
	}
	return "\(encode(header)).\(encode(payload)).signature"
}
