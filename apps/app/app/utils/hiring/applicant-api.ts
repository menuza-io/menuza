import {
	type HiringDecline,
	type HiringHire,
	type HiringOpenStage,
	type InterviewCreate,
	type InterviewUpdate,
} from '@repo/staffing'
import { type StaffClient } from '#app/utils/staffing/staff-client.ts'
import {
	declineResultSchema,
	hireResultSchema,
	interviewResultSchema,
	noteResultSchema,
	stageMoveResultSchema,
} from './applicant-types.ts'

/**
 * The applicant writes, one function each, over the browser-direct client
 * (scope `hiring`). Every response is parsed, so a node that answers something
 * unexpected fails loudly here instead of half-updating a screen.
 */

const base = '/applications'
const id = (value: string) => encodeURIComponent(value)

export async function moveApplicant(
	client: StaffClient,
	applicationId: string,
	stage: HiringOpenStage,
) {
	return stageMoveResultSchema.parse(
		await client.request(`${base}/${id(applicationId)}/stage`, {
			method: 'POST',
			json: { stage },
		}),
	)
}

export async function addApplicantNote(
	client: StaffClient,
	applicationId: string,
	body: string,
) {
	return noteResultSchema.parse(
		await client.request(`${base}/${id(applicationId)}/notes`, {
			method: 'POST',
			json: { body },
		}),
	)
}

export async function removeApplicantNote(
	client: StaffClient,
	applicationId: string,
	noteId: string,
) {
	await client.request(`${base}/${id(applicationId)}/notes/${id(noteId)}`, {
		method: 'DELETE',
	})
}

export async function scheduleInterview(
	client: StaffClient,
	applicationId: string,
	input: InterviewCreate,
) {
	return interviewResultSchema.parse(
		await client.request(`${base}/${id(applicationId)}/interviews`, {
			method: 'POST',
			json: input,
		}),
	)
}

export async function updateInterview(
	client: StaffClient,
	applicationId: string,
	interviewId: string,
	input: InterviewUpdate,
) {
	return interviewResultSchema.parse(
		await client.request(
			`${base}/${id(applicationId)}/interviews/${id(interviewId)}`,
			{ method: 'PATCH', json: input },
		),
	)
}

export async function declineApplicant(
	client: StaffClient,
	applicationId: string,
	input: HiringDecline,
) {
	return declineResultSchema.parse(
		await client.request(`${base}/${id(applicationId)}/decline`, {
			method: 'POST',
			json: input,
		}),
	)
}

export async function hireApplicant(
	client: StaffClient,
	applicationId: string,
	input: HiringHire,
) {
	return hireResultSchema.parse(
		await client.request(`${base}/${id(applicationId)}/hire`, {
			method: 'POST',
			json: input,
		}),
	)
}

export async function eraseApplicant(
	client: StaffClient,
	applicationId: string,
) {
	await client.request(`${base}/${id(applicationId)}`, { method: 'DELETE' })
}
