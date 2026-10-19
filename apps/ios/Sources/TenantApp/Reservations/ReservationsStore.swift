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
	/// The waitlist entry whose status token `waitlist` holds (to forget it later).
	private var waitlistEntryId: String?
	private var isRestoringWaitlist = false
	/// Bumped by `reset()`: an answer that arrives after sign-out is dropped.
	private var generation = 0

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
		let gen = generation
		do {
			let config = try await client.config(locale: localeCode)
			guard gen == generation else { return }
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
			await restoreWaitlist()
		} catch {
			guard gen == generation else { return }
			let failure = BookingFailure.map(error)
			loadState = (failure == .notFound || failure == .paused) ? .unavailable : .failed(failure)
		}
	}

	func selectLocation(_ location: ReservationLocation) {
		self.location = location
		// Above the online maximum is allowed: the guest sends a request instead.
		partySize = min(max(partySize, location.partySize.min), location.partyCeiling)
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
		let gen = generation
		isBusy = true
		defer { if gen == generation { isBusy = false } }
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
			guard gen == generation else { return }
			tokens.rememberManage(reservationId: booking.reservation.id, token: booking.manageToken)
			flow.receive(booking: booking)
			stopTicker()
			if flow.phase == .awaitingPayment { startPolling() }
		} catch {
			guard gen == generation else { return }
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
		let gen = generation
		do {
			let result = try await client.mine()
			guard gen == generation else { return }
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
		let gen = generation
		do {
			let view = try await client.manage(token: token)
			guard gen == generation else { return }
			noteServerTime(view.now)
			manage = view
		} catch {
			guard gen == generation else { return }
			manageFailure = BookingFailure.map(error)
		}
	}

	func modify(token: String, date: String, localMin: Int, partySize: Int? = nil) async {
		await mutate(token: token) {
			try await self.client.modify(
				token: token,
				date: date,
				localMin: localMin,
				partySize: partySize
			)
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
		let gen = generation
		isBusy = true
		manageFailure = nil
		manageNotice = nil
		defer { if gen == generation { isBusy = false } }
		do {
			let view = try await call()
			guard gen == generation else { return }
			noteServerTime(view.now)
			manage = view
			manageNotice = notice
		} catch {
			guard gen == generation else { return }
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
		let gen = generation
		isBusy = true
		defer { if gen == generation { isBusy = false } }
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
			guard gen == generation else { return }
			tokens.rememberWaitlist(entryId: joined.entry.id, token: joined.statusToken)
			waitlistEntryId = joined.entry.id
			waitlist.receive(join: joined)
			await refreshWaitlist()
		} catch {
			guard gen == generation else { return }
			waitlist.receive(error: error)
		}
	}

	/// After a relaunch the Keychain still holds the status token of an entry the
	/// guest joined. Put it back into the flow so the guest can follow, refresh and
	/// leave it (joining again would answer `already_on_waitlist`). A token the
	/// server no longer knows, or an entry that is over, is forgotten so the guest
	/// can join again.
	func restoreWaitlist() async {
		guard waitlist.statusToken == nil, !isRestoringWaitlist else { return }
		isRestoringWaitlist = true
		defer { isRestoringWaitlist = false }
		let gen = generation
		let saved = tokens.load().waitlist
		for entryId in saved.keys.sorted() {
			guard let token = saved[entryId] else { continue }
			do {
				let status = try await client.waitlistStatus(token: token)
				guard gen == generation else { return }
				noteServerTime(status.now)
				if WaitlistFlow.isFinished(status: status.status) {
					tokens.forgetWaitlist(entryId: entryId)
					continue
				}
				waitlist.restore(token: token)
				waitlist.receive(status: status)
				waitlistEntryId = entryId
				return
			} catch {
				guard gen == generation else { return }
				if BookingFailure.map(error) == .notFound {
					tokens.forgetWaitlist(entryId: entryId)
					continue
				}
				// Offline or a transient failure: keep the capability and show the
				// status screen; the screen's refresh loop retries.
				waitlist.restore(token: token)
				waitlistEntryId = entryId
				return
			}
		}
	}

	func refreshWaitlist() async {
		guard let token = waitlist.statusToken else { return }
		let gen = generation
		do {
			let status = try await client.waitlistStatus(token: token)
			guard gen == generation else { return }
			noteServerTime(status.now)
			waitlist.receive(status: status)
			forgetWaitlistTokenIfFinished()
		} catch {
			guard gen == generation else { return }
			waitlist.receive(error: error)
			if waitlist.phase == .linkInvalid { forgetWaitlistToken() }
		}
	}

	func leaveWaitlist() async {
		guard let token = waitlist.statusToken else { return }
		let gen = generation
		isBusy = true
		defer { if gen == generation { isBusy = false } }
		do {
			let status = try await client.leaveWaitlist(token: token)
			guard gen == generation else { return }
			waitlist.receive(status: status)
			forgetWaitlistTokenIfFinished()
		} catch {
			guard gen == generation else { return }
			waitlist.receive(error: error)
			if waitlist.phase == .linkInvalid { forgetWaitlistToken() }
		}
	}

	func waitlistOnMyWay() async {
		guard let token = waitlist.statusToken else { return }
		let gen = generation
		isBusy = true
		defer { if gen == generation { isBusy = false } }
		do {
			let status = try await client.waitlistOnMyWay(token: token)
			guard gen == generation else { return }
			waitlist.receive(status: status)
			forgetWaitlistTokenIfFinished()
		} catch {
			guard gen == generation else { return }
			waitlist.receive(error: error)
			if waitlist.phase == .linkInvalid { forgetWaitlistToken() }
		}
	}

	func resetWaitlist() {
		forgetWaitlistToken()
		waitlist = WaitlistFlow()
	}

	private func forgetWaitlistTokenIfFinished() {
		if let status = waitlist.status, WaitlistFlow.isFinished(status: status.status) {
			forgetWaitlistToken()
		}
	}

	/// Drops the persisted status token of the current entry (the in-memory flow
	/// keeps showing its final state until the guest leaves the screen).
	private func forgetWaitlistToken() {
		if let id = waitlistEntryId { tokens.forgetWaitlist(entryId: id) }
		waitlistEntryId = nil
	}

	// MARK: - Helpers

	private func noteServerTime(_ raw: String) {
		if let server = ReservationClock.parse(raw) {
			serverOffset = server.timeIntervalSince(Date())
		}
	}

	/// Sign-out and account switch: wipes the persisted capability tokens AND every
	/// in-memory piece of the previous customer's session (manage, waitlist, hold,
	/// payment poll, bookings, guest details), so the next customer who signs in on
	/// this device starts from nothing. Answers still in flight are dropped.
	func reset() {
		generation += 1
		stopTicker()
		stopPolling()
		// The held table of the leaving customer is released, best effort.
		flow.reset()
		let heldToken = flow.holdToRelease
		tokens.clear()
		flow = BookingFlow()
		waitlist = WaitlistFlow()
		waitlistEntryId = nil
		isRestoringWaitlist = false
		loadState = .idle
		config = nil
		location = nil
		isBusy = false
		searchFailure = nil
		mine = nil
		manage = nil
		manageFailure = nil
		manageNotice = nil
		draft = ReservationGuestDetails()
		partySize = 2
		date = ""
		serverOffset = 0
		if let heldToken {
			let client = client
			Task { try? await client.releaseHold(holdToken: heldToken) }
		}
	}

	/// Kept for callers that only meant "sign out".
	func forgetTokens() { reset() }
}
