import SwiftUI
import TenantKit

/// Shown while a booking waits for its deposit or card guarantee. "Pay now"
/// opens the provider's page (through the Sites pay page) in the system browser;
/// nothing on this screen ever says "paid" until the status poll does. The poll
/// runs while the screen is open and again when the app returns to the
/// foreground.
struct ReservationPaymentView: View {
	@EnvironmentObject private var store: ReservationsStore
	@Environment(\.themePalette) private var palette
	@Environment(\.appLanguage) private var language
	@Environment(\.openURL) private var openURL
	@Environment(\.scenePhase) private var scenePhase

	@Binding var path: [ReservationRoute]

	private var payment: ReservationPaymentBlock? { store.flow.booking?.payment }

	var body: some View {
		ScrollView {
			VStack(spacing: 16) {
				ThemedCard {
					VStack(alignment: .leading, spacing: 12) {
						Text(language.string("rsv.pay.title"))
							.font(.title3.weight(.semibold))
							.foregroundStyle(palette.cardForeground)
						if let payment {
							Text(language.format(
								"rsv.pay.amount",
								ReservationsFormat.ltr(ReservationsFormat.money(payment.amountMinor, currency: payment.currency, locale: language.locale))
							))
							.font(.headline)
							.foregroundStyle(palette.cardForeground)
						}
						Text(language.string("rsv.pay.hint"))
							.font(.subheadline)
							.foregroundStyle(palette.mutedForeground)
						if let remaining = store.paymentSecondsRemaining {
							CountdownBanner(
								text: language.format("rsv.pay.expires", ReservationsFormat.ltr(ReservationsFormat.clock(remaining))),
								isUrgent: remaining < 120
							)
						}
					}
				}
				statusCard
				if let payment, let url = URL(string: payment.payUrl) {
					PrimaryButton(title: language.string("rsv.pay.open")) {
						// The URL carries the payment token in its fragment: it goes to
						// the browser and is never written anywhere else.
						openURL(url)
						store.startPolling()
					}
				}
				SecondaryButton(title: language.string("rsv.pay.check")) {
					store.startPolling()
				}
			}
			.padding(20)
		}
		.background(palette.background)
		.navigationTitle(language.string("rsv.pay.title"))
		.navigationBarBackButtonHidden(true)
		.onAppear { store.startPolling() }
		.onDisappear { store.stopPolling() }
		.onChange(of: scenePhase) { _, phase in
			if phase == .active { store.startPolling() }
		}
	}

	@ViewBuilder
	private var statusCard: some View {
		ThemedCard {
			VStack(alignment: .leading, spacing: 8) {
				switch store.flow.paymentOutcome {
				case .review:
					Text(language.string("rsv.pay.review"))
				case .failed:
					Text(language.string("rsv.pay.failed"))
				case .refunded:
					Text(language.string("rsv.pay.refunded"))
				default:
					HStack(spacing: 8) {
						if store.isPolling { ProgressView() }
						Text(language.string("rsv.pay.checking"))
					}
				}
				if case .failed(let failure) = store.flow.phase {
					ErrorBanner(failure: failure)
					SecondaryButton(title: language.string("rsv.confirmed.done")) {
						Task {
							await store.cancelBooking()
							path.removeAll()
						}
					}
				}
			}
			.font(.subheadline)
			.foregroundStyle(palette.cardForeground)
		}
	}
}
