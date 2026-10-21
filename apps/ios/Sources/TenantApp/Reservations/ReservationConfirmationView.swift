import SwiftUI
import TenantKit

/// The booking is confirmed (or, for a large party, requested).
struct ReservationConfirmationView: View {
	@EnvironmentObject private var store: ReservationsStore
	@Environment(\.themePalette) private var palette
	@Environment(\.appLanguage) private var language

	@Binding var path: [ReservationRoute]

	private var booking: ReservationBooking? { store.flow.booking }
	private var isRequest: Bool { store.flow.phase == .requested }

	var body: some View {
		ScrollView {
			VStack(spacing: 16) {
				ThemedCard {
					VStack(alignment: .leading, spacing: 12) {
						Image(systemName: isRequest ? "paperplane.circle.fill" : "checkmark.circle.fill")
							.font(.largeTitle)
							.foregroundStyle(palette.primary)
							.accessibilityHidden(true)
						Text(language.string(isRequest ? "rsv.confirmed.requested" : "rsv.confirmed.title"))
							.font(.title2.weight(.semibold))
							.foregroundStyle(palette.cardForeground)
						if isRequest {
							Text(language.string("rsv.confirmed.requestedBody"))
								.font(.subheadline)
								.foregroundStyle(palette.mutedForeground)
						}
						if let reservation = booking?.reservation {
							DetailRow(
								label: language.string("rsv.confirmed.code"),
								value: ReservationsFormat.ltr(reservation.confirmationCode)
							)
							DetailRow(
								label: language.string("rsv.detail.where"),
								value: reservation.locationName ?? ""
							)
							DetailRow(
								label: language.string("rsv.detail.when"),
								value: "\(ReservationsFormat.dateLabel(reservation.date, locale: language.locale)) \u{00B7} \(ReservationsFormat.ltr(reservation.time))"
							)
							DetailRow(
								label: language.string("rsv.detail.party"),
								value: language.format("rsv.search.partyCount", reservation.partySize)
							)
						}
					}
				}
				if let id = booking?.reservation.id {
					SecondaryButton(title: language.string("rsv.confirmed.view")) {
						path = [.detail(id)]
					}
				}
				PrimaryButton(title: language.string("rsv.confirmed.done")) {
					Task {
						await store.cancelBooking()
						await store.loadMine()
						path.removeAll()
					}
				}
			}
			.padding(20)
		}
		.background(palette.background)
		.navigationTitle(language.string("rsv.confirmed.title"))
		.navigationBarBackButtonHidden(true)
	}
}
