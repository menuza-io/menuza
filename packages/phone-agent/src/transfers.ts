import { type TransferHoursMode } from './constants.ts'
import {
	type PhoneAgentContact,
	type PhoneAgentSettings,
	type TransferCase,
} from './settings.ts'

function withinHours(mode: TransferHoursMode, isOpen: boolean) {
	return mode === 'always' || isOpen
}

export type TransferAvailability = {
	/** The general staff transfer (escalation phone) can be used now. */
	transfersAvailable: boolean
	availableTransferCaseIds: string[]
}

/** Which transfers the assistant may offer at this moment in the call. */
export function transferAvailability(
	settings: Pick<
		PhoneAgentSettings,
		| 'safety'
		| 'autoEscalate'
		| 'escalationPhone'
		| 'transfers'
		| 'transferCases'
		| 'contacts'
	>,
	isOpen: boolean,
): TransferAvailability {
	if (settings.safety.transfersDisabled) {
		return { transfersAvailable: false, availableTransferCaseIds: [] }
	}
	const contactIds = new Set(settings.contacts.map((contact) => contact.id))
	return {
		transfersAvailable:
			settings.autoEscalate &&
			Boolean(settings.escalationPhone) &&
			withinHours(settings.transfers.hours, isOpen),
		availableTransferCaseIds: settings.transferCases
			.filter(
				(transferCase) =>
					transferCase.isActive &&
					contactIds.has(transferCase.contactId) &&
					withinHours(transferCase.hours, isOpen),
			)
			.map((transferCase) => transferCase.id),
	}
}

export type ResolvedTransfer = {
	phone: string
	/** Extra dial attempts after the first one rings out. */
	retries: number
	contact: PhoneAgentContact | null
	transferCase: TransferCase | null
}

/**
 * The number to dial for a transfer: a transfer case's contact when the
 * assistant names an allowed case, else the general staff phone.
 */
export function resolveTransfer(
	settings: Pick<
		PhoneAgentSettings,
		| 'safety'
		| 'autoEscalate'
		| 'escalationPhone'
		| 'transfers'
		| 'transferCases'
		| 'contacts'
	>,
	isOpen: boolean,
	caseId?: string | null,
): ResolvedTransfer | null {
	const availability = transferAvailability(settings, isOpen)
	if (caseId) {
		if (!availability.availableTransferCaseIds.includes(caseId)) return null
		const transferCase = settings.transferCases.find(
			(candidate) => candidate.id === caseId,
		)
		const contact = settings.contacts.find(
			(candidate) => candidate.id === transferCase?.contactId,
		)
		if (!transferCase || !contact) return null
		return {
			phone: contact.phone,
			retries: transferCase.retries,
			contact,
			transferCase,
		}
	}
	if (!availability.transfersAvailable || !settings.escalationPhone) return null
	return {
		phone: settings.escalationPhone,
		retries: 0,
		contact: null,
		transferCase: null,
	}
}
