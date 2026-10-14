import { type ScheduleNotifyMode, type ScheduleScope } from '@repo/staffing'
import { z } from 'zod'
import {
	availabilityListSchema,
	availabilitySchema,
	copyResultSchema,
	linkStatusSchema,
	noticesSchema,
	publicationsSchema,
	publishResultSchema,
	recommendSchema,
	resendResultSchema,
	shiftDeleteSchema,
	shiftRequestResultSchema,
	shiftWriteSchema,
	templateSchema,
	timeOffSchema,
} from './schedule-types.ts'
import { type StaffClient } from './staff-client.ts'

/**
 * The schedule writes, one function each, over the browser-direct client.
 * Every response is parsed, so a node that answers something unexpected fails
 * loudly here instead of half-updating a screen. Nothing here carries a name,
 * a time or a wage to the control plane: it all goes browser to regional node.
 */

function id(value: string): string {
	return encodeURIComponent(value)
}

// ---- Shifts -----------------------------------------------------------------

export type CreateShiftsInput = {
	scopeId: string
	/** Null or absent makes an open shift. */
	staffId?: string | null
	positionId?: string | null
	dates: string[]
	startTime: string
	endTime: string
	unpaidBreakMinutes?: number
	notes?: string | null
}

export async function createShifts(
	client: StaffClient,
	body: CreateShiftsInput,
) {
	return shiftWriteSchema.parse(
		await client.request('/shifts', { method: 'POST', json: body }),
	)
}

export type UpdateShiftInput = {
	expectedVersion?: number
	date?: string
	startTime?: string
	endTime?: string
	positionId?: string | null
	staffId?: string | null
	unpaidBreakMinutes?: number
	notes?: string | null
}

export async function updateShift(
	client: StaffClient,
	shiftId: string,
	body: UpdateShiftInput,
) {
	return shiftWriteSchema.parse(
		await client.request(`/shifts/${id(shiftId)}`, {
			method: 'PATCH',
			json: body,
		}),
	)
}

export async function deleteShift(
	client: StaffClient,
	shiftId: string,
	expectedVersion?: number,
) {
	const query = expectedVersion ? `?expectedVersion=${expectedVersion}` : ''
	return shiftDeleteSchema.parse(
		await client.request(`/shifts/${id(shiftId)}${query}`, {
			method: 'DELETE',
		}),
	)
}

export async function assignShift(
	client: StaffClient,
	shiftId: string,
	staffId: string | null,
	expectedVersion?: number,
) {
	return shiftWriteSchema.parse(
		await client.request(
			`/shifts/${id(shiftId)}/${staffId ? 'assign' : 'unassign'}`,
			{
				method: 'POST',
				json: staffId ? { staffId, expectedVersion } : { expectedVersion },
			},
		),
	)
}

export async function revertShift(client: StaffClient, shiftId: string) {
	return shiftWriteSchema.parse(
		await client.request(`/shifts/${id(shiftId)}/revert`, { method: 'POST' }),
	)
}

// ---- Copy, templates, recommend, publish ------------------------------------

export async function copyWeek(
	client: StaffClient,
	body: {
		scopeId: string
		fromWeekStart: string
		toWeekStart: string
		scope: ScheduleScope
		includeOpenShifts: boolean
	},
) {
	return copyResultSchema.parse(
		await client.request('/copy', { method: 'POST', json: body }),
	)
}

export async function createTemplate(
	client: StaffClient,
	body: {
		scopeId: string
		name: string
		fromWeekStart: string
		scope: ScheduleScope
		keepAssignments: boolean
	},
) {
	return templateSchema.parse(
		await client.request('/templates', { method: 'POST', json: body }),
	)
}

export async function applyTemplate(
	client: StaffClient,
	templateId: string,
	body: { weekStart: string; assignments: 'keep' | 'open' },
) {
	return copyResultSchema.parse(
		await client.request(`/templates/${id(templateId)}/apply`, {
			method: 'POST',
			json: body,
		}),
	)
}

export async function deleteTemplate(client: StaffClient, templateId: string) {
	return z.object({ id: z.string() }).parse(
		await client.request(`/templates/${id(templateId)}`, {
			method: 'DELETE',
		}),
	)
}

export async function recommendWeek(
	client: StaffClient,
	body: {
		scopeId: string
		baseWeekStart: string
		targetWeekStart: string
		scope: ScheduleScope
		apply: boolean
	},
) {
	return recommendSchema.parse(
		await client.request('/recommend', { method: 'POST', json: body }),
	)
}

export async function publishWeek(
	client: StaffClient,
	body: {
		scopeId: string
		weekStart: string
		notifyMode: ScheduleNotifyMode
		expectedVersion?: number
	},
) {
	return publishResultSchema.parse(
		await client.request('/publish', { method: 'POST', json: body }),
	)
}

export async function listPublications(
	client: StaffClient,
	query: { scopeId: string; weekStart?: string },
) {
	const params = new URLSearchParams({ scopeId: query.scopeId })
	if (query.weekStart) params.set('weekStart', query.weekStart)
	return publicationsSchema.parse(
		await client.request(`/publications?${params}`),
	)
}

export async function loadNotices(client: StaffClient, publicationId: string) {
	return noticesSchema.parse(
		await client.request(`/publications/${id(publicationId)}/notices`),
	)
}

/** `unsent` leaves people who already got it alone; `all` tells everyone again. */
export async function resendNotices(
	client: StaffClient,
	publicationId: string,
	scope: 'unsent' | 'all',
) {
	return resendResultSchema.parse(
		await client.request(`/publications/${id(publicationId)}/resend`, {
			method: 'POST',
			json: { scope },
		}),
	)
}

// ---- A person's "my schedule" link --------------------------------------------

export async function loadLinkStatus(client: StaffClient, staffId: string) {
	return linkStatusSchema.parse(await client.request(`/links/${id(staffId)}`))
}

export async function revokeLink(client: StaffClient, staffId: string) {
	return linkStatusSchema.parse(
		await client.request(`/links/${id(staffId)}/revoke`, {
			method: 'POST',
			json: {},
		}),
	)
}

// ---- Time off and availability ----------------------------------------------

export type TimeOffInput = {
	staffId: string
	category: 'unpaid' | 'pto' | 'sick'
	startDate: string
	endDate: string
	allDay: boolean
	startTime?: string
	endTime?: string
	note?: string | null
	submission?: 'manager_entered' | 'staff_request'
}

export async function createTimeOff(client: StaffClient, body: TimeOffInput) {
	return timeOffSchema.parse(
		await client.request('/time-off', { method: 'POST', json: body }),
	)
}

export async function decideTimeOff(
	client: StaffClient,
	requestId: string,
	body: { decision: 'approve' | 'reject'; note?: string },
) {
	return timeOffSchema.parse(
		await client.request(`/time-off/${id(requestId)}/decision`, {
			method: 'POST',
			json: body,
		}),
	)
}

export async function cancelTimeOff(client: StaffClient, requestId: string) {
	return timeOffSchema.parse(
		await client.request(`/time-off/${id(requestId)}/cancel`, {
			method: 'POST',
		}),
	)
}

export type AvailabilityRowInput = {
	kind: 'weekly' | 'one_off'
	weekday?: number
	date?: string
	availability: 'available' | 'unavailable'
	allDay: boolean
	startTime?: string
	endTime?: string
	effectiveFrom?: string
	effectiveTo?: string
	note?: string | null
}

export async function createAvailability(
	client: StaffClient,
	body: {
		staffId: string
		rows: AvailabilityRowInput[]
		replaceWeekly: boolean
		submission?: 'manager_entered' | 'staff_request'
	},
) {
	return availabilityListSchema.parse(
		await client.request('/availability', { method: 'POST', json: body }),
	)
}

export async function decideAvailability(
	client: StaffClient,
	body: { ids: string[]; decision: 'approve' | 'reject'; note?: string },
) {
	return availabilityListSchema.parse(
		await client.request('/availability/decision', {
			method: 'POST',
			json: body,
		}),
	)
}

export async function cancelAvailability(
	client: StaffClient,
	availabilityId: string,
) {
	return availabilitySchema.parse(
		await client.request(`/availability/${id(availabilityId)}/cancel`, {
			method: 'POST',
		}),
	)
}

// ---- Swap, cover and drop requests --------------------------------------------

export async function decideShiftRequest(
	client: StaffClient,
	requestId: string,
	body: { decision: 'approve' | 'reject'; note?: string },
) {
	return shiftRequestResultSchema.parse(
		await client.request(`/requests/${id(requestId)}/decision`, {
			method: 'POST',
			json: body,
		}),
	)
}
