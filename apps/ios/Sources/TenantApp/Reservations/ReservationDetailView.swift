import SwiftUI
import TenantKit

/// One booking: its status and, while the server allows it, change the time,
/// cancel, or tell the restaurant you are running late. The manage token comes
/// from the Keychain (or `/mine` after a reinstall) and travels in a header.
struct ReservationDetailView: View {
	@EnvironmentObject private var store: ReservationsStore
	@Environment(\.themePalette) private var palette
	@Environment(\.appLanguage) private var language
	@Environment(\.openURL) private var openURL

	let reservationId: String
	@Binding var path: [ReservationRoute]

	@State private var confirmingCancel = false
	@State private var showingModify = false

	private var token: String? { store.manageToken(for: reservationId) }

	var body: some View {
		ScrollView {
			VStack(spacing: 16) {
				if let view = store.manage, view.reservation.id == reservationId {
					summary(view)
					actions(view)
				} else if let failure = store.manageFailure {
					ThemedCard { ErrorBanner(failure: failure) }
				} else {
					ProgressView().padding(.top, 24)
				}
				if let failure = store.manageFailure, store.manage != nil {
					ErrorBanner(failure: failure)
				}
				if let key = store.manageNotice {
					FormMessage(text: language.string(key), isSuccess: true)
				}
			}
			.padding(20)
		}
		.background(palette.background)
		.navigationTitle(language.string("rsv.detail.title"))
		.task { await reload() }
		.refreshable { await reload() }
		.confirmationDialog(
			language.string("rsv.detail.cancelConfirm"),
			isPresented: $confirmingCancel,
			titleVisibility: .visible
		) {
			Button(language.string("rsv.detail.cancel"), role: .destructive) {
				guard let token else { return }
				Task {
					await store.cancelReservation(token: token)
					await store.loadMine()
				}
			}
			Button(language.string("rsv.detail.cancelKeep"), role: .cancel) {}
		}
		.sheet(isPresented: $showingModify) {
			if let token, let view = store.manage {
				ModifyReservationView(token: token, view: view, isPresented: $showingModify)
					.environmentObject(store)
			}
		}
	}

	private func reload() async {
		guard let token else {
			await store.loadMine()
			if let token = store.manageToken(for: reservationId) { await store.loadManage(token: token) }
			return
		}
		await store.loadManage(token: token)
	}

	private func summary(_ view: ReservationManageView) -> some View {
		let reservation = view.reservation
		return ThemedCard {
			VStack(alignment: .leading, spacing: 12) {
				HStack {
					Text(reservation.location.name ?? reservation.locationName ?? "")
						.font(.headline)
						.foregroundStyle(palette.cardForeground)
					Spacer()
					StatusBadge(status: view.status)
				}
				DetailRow(
					label: language.string("rsv.detail.when"),
					value: "\(ReservationsFormat.dateLabel(reservation.date, locale: language.locale)) \u{00B7} \(ReservationsFormat.ltr(reservation.time))"
				)
				DetailRow(
					label: language.string("rsv.detail.party"),
					value: language.format("rsv.search.partyCount", reservation.partySize)
				)
				DetailRow(
					label: language.string("rsv.confirmed.code"),
					value: ReservationsFormat.ltr(reservation.confirmationCode)
				)
				if let address = reservation.location.address {
					DetailRow(label: language.string("rsv.detail.where"), value: address)
				}
				if view.canCancel || view.canModify, let deadline = view.cancelDeadline,
					let date = ReservationClock.parse(deadline)
				{
					Text(language.format(
						"rsv.detail.deadline",
						ReservationsFormat.timeOfDay(date, timeZone: reservation.timeZone, locale: language.locale)
					))
					.font(.footnote)
					.foregroundStyle(palette.mutedForeground)
				}
			}
		}
	}

	@ViewBuilder
	private func actions(_ view: ReservationManageView) -> some View {
		let actions = ReservationManageActions(view: view)
		if actions.canModify {
			SecondaryButton(title: language.string("rsv.detail.modify")) { showingModify = true }
		}
		if actions.canRunLate, let token {
			ThemedCard {
				VStack(alignment: .leading, spacing: 10) {
					Text(language.string("rsv.detail.late"))
						.font(.subheadline.weight(.semibold))
						.foregroundStyle(palette.cardForeground)
					HStack(spacing: 8) {
						ForEach([5, 10, 15, 30], id: \.self) { minutes in
							ChipButton(title: language.format("rsv.detail.lateMinutes", minutes)) {
								Task { await store.runningLate(token: token, minutes: minutes) }
							}
							.disabled(store.isBusy)
						}
					}
				}
			}
		}
		if let phone = view.reservation.location.phone, actions.isLive,
			let url = URL(string: "tel:\(phone.filter { $0.isNumber || $0 == "+" })")
		{
			SecondaryButton(title: language.string("rsv.detail.call")) { openURL(url) }
		}
		if actions.canCancel {
			Button {
				confirmingCancel = true
			} label: {
				Text(language.string("rsv.detail.cancel"))
					.fontWeight(.medium)
					.frame(maxWidth: .infinity, minHeight: 44)
					.foregroundStyle(palette.destructive)
			}
			.buttonStyle(.plain)
		}
	}
}

/// Change the time (and party size) of a booking from the times the server
/// offers for it, excluding the booking's own table.
struct ModifyReservationView: View {
	@EnvironmentObject private var store: ReservationsStore
	@Environment(\.themePalette) private var palette
	@Environment(\.appLanguage) private var language

	let token: String
	let view: ReservationManageView
	@Binding var isPresented: Bool

	@State private var date: String
	@State private var party: Int
	@State private var availability: ReservationAvailability?

	init(token: String, view: ReservationManageView, isPresented: Binding<Bool>) {
		self.token = token
		self.view = view
		_isPresented = isPresented
		_date = State(initialValue: view.reservation.date)
		_party = State(initialValue: view.reservation.partySize)
	}

	var body: some View {
		NavigationStack {
			ScrollView {
				VStack(spacing: 16) {
					ThemedCard {
						VStack(alignment: .leading, spacing: 14) {
							PartyStepper(value: $party, range: 1...max(view.reservation.partySize + 4, 8))
							ScrollView(.horizontal, showsIndicators: false) {
								HStack(spacing: 8) {
									ForEach(days, id: \.self) { day in
										ChipButton(
											title: ReservationsFormat.dayNumber(day),
											subtitle: ReservationsFormat.shortWeekday(day, locale: language.locale),
											isSelected: day == date
										) { date = day }
									}
								}
							}
							LazyVGrid(columns: reservationChipColumns, spacing: 8) {
								ForEach(availability?.slots ?? [], id: \.self) { slot in
									ChipButton(title: ReservationsFormat.ltr(slot.time)) {
										Task {
											await store.modify(
												token: token,
												date: date,
												localMin: slot.localMin,
												partySize: party
											)
											if store.manageFailure == nil {
												isPresented = false
												await store.loadMine()
											}
										}
									}
									.disabled(store.isBusy)
								}
							}
							if availability?.slots.isEmpty == true {
								Text(language.string("rsv.search.noTimes"))
									.font(.subheadline)
									.foregroundStyle(palette.mutedForeground)
							}
							if let failure = store.manageFailure {
								ErrorBanner(failure: failure)
							}
						}
					}
				}
				.padding(20)
			}
			.background(palette.background)
			.navigationTitle(language.string("rsv.detail.modify"))
			.toolbar {
				ToolbarItem(placement: .cancellationAction) {
					Button(language.string("rsv.ok")) { isPresented = false }
				}
			}
			.task(id: "\(date)|\(party)") {
				availability = await store.availability(token: token, date: date, partySize: party)
			}
		}
	}

	private var days: [String] {
		ReservationDates.strip(
			now: Date(),
			timeZone: view.reservation.timeZone,
			count: 14,
			horizonDays: 60
		)
	}
}
