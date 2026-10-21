import SwiftUI
import TenantKit

/// Where the stack can go. Each screen asks the store to move the flow forward;
/// the shell follows the flow's phase so a back swipe, an expired hold or a taken
/// slot always lands on the right screen.
enum ReservationRoute: Hashable {
	case location
	case search
	case details
	case review
	case payment
	case confirmed
	case detail(String)
	case waitlist
}

/// The signed-in branch of `RootView`: a `NavigationStack` rooted at the
/// reservations home, with the profile one tap away.
struct SignedInShell: View {
	@EnvironmentObject private var state: AppState
	@Environment(\.themePalette) private var palette
	@Environment(\.appLanguage) private var language

	var body: some View {
		if let store = state.reservations {
			ReservationsShell(store: store)
		} else {
			ProfileView()
		}
	}
}

struct ReservationsShell: View {
	@ObservedObject var store: ReservationsStore
	@EnvironmentObject private var state: AppState
	@Environment(\.appLanguage) private var language
	@Environment(\.scenePhase) private var scenePhase

	@State private var path: [ReservationRoute] = []
	@State private var alertKey: String?

	var body: some View {
		NavigationStack(path: $path) {
			ReservationsHomeView(path: $path)
				.navigationDestination(for: ReservationRoute.self) { route in
					destination(for: route)
				}
		}
		.environmentObject(store)
		.task {
			store.localeCode = language.code
			await store.loadConfig()
		}
		.onChange(of: language.code) { _, code in store.localeCode = code }
		.onChange(of: store.flow.phase) { _, phase in follow(phase) }
		// Returning from the browser after paying: poll straight away.
		.onChange(of: scenePhase) { _, phase in
			if phase == .active { store.resumePolling() }
		}
		.alert(
			alertKey.map { language.string($0) } ?? "",
			isPresented: Binding(get: { alertKey != nil }, set: { if !$0 { alertKey = nil } })
		) {
			Button(language.string("rsv.ok")) { alertKey = nil }
		}
	}

	@ViewBuilder
	private func destination(for route: ReservationRoute) -> some View {
		switch route {
		case .location: LocationPickerView(path: $path)
		case .search: ReservationSearchView(path: $path)
		case .details: ReservationDetailsView(path: $path)
		case .review: ReservationReviewView()
		case .payment: ReservationPaymentView(path: $path)
		case .confirmed: ReservationConfirmationView(path: $path)
		case .detail(let id): ReservationDetailView(reservationId: id, path: $path)
		case .waitlist: WaitlistView()
		}
	}

	/// Keeps the stack in step with the flow.
	private func follow(_ phase: BookingPhase) {
		switch phase {
		case .details:
			if !path.contains(.details) { path.append(.details) }
		case .reviewing:
			if !path.contains(.review) { path.append(.review) }
		case .awaitingPayment:
			if !path.contains(.payment) { path.append(.payment) }
		case .confirmed, .requested:
			if !path.contains(.confirmed) {
				path.removeAll { $0 == .payment || $0 == .review || $0 == .details }
				path.append(.confirmed)
			}
		case .expired:
			// The hold ran out (or the payment window closed): back to the times.
			if path.contains(.details) || path.contains(.review) || path.contains(.payment) {
				let wasPaying = path.contains(.payment)
				path.removeAll { $0 == .details || $0 == .review || $0 == .payment }
				if !path.contains(.search) { path.append(.search) }
				alertKey = wasPaying ? "rsv.pay.expired" : "rsv.error.holdExpired"
			}
		case .failed(.slotUnavailable):
			if path.contains(.details) || path.contains(.review) {
				path.removeAll { $0 == .details || $0 == .review }
				if !path.contains(.search) { path.append(.search) }
			}
		default:
			break
		}
	}
}

/// Book a table, My reservations, the waitlist and the profile.
struct ReservationsHomeView: View {
	@EnvironmentObject private var store: ReservationsStore
	@Environment(\.themePalette) private var palette
	@Environment(\.appLanguage) private var language

	@Binding var path: [ReservationRoute]

	var body: some View {
		ScrollView {
			VStack(spacing: 20) {
				bookCard
				mineCard
			}
			.padding(20)
		}
		.background(palette.background)
		.navigationTitle(language.string("rsv.home.title"))
		.toolbar {
			ToolbarItem(placement: .primaryAction) {
				NavigationLink {
					ProfileView()
				} label: {
					Image(systemName: "person.crop.circle")
				}
				.accessibilityLabel(language.string("rsv.home.profile"))
			}
		}
		.task { await store.loadMine() }
		.refreshable { await store.loadMine() }
		// Leaving the booking steps releases a table that is still only held.
		.onAppear {
			if store.flow.hold != nil { Task { await store.cancelBooking() } }
		}
	}

	@ViewBuilder
	private var bookCard: some View {
		ThemedCard {
			VStack(alignment: .leading, spacing: 14) {
				switch store.loadState {
				case .idle, .loading:
					HStack(spacing: 8) {
						ProgressView()
						Text(language.string("app.loading"))
							.font(.subheadline)
							.foregroundStyle(palette.mutedForeground)
					}
				case .unavailable:
					Text(language.string("rsv.unavailable"))
						.font(.subheadline)
						.foregroundStyle(palette.mutedForeground)
				case .failed(let failure):
					ErrorBanner(failure: failure)
					SecondaryButton(title: language.string("app.retry")) {
						Task { await store.loadConfig() }
					}
				case .ready:
					PrimaryButton(title: language.string("rsv.home.book")) {
						path.append(store.location == nil ? .location : .search)
					}
					if store.config?.locations.contains(where: { $0.waitlist.online }) == true {
						SecondaryButton(title: language.string("rsv.home.waitlist")) {
							if store.location == nil, let first = store.config?.locations.first(where: { $0.waitlist.online }) {
								store.selectLocation(first)
							}
							path.append(.waitlist)
						}
					}
				}
			}
		}
	}

	@ViewBuilder
	private var mineCard: some View {
		let upcoming = store.mine?.upcoming ?? []
		let past = store.mine?.past ?? []
		ThemedCard {
			VStack(alignment: .leading, spacing: 12) {
				Text(language.string("rsv.home.mine"))
					.font(.headline)
					.foregroundStyle(palette.cardForeground)
				if upcoming.isEmpty {
					Text(language.string("rsv.home.empty"))
						.font(.subheadline)
						.foregroundStyle(palette.mutedForeground)
				}
				ForEach(upcoming) { entry in
					ReservationRow(entry: entry) { path.append(.detail(entry.id)) }
				}
				if !past.isEmpty {
					Text(language.string("rsv.home.past"))
						.font(.subheadline.weight(.semibold))
						.foregroundStyle(palette.mutedForeground)
						.padding(.top, 4)
					ForEach(past.prefix(5)) { entry in
						ReservationRow(entry: entry) { path.append(.detail(entry.id)) }
					}
				}
			}
		}
	}
}

struct ReservationRow: View {
	@Environment(\.themePalette) private var palette
	@Environment(\.appLanguage) private var language

	let entry: ReservationMineEntry
	let action: () -> Void

	var body: some View {
		Button(action: action) {
			HStack {
				VStack(alignment: .leading, spacing: 2) {
					Text(entry.locationName ?? "")
						.font(.subheadline.weight(.semibold))
						.foregroundStyle(palette.cardForeground)
					Text("\(ReservationsFormat.dateLabel(entry.date, locale: language.locale)) \u{00B7} \(ReservationsFormat.ltr(entry.time)) \u{00B7} \(language.format("rsv.search.partyCount", entry.partySize))")
						.font(.footnote)
						.foregroundStyle(palette.mutedForeground)
				}
				Spacer()
				StatusBadge(status: entry.status)
				Image(systemName: "chevron.forward")
					.font(.caption)
					.foregroundStyle(palette.mutedForeground)
			}
			.padding(.vertical, 6)
			.frame(minHeight: 44)
			.contentShape(Rectangle())
		}
		.buttonStyle(.plain)
	}
}

struct LocationPickerView: View {
	@EnvironmentObject private var store: ReservationsStore
	@Environment(\.themePalette) private var palette
	@Environment(\.appLanguage) private var language

	@Binding var path: [ReservationRoute]

	var body: some View {
		ScrollView {
			VStack(spacing: 12) {
				ForEach(store.config?.locations ?? []) { location in
					Button {
						store.selectLocation(location)
						if path.last == .location { path.removeLast() }
						path.append(.search)
					} label: {
						ThemedCard {
							VStack(alignment: .leading, spacing: 4) {
								Text(location.name)
									.font(.headline)
									.foregroundStyle(palette.cardForeground)
								if let address = location.address?.formattedAddress {
									Text(address)
										.font(.subheadline)
										.foregroundStyle(palette.mutedForeground)
								}
							}
						}
					}
					.buttonStyle(.plain)
				}
			}
			.padding(20)
		}
		.background(palette.background)
		.navigationTitle(language.string("rsv.location.title"))
	}
}
