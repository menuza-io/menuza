import Foundation
import XCTest

@testable import TenantKit

/// The canonical contract fixtures (`packages/reservations/contract-fixtures`),
/// copied byte for byte into `Fixtures/Reservations`. The tenant-api contract
/// test fails when a copy drifts, so decoding them here pins the app to the
/// real server shapes.
enum ReservationFixtures {
	static let names = [
		"availability", "availability-preferred-taken", "booking",
		"booking-pending-payment", "calendar", "config", "error-hold-expired",
		"error-invalid", "error-policy-required", "error-rate-limited",
		"error-slot-unavailable", "hold", "hold-requires-payment", "manage",
		"mine", "payment-status-none", "payment-status-pending", "request",
		"waitlist-join", "waitlist-status",
	]

	static func data(_ name: String, file: StaticString = #filePath, line: UInt = #line) throws -> Data {
		let url = try XCTUnwrap(
			Bundle.module.url(
				forResource: name,
				withExtension: "json",
				subdirectory: "Fixtures/Reservations"
			),
			"missing fixture \(name)",
			file: file,
			line: line
		)
		return try Data(contentsOf: url)
	}

	static func decode<T: Decodable>(_ type: T.Type, _ name: String) throws -> T {
		try JSONDecoder().decode(T.self, from: data(name))
	}
}

/// A signed-in session whose access token is valid, over a stub transport.
func makeSignedInSession(
	configuration: TenantConfiguration = makeConfiguration(),
	transport: HTTPTransport = StubTransport()
) -> CustomerSession {
	CustomerSession(
		client: TenantAPIClient(configuration: configuration, transport: transport),
		storage: InMemoryTokenStorage(
			tokens: AuthTokens(accessToken: makeAccessToken(), refreshToken: "refresh-1")
		)
	)
}
