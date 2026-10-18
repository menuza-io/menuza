import SwiftUI
import TenantKit

/// Party size, day, then the times the server offers. When the preferred time is
/// gone the server's alternatives are shown here; a party above the online
/// maximum sends a request instead.
struct ReservationSearchView: View {
	@EnvironmentObject private var store: ReservationsStore
	@Environment(\.themePalette) private var palette
	@Environment(\.appLanguage) private var language

	@Binding var path: [ReservationRoute]
	@State private var requestMinute = 19 * 60
	@State private var didLoad = false
	@State private var takenNotice = false

	private var location: ReservationLocation? { store.location }

	var body: some View {
		ScrollView {
			VStack(spacing: 16) {
				controls
				results
			}
			.padding(20)
		}
		.background(palette.background)
		.navigationTitle(language.string("rsv.search.title"))
		.task {
			if !didLoad {
				didLoad = true
				await store.search()
			}
		}
		.onAppear {
			guard didLoad else { return }
			if case .failed(.slotUnavailable) = store.flow.phase { takenNotice = true }
			Task { await store.refreshAvailability() }
		}
		.onChange(of: store.flow.phase) { _, phase in
			if case .failed(.slotUnavailable) = phase { takenNotice = true }
		}
		.onChange(of: store.partySize) { _, _ in
			takenNotice = false
			Task { await store.search() }
		}
		.onChange(of: store.date) { _, _ in
			takenNotice = false
			Task { await store.search() }
		}
	}

	private var controls: some View {
		ThemedCard {
			VStack(alignment: .leading, spacing: 16) {
				if let location {
					Text(location.name)
						.font(.headline)
						.foregroundStyle(palette.cardForeground)
					// A party above the online maximum is allowed so the guest can send a request.
					PartyStepper(
						value: $store.partySize,
						range: location.partySize.min...max(location.partySize.max, location.largeParty.maxOnlinePartySize + 20)
					)
				}
				Text(language.string("rsv.search.date"))
					.font(.subheadline.weight(.medium))
					.foregroundStyle(palette.foreground)
				ScrollView(.horizontal, showsIndicators: false) {
					HStack(spacing: 8) {
						ForEach(store.days, id: \.self) { day in
							ChipButton(
								title: ReservationsFormat.dayNumber(day),
								subtitle: ReservationsFormat.shortWeekday(day, locale: language.locale),
								isSelected: day == store.date
							) {
								store.date = day
							}
						}
					}
					.padding(.vertical, 2)
				}
			}
		}
	}

	@ViewBuilder
	private var results: some View {
		if case .failed(let failure) = store.flow.phase, !failure.isSlotUnavailable {
			failureCard(failure)
		}
		if let failure = store.searchFailure {
			ThemedCard {
				VStack(alignment: .leading, spacing: 12) {
					ErrorBanner(failure: failure)
					SecondaryButton(title: language.string("rsv.search.retry")) {
						Task { await store.search() }
					}
				}
			}
		} else if store.isBusy && store.flow.availability == nil {
			ProgressView().padding(.top, 24)
		} else if let availability = store.flow.availability {
			availabilityCard(availability)
		}
	}

	@ViewBuilder
	private func failureCard(_ failure: BookingFailure) -> some View {
		ThemedCard {
			ErrorBanner(failure: failure)
		}
	}

	@ViewBuilder
	private func availabilityCard(_ availability: ReservationAvailability) -> some View {
		ThemedCard {
			VStack(alignment: .leading, spacing: 14) {
				if takenNotice {
					FormMessage(text: language.string("rsv.error.slotUnavailable"))
				}
				switch availability.status {
				case "closed", "online_closed", "beyond_horizon":
					Text(closedText(availability))
						.font(.subheadline)
						.foregroundStyle(palette.mutedForeground)
				case "large_party":
					largePartyBlock(availability)
				default:
					slotsBlock(availability)
				}
			}
		}
		if availability.status == "full" || availability.slots.isEmpty,
			availability.status != "large_party"
		{
			alternativesCard(store.flow.alternatives)
		} else if !store.flow.alternatives.isEmpty, takenNotice {
			alternativesCard(store.flow.alternatives)
		}
		if availability.waitlist, availability.status == "full" || availability.slots.isEmpty,
			availability.status != "large_party"
		{
			SecondaryButton(title: language.string("rsv.search.waitlist")) {
				path.append(.waitlist)
			}
		}
	}

	private func closedText(_ availability: ReservationAvailability) -> String {
		availability.closed?.note ?? availability.onlineClosed?.note ?? language.string("rsv.search.closed")
	}

	@ViewBuilder
	private func slotsBlock(_ availability: ReservationAvailability) -> some View {
		Text(language.string("rsv.search.times"))
			.font(.subheadline.weight(.medium))
			.foregroundStyle(palette.foreground)
		if availability.slots.isEmpty {
			Text(language.string("rsv.search.noTimes"))
				.font(.subheadline)
				.foregroundStyle(palette.mutedForeground)
		} else {
			LazyVGrid(columns: reservationChipColumns, spacing: 8) {
				ForEach(availability.slots, id: \.self) { slot in
					ChipButton(title: ReservationsFormat.ltr(slot.time)) {
						Task { await store.choose(slot: slot) }
					}
					.disabled(store.isBusy)
				}
			}
		}
	}

	@ViewBuilder
	private func largePartyBlock(_ availability: ReservationAvailability) -> some View {
		let largeParty = availability.largeParty ?? location?.largeParty
		if largeParty?.acceptsRequests == true {
			Text(language.string("rsv.search.largeParty"))
				.font(.subheadline)
				.foregroundStyle(palette.mutedForeground)
			if let note = largeParty?.note, !note.isEmpty {
				Text(note)
					.font(.footnote)
					.foregroundStyle(palette.mutedForeground)
			}
			Picker(language.string("rsv.search.preferredTime"), selection: $requestMinute) {
				ForEach(requestMinutes, id: \.self) { minute in
					Text(ReservationsFormat.ltr(ReservationClock.timeLabel(localMin: minute))).tag(minute)
				}
			}
			.pickerStyle(.menu)
			PrimaryButton(title: language.string("rsv.search.request")) {
				store.setRequestTime(localMin: requestMinute)
				path.append(.details)
			}
		} else {
			Text(language.format("rsv.search.largePartyContact", ReservationsFormat.ltr(largeParty?.phone ?? largeParty?.contact.phone ?? location?.phone ?? "")))
				.font(.subheadline)
				.foregroundStyle(palette.mutedForeground)
		}
	}

	/// 11:00 to 23:00 on the location's grid.
	private var requestMinutes: [Int] {
		let step = max(location?.intervalMin ?? 15, 5)
		return Array(stride(from: 11 * 60, through: 23 * 60, by: step))
	}

	@ViewBuilder
	private func alternativesCard(_ alternatives: ReservationAlternatives) -> some View {
		if !alternatives.isEmpty {
			ThemedCard {
				VStack(alignment: .leading, spacing: 12) {
					if !alternatives.sameDay.isEmpty {
						Text(language.string("rsv.search.alternatives"))
							.font(.subheadline.weight(.medium))
							.foregroundStyle(palette.foreground)
						LazyVGrid(columns: reservationChipColumns, spacing: 8) {
							ForEach(alternatives.sameDay, id: \.self) { slot in
								ChipButton(title: ReservationsFormat.ltr(slot.time)) {
									Task { await store.choose(slot: slot) }
								}
								.disabled(store.isBusy)
							}
						}
					}
					if !alternatives.otherDates.isEmpty {
						Text(language.string("rsv.search.otherDays"))
							.font(.subheadline.weight(.medium))
							.foregroundStyle(palette.foreground)
						ScrollView(.horizontal, showsIndicators: false) {
							HStack(spacing: 8) {
								ForEach(alternatives.otherDates, id: \.self) { other in
									ChipButton(
										title: ReservationsFormat.ltr(ReservationClock.timeLabel(localMin: other.firstLocalMin)),
										subtitle: ReservationsFormat.dateLabel(other.date, locale: language.locale)
									) {
										store.chooseAlternativeDate(other.date)
									}
								}
							}
						}
					}
				}
			}
		}
	}
}
