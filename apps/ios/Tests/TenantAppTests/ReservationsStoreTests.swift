import Foundation
import XCTest

@testable import TenantKit

// NOT part of the SwiftPM test target: `ReservationsStore` lives in the SwiftUI
// app target. Compile this file together with
// `Sources/TenantApp/Reservations/ReservationsStore.swift` and the TenantKit
// tests (`TestSupport.swift`, `ReservationFixtures.swift`) in an Xcode unit-test
// target (or a scratch SwiftPM package on macOS) to run it.

private func fixtureJSON(_ name: String) -> Any {
	let data = (try? ReservationFixtures.data(name)) ?? Data("{}".utf8)
	return (try? JSONSerialization.jsonObject(with: data)) ?? [String: Any]()
}

@MainActor
final class ReservationsStoreTests: XCTestCase {
	private func makeStore(
		transport: StubTransport,
		tokens: ReservationTokenStore
	) -> ReservationsStore {
		let configuration = makeConfiguration()
		let client = ReservationsClient(
			configuration: configuration,
			session: makeSignedInSession(configuration: configuration, transport: transport),
			transport: transport
		)
		return ReservationsStore(client: client, tokens: tokens, localeCode: "en")
	}

	func testWaitlistEntryIsRestoredAfterRelaunch() async throws {
		let tokens = InMemoryReservationTokenStore(
			tokens: StoredReservationTokens(waitlist: ["entry_1": "tok_wait_0001"])
		)
		let transport = StubTransport(handler: { _ in (200, fixtureJSON("waitlist-status")) })
		let store = makeStore(transport: transport, tokens: tokens)

		XCTAssertNil(store.waitlist.statusToken)
		await store.restoreWaitlist()

		XCTAssertEqual(store.waitlist.statusToken, "tok_wait_0001")
		XCTAssertEqual(store.waitlist.phase, .waiting)
		XCTAssertEqual(store.waitlist.status?.status, "waiting")
		let sent = try XCTUnwrap(transport.recorded.last)
		XCTAssertEqual(sent.request.value(forHTTPHeaderField: "X-Reservation-Token"), "tok_wait_0001")
		// The restored capability works: leaving uses it.
		XCTAssertEqual(tokens.load().waitlist["entry_1"], "tok_wait_0001")
	}

	func testUnknownWaitlistTokenIsClearedAndTheGuestCanJoinAgain() async {
		let tokens = InMemoryReservationTokenStore(
			tokens: StoredReservationTokens(waitlist: ["entry_1": "tok_dead_0001"])
		)
		let transport = StubTransport(handler: { _ in (404, ["error": "not_found"]) })
		let store = makeStore(transport: transport, tokens: tokens)

		await store.restoreWaitlist()

		XCTAssertNil(store.waitlist.statusToken)
		XCTAssertEqual(store.waitlist.phase, .idle)
		XCTAssertTrue(tokens.load().waitlist.isEmpty)
	}

	func testFinishedWaitlistEntryIsForgottenOnRestore() async {
		let tokens = InMemoryReservationTokenStore(
			tokens: StoredReservationTokens(waitlist: ["entry_1": "tok_wait_0001"])
		)
		var done = fixtureJSON("waitlist-status") as! [String: Any]
		done["status"] = "left"
		let transport = StubTransport(handler: { _ in (200, done) })
		let store = makeStore(transport: transport, tokens: tokens)

		await store.restoreWaitlist()

		XCTAssertNil(store.waitlist.statusToken)
		XCTAssertTrue(tokens.load().waitlist.isEmpty)
	}

	func testResetClearsPersistedAndInMemoryCapabilities() async {
		let tokens = InMemoryReservationTokenStore(
			tokens: StoredReservationTokens(
				manage: ["rsv_1": "tok_manage_0001"],
				waitlist: ["entry_1": "tok_wait_0001"]
			)
		)
		let transport = StubTransport(handler: { request in
			let path = request.url?.path ?? ""
			if path.hasSuffix("/mine") { return (200, fixtureJSON("mine")) }
			if path.hasSuffix("/manage") { return (200, fixtureJSON("manage")) }
			if path.hasSuffix("/config") { return (200, fixtureJSON("config")) }
			return (200, fixtureJSON("waitlist-status"))
		})
		let store = makeStore(transport: transport, tokens: tokens)
		await store.loadConfig()
		await store.loadMine()
		await store.loadManage(token: "tok_manage_0001")
		await store.restoreWaitlist()
		store.draft.firstName = "Previous"
		XCTAssertNotNil(store.waitlist.statusToken)
		XCTAssertNotNil(store.mine)
		XCTAssertNotNil(store.manage)

		store.reset()

		XCTAssertNil(store.waitlist.statusToken)
		XCTAssertNil(store.waitlist.status)
		XCTAssertEqual(store.waitlist.phase, .idle)
		XCTAssertNil(store.mine)
		XCTAssertNil(store.manage)
		XCTAssertNil(store.config)
		XCTAssertNil(store.location)
		XCTAssertEqual(store.draft.firstName, "")
		XCTAssertEqual(store.flow.phase, .idle)
		XCTAssertTrue(tokens.load().isEmpty)
		XCTAssertEqual(store.manageToken(for: "rsv_1"), nil)

		// The next customer's refresh has no capability to use.
		let before = transport.recorded.count
		await store.refreshWaitlist()
		await store.leaveWaitlist()
		XCTAssertEqual(transport.recorded.count, before)
	}

	func testAnswerThatArrivesAfterResetIsDropped() async {
		let transport = StubTransport(delayedHandler: { _ in (200, fixtureJSON("mine"), 150) })
		let store = makeStore(transport: transport, tokens: InMemoryReservationTokenStore())
		let pending = Task { await store.loadMine() }
		try? await Task.sleep(nanoseconds: 30_000_000)
		store.reset()
		await pending.value
		XCTAssertNil(store.mine)
	}

	func testModifySendsTheSelectedPartySize() async throws {
		let transport = StubTransport(handler: { _ in (200, fixtureJSON("manage")) })
		let store = makeStore(transport: transport, tokens: InMemoryReservationTokenStore())

		await store.modify(token: "tok_manage_0001", date: "2030-06-25", localMin: 1170, partySize: 4)

		let sent = try XCTUnwrap(transport.recorded.last)
		XCTAssertEqual(sent.url.path, "/reservations/manage/modify")
		XCTAssertEqual(sent.body["partySize"] as? Int, 4)
		XCTAssertEqual(sent.body["localMin"] as? Int, 1170)
	}

	func testStepperReachesTheLargePartyRangeAboveTheOnlineMaximum() throws {
		let config = try ReservationFixtures.decode(ReservationsConfig.self, "config")
		let location = try XCTUnwrap(config.locations.first)
		XCTAssertEqual(location.partySize.max, 4)
		XCTAssertEqual(location.largeParty.mode, "request")
		XCTAssertEqual(location.partyCeiling, 99)
		XCTAssertFalse(location.needsApproval(partySize: 4))
		XCTAssertTrue(location.needsApproval(partySize: 5))
	}
}
