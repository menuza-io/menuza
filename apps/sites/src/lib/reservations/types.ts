/** Shapes of the public `/reservations/*` tenant-api responses the guest pages read. */

export type LargePartyMode = 'contact' | 'request' | 'disabled'

export type LargePartyBlock = {
	mode: LargePartyMode
	maxOnlinePartySize: number
	phone: string | null
	contact?: { name: string; phone: string | null }
	note: string | null
}

export type ReservationLocation = {
	id: string
	name: string
	address: { formattedAddress: string; city?: string | null } | null
	timeZone: string
	phone: string | null
	partySize: { min: number; max: number }
	horizonDays: number
	intervalMin: number
	holdMinutes: number
	largeParty: LargePartyBlock
	waitlist: { enabled: boolean; online: boolean }
	notifyMe: boolean
	/** Seating areas a guest may pick (empty when the restaurant does not offer a choice). */
	areas?: ReservationChip[]
	publicNote: string | null
}

export type ReservationChip = { id: string; name: string }

export type ReservationsConfig = {
	organization: { name: string; defaultLocale: string }
	locations: ReservationLocation[]
	occasions: ReservationChip[]
	dietary: ReservationChip[]
	now: string
}

export type PublicSlot = {
	localMin: number
	time: string
	serviceId: string
	serviceName: string
	/** Set only when the guest may choose the seating area; both fields are already localized. */
	areaId?: string | null
	areaLabel?: string | null
}

export type AvailabilityStatus =
	| 'open'
	| 'available'
	| 'full'
	| 'closed'
	| 'online_closed'
	| 'beyond_horizon'
	| 'large_party'
	| string

export type Availability = {
	now: string
	timeZone: string
	locationId: string
	date: string
	partySize: number
	status: AvailabilityStatus
	slots: PublicSlot[]
	alternatives: {
		sameDay: PublicSlot[]
		otherDates: Array<{ date: string; firstLocalMin: number }>
	}
	largeParty?: LargePartyBlock
	closed?: { reason: string; note: string | null; name: string | null }
	onlineClosed?: { note: string | null; name: string | null }
	notifyMe: boolean
	waitlist: boolean
}

export type CalendarDay = {
	date: string
	hasAvailability: boolean
	status: string
	closed: boolean
	slotCount: number
}

export type CalendarResponse = {
	timeZone: string
	now: string
	days: CalendarDay[]
}

export type SlotRef = {
	date: string
	localMin: number
	partySize: number
	serviceId?: string | null
}

export type HoldResponse = {
	holdToken: string
	expiresAt: string
	now: string
	locationId?: string
	slot: SlotRef
}

export type ReservationSummary = {
	id: string
	confirmationCode: string
	status: string
	channel: string
	locationId: string
	locationName: string | null
	date: string
	localMin: number
	time: string
	startAt: string
	endAt: string
	partySize: number
	timeZone: string
}

export type BookingResponse = {
	reservation: ReservationSummary
	manageToken: string
}

export type ManageView = {
	now: string
	reservation: ReservationSummary & {
		firstName: string | null
		occasion: { id: string; name: string } | null
		requests: string | null
		dietary: string | null
		runningLateMin: number | null
		location: {
			id: string
			name: string | null
			address: string | null
			phone: string | null
			timeZone: string
		}
	}
	status: string
	firstName: string | null
	contact: { phone: string | null; email: string | null }
	policy: {
		kind: string
		terms: string | null
		freeCancelUntilMin: number | null
	} | null
	paymentStatus: string
	canModify: boolean
	canCancel: boolean
	cancelDeadline: string | null
}

export type MineResponse = {
	now: string
	upcoming: Array<ReservationSummary & { manageToken: string }>
	past: Array<ReservationSummary & { manageToken: string }>
}

export type GuestDetails = {
	firstName: string
	lastName: string
	phone: string
	email: string
}

export type WaitlistEntryState =
	| 'waiting'
	| 'notified'
	| 'on_the_way'
	| 'seated'
	| 'cancelled'
	| 'left'
	| 'no_response'

/** `GET /reservations/waitlist/status` and the leave / on-my-way answers. */
export type WaitlistStatus = {
	status: WaitlistEntryState | string
	position: number | null
	partySize: number
	quotedMin: number | null
	quotedReadyAt: string | null
	locationName: string | null
	notifiedAt: string | null
	responseDeadlineAt: string | null
	canLeave: boolean
	canOnMyWay: boolean
	now: string
}

export type WaitlistJoinResponse = {
	entry: {
		id: string
		locationId: string
		locationName: string | null
		status: WaitlistEntryState | string
		position: number | null
		partySize: number
		quotedMin: number | null
		quotedReadyAt: string | null
	}
	statusToken: string
	now: string
}

export type NotifyMeResponse = {
	request: {
		id: string
		status: string
		locationId: string
		date: string
		partySize: number
		fromLocalMin: number
		toLocalMin: number
	}
	cancelToken: string
	now: string
}
