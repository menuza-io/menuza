import SwiftUI
import TenantKit

/// Last look before booking, with the hold countdown still running. The booking
/// request is retried with the same idempotency key after a network error.
struct ReservationReviewView: View {
	@EnvironmentObject private var store: ReservationsStore
	@EnvironmentObject private var state: AppState
	@Environment(\.themePalette) private var palette
	@Environment(\.appLanguage) private var language

	var body: some View {
		ScrollView {
			VStack(spacing: 16) {
				if let countdown = store.holdCountdown, let remaining = store.holdRemaining {
					CountdownBanner(
						text: language.format("rsv.details.holding", ReservationsFormat.ltr(countdown)),
						isUrgent: remaining < 60
					)
				}
				ThemedCard {
					VStack(alignment: .leading, spacing: 12) {
						Text(store.location?.name ?? "")
							.font(.headline)
							.foregroundStyle(palette.cardForeground)
						DetailRow(
							label: language.string("rsv.detail.when"),
							value: "\(ReservationsFormat.dateLabel(store.flow.hold?.date ?? store.flow.date, locale: language.locale)) \u{00B7} \(ReservationsFormat.ltr(timeLabel))"
						)
						DetailRow(
							label: language.string("rsv.detail.party"),
							value: language.format("rsv.search.partyCount", store.partySize)
						)
						DetailRow(
							label: language.string("rsv.review.name"),
							value: "\(store.draft.firstName) \(store.draft.lastName)".trimmingCharacters(in: .whitespaces)
						)
						DetailRow(
							label: language.string("profile.phone"),
							value: ReservationsFormat.ltr(PhoneNumber.display(store.draft.phone))
						)
						if let policy = store.flow.hold?.policy, store.flow.hold?.requiresPayment == true {
							DetailRow(
								label: language.string("rsv.pay.amountLabel"),
								value: ReservationsFormat.ltr(ReservationsFormat.money(policy.totalAmountMinor, currency: policy.currency, locale: language.locale))
							)
						}
					}
				}
				if case .failed(let failure) = store.flow.phase {
					ErrorBanner(failure: failure)
				}
				PrimaryButton(
					title: language.string(store.flow.hold?.requiresPayment == true ? "rsv.review.pay" : "rsv.review.confirm"),
					isLoading: store.isBusy || store.flow.phase == .submitting
				) {
					Task { await store.submit(details: store.draft) }
				}
				SecondaryButton(title: language.string("rsv.review.back")) {
					store.backToDetails()
				}
			}
			.padding(20)
		}
		.background(palette.background)
		.navigationTitle(language.string("rsv.review.title"))
		// A back swipe returns to the form with the hold still counting down.
		.onDisappear {
			if store.flow.phase == .reviewing { store.backToDetails() }
		}
	}

	private var timeLabel: String {
		ReservationClock.timeLabel(localMin: store.flow.hold?.localMin ?? store.flow.selectedSlot?.localMin ?? 0)
	}
}
