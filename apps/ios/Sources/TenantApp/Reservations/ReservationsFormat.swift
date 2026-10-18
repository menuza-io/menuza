import Foundation
import TenantKit

/// Display helpers for the reservation screens. Server values (`date`, `time`)
/// are the business-day strings in the location's time zone; nothing here
/// converts them to the device's zone.
enum ReservationsFormat {
	/// Wraps text that must keep its own direction (times, phone numbers,
	/// amounts) in a left-to-right isolate so it reads correctly in Arabic.
	static func ltr(_ text: String) -> String {
		"\u{2066}\(text)\u{2069}"
	}

	/// "Mon, Jun 24" for a `yyyy-MM-dd` business date, in the app language.
	static func dateLabel(_ date: String, locale: Locale) -> String {
		guard let parsed = parse(date) else { return date }
		var calendar = Calendar(identifier: .gregorian)
		calendar.timeZone = TimeZone(secondsFromGMT: 0)!
		let formatter = DateFormatter()
		formatter.locale = locale
		formatter.calendar = calendar
		formatter.timeZone = calendar.timeZone
		formatter.setLocalizedDateFormatFromTemplate("EEEMMMd")
		return formatter.string(from: parsed)
	}

	static func shortWeekday(_ date: String, locale: Locale) -> String {
		guard let parsed = parse(date) else { return "" }
		let formatter = DateFormatter()
		formatter.locale = locale
		formatter.timeZone = TimeZone(secondsFromGMT: 0)
		formatter.setLocalizedDateFormatFromTemplate("EEE")
		return formatter.string(from: parsed)
	}

	static func dayNumber(_ date: String) -> String {
		String(date.suffix(2).drop(while: { $0 == "0" }))
	}

	private static func parse(_ date: String) -> Date? {
		let formatter = DateFormatter()
		formatter.locale = Locale(identifier: "en_US_POSIX")
		formatter.timeZone = TimeZone(secondsFromGMT: 0)
		formatter.dateFormat = "yyyy-MM-dd"
		return formatter.date(from: date)
	}

	/// "5:00 PM" for an instant, in the booking's own time zone.
	static func timeOfDay(_ date: Date, timeZone identifier: String, locale: Locale) -> String {
		let formatter = DateFormatter()
		formatter.locale = locale
		formatter.timeZone = TimeZone(identifier: identifier) ?? TimeZone(secondsFromGMT: 0)
		formatter.setLocalizedDateFormatFromTemplate("jmm")
		return ltr(formatter.string(from: date))
	}

	/// "$25.00" from minor units, using the currency's own number of decimals.
	static func money(_ minor: Int, currency: String, locale: Locale) -> String {
		let formatter = NumberFormatter()
		formatter.numberStyle = .currency
		formatter.locale = locale
		formatter.currencyCode = currency
		let digits = max(formatter.maximumFractionDigits, 0)
		let divisor = pow(10.0, Double(digits))
		return formatter.string(from: NSNumber(value: Double(minor) / divisor)) ?? "\(minor)"
	}

	/// "6:42" for a countdown in seconds.
	static func clock(_ seconds: TimeInterval) -> String {
		let total = Int(max(0, seconds).rounded(.up))
		return String(format: "%d:%02d", total / 60, total % 60)
	}
}

extension BookingFailure {
	var isSlotUnavailable: Bool {
		if case .slotUnavailable = self { return true }
		return false
	}

	/// The localized message for a failure (`Localizable.strings`, `rsv.error.*`).
	var messageKey: String {
		switch self {
		case .slotUnavailable: return "rsv.error.slotUnavailable"
		case .holdExpired: return "rsv.error.holdExpired"
		case .policyRequired: return "rsv.error.policyRequired"
		case .paymentUnavailable: return "rsv.error.paymentUnavailable"
		case .rateLimited(let reason):
			return reason == "phone_active_limit" ? "rsv.error.tooManyActive" : "rsv.error.rateLimited"
		case .signInRequired: return "rsv.error.signIn"
		case .phoneOverlap: return "rsv.error.phoneOverlap"
		case .partySizeInvalid: return "rsv.error.partySize"
		case .invalid: return "rsv.error.invalid"
		case .largePartyOnly: return "rsv.error.largeParty"
		case .requestsClosed: return "rsv.error.requestsClosed"
		case .paused: return "rsv.error.paused"
		case .notFound: return "rsv.error.notFound"
		case .alreadyOnWaitlist: return "rsv.error.waitlistDuplicate"
		case .waitlistFull: return "rsv.error.waitlistFull"
		case .paymentFailed: return "rsv.pay.failed"
		case .paymentRefunded: return "rsv.pay.refunded"
		case .offline: return "rsv.error.offline"
		case .idempotencyConflict, .generic: return "rsv.error.generic"
		}
	}
}

/// `rsv.status.<status>` keys; an unknown status falls back to a generic label.
func reservationStatusKey(_ status: String) -> String {
	let known: Set<String> = [
		"requested", "pending_payment", "booked", "confirmed", "arrived", "seated",
		"finished", "cancelled", "no_show", "declined", "expired",
	]
	return known.contains(status) ? "rsv.status.\(status)" : "rsv.status.other"
}
