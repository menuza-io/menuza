import Foundation

#if canImport(Security)
import Security
#endif

/// The capability tokens a guest holds for their reservations and waitlist
/// entries: the manage token of each booking (`X-Reservation-Token`) and the
/// status token of each waitlist entry. They authorize reading and changing one
/// booking each, so they live in the Keychain with the customer session, never
/// in `UserDefaults`, a URL, or a log.
public struct StoredReservationTokens: Codable, Equatable, Sendable {
	/// reservation id -> manage token
	public var manage: [String: String]
	/// waitlist entry id -> status token
	public var waitlist: [String: String]

	public init(manage: [String: String] = [:], waitlist: [String: String] = [:]) {
		self.manage = manage
		self.waitlist = waitlist
	}

	public var isEmpty: Bool { manage.isEmpty && waitlist.isEmpty }
}

public protocol ReservationTokenStore: Sendable {
	func load() -> StoredReservationTokens
	/// Returns `false` when the tokens could not be persisted; callers keep the
	/// in-memory copy for this run.
	@discardableResult
	func save(_ tokens: StoredReservationTokens) -> Bool
}

public extension ReservationTokenStore {
	func rememberManage(reservationId: String, token: String) {
		var tokens = load()
		tokens.manage[reservationId] = token
		save(tokens)
	}

	func rememberWaitlist(entryId: String, token: String) {
		var tokens = load()
		tokens.waitlist[entryId] = token
		save(tokens)
	}

	func forgetManage(reservationId: String) {
		var tokens = load()
		tokens.manage[reservationId] = nil
		save(tokens)
	}

	func forgetWaitlist(entryId: String) {
		var tokens = load()
		tokens.waitlist[entryId] = nil
		save(tokens)
	}

	func clear() {
		save(StoredReservationTokens())
	}
}

/// Test and Linux storage. Not used by the shipping app.
public final class InMemoryReservationTokenStore: ReservationTokenStore, @unchecked Sendable {
	private let lock = NSLock()
	private var tokens: StoredReservationTokens

	public init(tokens: StoredReservationTokens = StoredReservationTokens()) {
		self.tokens = tokens
	}

	public func load() -> StoredReservationTokens {
		lock.lock()
		defer { lock.unlock() }
		return tokens
	}

	@discardableResult
	public func save(_ tokens: StoredReservationTokens) -> Bool {
		lock.lock()
		defer { lock.unlock() }
		self.tokens = tokens
		return true
	}
}

#if canImport(Security)
/// Keychain-backed storage for the shipping iOS app (same item class and
/// accessibility as `KeychainTokenStorage`, under its own account).
public final class KeychainReservationTokenStore: ReservationTokenStore, @unchecked Sendable {
	private let service: String
	private let account: String

	public init(service: String = "com.epicstartup.tenant", account: String = "reservation-tokens") {
		self.service = service
		self.account = account
	}

	public func load() -> StoredReservationTokens {
		var query = baseQuery()
		query[kSecReturnData as String] = true
		query[kSecMatchLimit as String] = kSecMatchLimitOne

		var item: CFTypeRef?
		let status = SecItemCopyMatching(query as CFDictionary, &item)
		guard status == errSecSuccess, let data = item as? Data else {
			return StoredReservationTokens()
		}
		return (try? JSONDecoder().decode(StoredReservationTokens.self, from: data))
			?? StoredReservationTokens()
	}

	@discardableResult
	public func save(_ tokens: StoredReservationTokens) -> Bool {
		if tokens.isEmpty {
			let status = SecItemDelete(baseQuery() as CFDictionary)
			return status == errSecSuccess || status == errSecItemNotFound
		}
		guard let data = try? JSONEncoder().encode(tokens) else { return false }

		let query = baseQuery()
		let attributes: [String: Any] = [kSecValueData as String: data]
		let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
		if status == errSecSuccess { return true }
		guard status == errSecItemNotFound else { return false }

		var insert = query
		insert[kSecValueData as String] = data
		insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
		return SecItemAdd(insert as CFDictionary, nil) == errSecSuccess
	}

	private func baseQuery() -> [String: Any] {
		[
			kSecClass as String: kSecClassGenericPassword,
			kSecAttrService as String: service,
			kSecAttrAccount as String: account,
		]
	}
}
#endif

public enum ReservationTokenStoreFactory {
	/// Keychain on Apple platforms, in-memory elsewhere (tests/Linux).
	public static func makeDefault() -> ReservationTokenStore {
		#if canImport(Security)
		return KeychainReservationTokenStore()
		#else
		return InMemoryReservationTokenStore()
		#endif
	}
}
