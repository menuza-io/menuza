import Foundation
import SwiftUI
import TenantKit

/// Drives the reservation screens. All rules live in TenantKit (`BookingFlow`,
/// `WaitlistFlow`, `ReservationsClient`); this store only calls the client, feeds
/// each answer to the flow and publishes the result.
///
/// Secrets (hold, manage and status tokens) stay in memory or in the Keychain
/// through `ReservationTokenStore`. Nothing here logs a token or guest detail.
@MainActor
final class ReservationsStore: ObservableObject {
	enum LoadState: Equatable {
		case idle
		case loading
		case ready
		/// Online reservations are switched off (or no location accepts them).
		case unavailable
		case failed(BookingFailure)
	}

	@Published private(set) var loadState: LoadState = .idle
	@Published private(set) var config: ReservationsConfig?
	@Published private(set) var location: ReservationLocation?
	@Published private(set) var flow = BookingFlow()
	@Published private(set) var waitlist = WaitlistFlow()
	@Published private(set) var isBusy = false
	@Published private(set) var now = Date()
	@Published private(set) var searchFailure: BookingFailure?
	@Published private(set) var mine: ReservationMine?
	@Published private(set) var manage: ReservationManageView?
	@Published private(set) var manageFailure: BookingFailure?
	@Published private(set) var manageNotice: String?
	@Published private(set) var isPolling = false
	/// The booking form, shared by the details and review screens.
	@Published var draft = ReservationGuestDetails()
	@Published var partySize = 2
	@Published var date = ""

	private let client: ReservationsClient
	private let tokens: ReservationTokenStore
	/// The app language, kept current by the shell.
	var localeCode: String
	private var ticker: Task<Void, Never>?
	private var pollTask: Task<Void, Never>?
	/// Server time minus device time, from the last answer that carried `now`.
	private var serverOffset: TimeInterval = 0

	init(client: ReservationsClient, tokens: ReservationTokenStore, localeCode: String) {
		self.client = client
		self.tokens = tokens
		self.localeCode = localeCode
	}

	deinit {
		ticker?.cancel()
		pollTask?.cancel()
	}

	// MARK: - Config

	func loadConfig() async {
		if loadState == .loading { return }
		loadState = .loading
		do {
			let config = try await client.config(locale: localeCode)
			noteServerTime(config.now)
			self.config = config
			if config.locations.isEmpty {
				loadState = .unavailable
				return
			}
			loadState = .ready
			if location == nil, config.locations.count == 1, let only = config.locations.first {
				selectLocation(only)
			}
		} catch {
			let failure = BookingFailure.map(error)
			loadState = (failure == .notFound || failure == .paused) ? .unavailable : .failed(failure)
		}
	}

	func selectLocation(_ location: ReservationLocation) {
		self.location = location
		partySize = min(max(partySize, location.partySize.min), location.partySize.max)
		date = ReservationDates.strip(
			now: Date().addingTimeInterval(serverOffset),
			timeZone: location.timeZone,
			count: 1,
			horizonDays: location.horizonDays
		).first ?? ""
	}

	/// The days the date strip offers, today first, in the location's time zone.
	var days: [String] {
		guard let location else { return [] }
		return ReservationDates.strip(
			now: Date().addingTimeInterval(serverOffset),
			timeZone: location.timeZone,
			count: 14,
			horizonDays: location.horizonDays
		)
	}

	// MARK: - Search

	func search() async {
		guard let location else { return }
		await releasePendingHold()
		searchFailure = nil
		flow.beginSearch(locationId: location.id, date: date, partySize: partySize)
		isBusy = true
		defer { isBusy = false }
		do {
			let availability = try await client.availability(
				locationId: location.id,
				date: date,
				partySize: partySize,
				locale: localeCode
			)
			noteServerTime(availability.now)
			flow.receive(availability: availability)
		} catch {
			searchFailure = BookingFailure.map(error)
		}
		await releasePendingHold()
	}

	/// The search view observes `date`, so setting it searches again.
	func chooseAlternativeDate(_ newDate: String) {
		date = newDate
	}

	/// Re-reads the times without resetting the flow (the guest came back to the
	/// list from a later step).
	func refreshAvailability() async {
		guard let location else { return }
		do {
			let availability = try await client.availability(
				locationId: location.id,
				date: flow.date.isEmpty ? date : flow.date,
				partySize: partySize,
				locale: localeCode
			)
			noteServerTime(availability.now)
			flow.receive(availability: availability)
		} catch {
			searchFailure = BookingFailure.map(error)
		}
	}

	// MARK: - Hold

	func choose(slot: ReservationSlot) async {
		guard let location else { return }
		flow.select(slot: slot)
		isBusy = true
		defer { isBusy = false }
		do {
			let hold = try await client.createHold(
				locationId: location.id,
				date: flow.date,
				localMin: slot.localMin,
				partySize: partySize,
				serviceId: slot.serviceId,
				areaId: slot.areaId,
				replaceHoldToken: flow.replaceableHoldToken
			)
			noteServerTime(hold.now)
			flow.receive(hold: hold, deviceNow: Date())
			startTicker()
		} catch {
			flow.receive(error: error)
		}
		await releasePendingHold()
	}

	func proceedToReview() { flow.proceedToReview() }

	func backToDetails() { flow.backToDetails() }

	/// The guest leaves the booking: the held table is released.
	func cancelBooking() async {
		stopTicker()
		stopPolling()
		flow.reset()
		await releasePendingHold()
	}

	private func releasePendingHold() async {
		guard let token = flow.holdToRelease else { return }
		flow.acknowledgeRelease()
		try? await client.releaseHold(holdToken: token)
	}

	// MARK: - Submit

	func submit(details: ReservationGuestDetails) async {
		guard let location else { return }
		let isRequest = flow.phase == .choosingTime && flow.offersRequest
		guard let key = flow.beginSubmit(details: details, isRequest: isRequest) else { return }
		isBusy = true
		defer { isBusy = false }
		do {
			let booking: ReservationBooking
			if isRequest, let slot = flow.selectedSlot {
				booking = try await client.requestLargeParty(
					locationId: location.id,
					date: flow.date,
					localMin: slot.localMin,
					partySize: partySize,
					details: details,
					idempotencyKey: key
				)
			} else if let hold = flow.hold {
				booking = try await client.book(
					holdToken: hold.token,
					details: details,
					idempotencyKey: key
				)
			} else {
				flow.receive(error: ReservationAPIError(statusCode: 410, code: "hold_expired"))
				return
			}
			tokens.rememberManage(reservationId: booking.reservation.id, token: booking.manageToken)
			flow.receive(booking: booking)
			stopTicker()
			if flow.phase == .awaitingPayment { startPolling() }
		} catch {
			flow.receive(error: error)
		}
	}

	/// A large party asks for a time instead of holding one.
	func setRequestTime(localMin: Int) {
		flow.setRequestTime(localMin: localMin)
	}

	// MARK: - Payment poll

	/// Polls `GET /reservations/manage/payment` with the schedule Sites uses and
	/// stops on a final answer, a dead link or after three minutes. The poll also
	/// runs when the app returns from the browser (`resumePolling`).
	func startPolling() {
		guard flow.phase == .awaitingPayment, let token = flow.booking?.manageToken else { return }
		pollTask?.cancel()
		isPolling = true
		pollTask = Task { [weak self] in
			guard let self else { return }
			let started = Date()
			var attempt = 0
			while !Task.isCancelled {
				do {
					let status = try await self.client.paymentStatus(token: token)
					self.noteServerTime(status.now)
					let outcome = self.flow.receive(paymentStatus: status)
					if outcome.isFinal { break }
				} catch {
					if PaymentPoll.stops(on: error) { break }
				}
				if PaymentPoll.hasTimedOut(since: started, now: Date()) { break }
				let delay = PaymentPoll.delay(afterAttempt: attempt)
				attempt += 1
				try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
			}
			self.isPolling = false
		}
	}

	func resumePolling() {
		if flow.phase == .awaitingPayment { startPolling() }
	}

	func stopPolling() {
		pollTask?.cancel()
		pollTask = nil
		isPolling = false
	}

	var paymentSecondsRemaining: TimeInterval? {
		flow.paymentSecondsRemaining(deviceNow: now, serverOffset: serverOffset)
	}

	// MARK: - Countdown

	private func startTicker() {
		ticker?.cancel()
		now = Date()
		ticker = Task { [weak self] in
			while !Task.isCancelled {
				try? await Task.sleep(nanoseconds: 1_000_000_000)
				guard let self, !Task.isCancelled else { return }
				self.now = Date()
				if self.flow.tick(deviceNow: self.now) {
					self.stopTicker()
				}
			}
		}
	}

	private func stopTicker() {
		ticker?.cancel()
		ticker = nil
	}

	var holdRemaining: TimeInterval? { flow.remaining(deviceNow: now) }

	var holdCountdown: String? { flow.hold?.countdownLabel(deviceNow: now) }

	// MARK: - My reservations and manage

	func loadMine() async {
		do {
			let result = try await client.mine()
			noteServerTime(result.now)
			mine = result
			// Recover tokens after a reinstall: `/mine` re-derives every manage token.
			for entry in result.upcoming + result.past {
				tokens.rememberManage(reservationId: entry.id, token: entry.manageToken)
			}
		} catch {
			// The list is a convenience; the booking flow does not depend on it.
		}
	}

	func manageToken(for reservationId: String) -> String? {
		tokens.load().manage[reservationId]
	}

	func loadManage(token: String) async {
		manageFailure = nil
		manageNotice = nil
		do {
			let view = try await client.manage(token: token)
			noteServerTime(view.now)
			manage = view
		} catch {
			manageFailure = BookingFailure.map(error)
		}
	}

	func modify(token: String, date: String, localMin: Int) async {
		await mutate(token: token) {
			try await self.client.modify(token: token, date: date, localMin: localMin)
		}
	}

	func cancelReservation(token: String) async {
		await mutate(token: token) { try await self.client.cancel(token: token) }
	}

	func runningLate(token: String, minutes: Int) async {
		await mutate(token: token, notice: "rsv.detail.lateSent") {
			try await self.client.runningLate(token: token, minutes: minutes)
		}
	}

	private func mutate(
		token: String,
		notice: String? = nil,
		_ call: () async throws -> ReservationManageView
	) async {
		isBusy = true
		manageFailure = nil
		manageNotice = nil
		defer { isBusy = false }
		do {
			let view = try await call()
			noteServerTime(view.now)
			manage = view
			manageNotice = notice
		} catch {
			manageFailure = BookingFailure.map(error)
		}
	}

	func availability(
		token: String,
		date: String,
		partySize: Int
	) async -> ReservationAvailability? {
		do {
			return try await client.manageAvailability(token: token, date: date, partySize: partySize)
		} catch {
			manageFailure = BookingFailure.map(error)
			return nil
		}
	}

	// MARK: - Waitlist

	func joinWaitlist(name: String, phone: String, smsOptIn: Bool) async {
		guard let location else { return }
		let key = waitlist.beginJoin(locationId: location.id, name: name, partySize: partySize)
		isBusy = true
		defer { isBusy = false }
		do {
			let joined = try await client.joinWaitlist(
				locationId: location.id,
				name: name,
				partySize: partySize,
				phone: phone,
				smsOptIn: smsOptIn,
				locale: localeCode,
				idempotencyKey: key
			)
			tokens.rememberWaitlist(entryId: joined.entry.id, token: joined.statusToken)
			waitlist.receive(join: joined)
			await refreshWaitlist()
		} catch {
			waitlist.receive(error: error)
		}
	}

	func refreshWaitlist() async {
		guard let token = waitlist.statusToken else { return }
		do {
			let status = try await client.waitlistStatus(token: token)
			noteServerTime(status.now)
			waitlist.receive(status: status)
		} catch {
			waitlist.receive(error: error)
		}
	}

	func leaveWaitlist() async {
		guard let token = waitlist.statusToken else { return }
		isBusy = true
		defer { isBusy = false }
		do {
			waitlist.receive(status: try await client.leaveWaitlist(token: token))
		} catch {
			waitlist.receive(error: error)
		}
	}

	func waitlistOnMyWay() async {
		guard let token = waitlist.statusToken else { return }
		isBusy = true
		defer { isBusy = false }
		do {
			waitlist.receive(status: try await client.waitlistOnMyWay(token: token))
		} catch {
			waitlist.receive(error: error)
		}
	}

	func resetWaitlist() { waitlist = WaitlistFlow() }

	// MARK: - Helpers

	private func noteServerTime(_ raw: String) {
		if let server = ReservationClock.parse(raw) {
			serverOffset = server.timeIntervalSince(Date())
		}
	}

	/// Wipes remembered tokens (sign-out).
	func forgetTokens() {
		tokens.clear()
		mine = nil
		manage = nil
	}
}
