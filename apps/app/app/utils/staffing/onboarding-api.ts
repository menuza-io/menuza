import {
	type CertificateInput,
	type CertificateUpdate,
	type OnboardingApply,
	type OnboardingTaskCreate,
	type OnboardingTaskUpdate,
	type OnboardingTemplateInput,
} from '@repo/staffing'
import {
	applyResultSchema,
	certificateResultSchema,
	taskResultSchema,
	templateResultSchema,
} from './onboarding-types.ts'
import { type StaffClient } from './staff-client.ts'

/**
 * The onboarding writes, one function each, over the browser-direct client
 * (scope `hiring`). Every response is parsed, so a node that answers something
 * unexpected fails loudly here instead of half-updating a screen.
 *
 * Inputs are the request shapes from `@repo/staffing` before defaults are
 * applied (`z.input`), so callers send only what they mean.
 */

const id = (value: string) => encodeURIComponent(value)
const tasksPath = (staffId: string) => `/onboarding/staff/${id(staffId)}/tasks`

export type TaskCreateInput = Omit<
	OnboardingTaskCreate,
	'instructions' | 'linkUrl' | 'assignee' | 'assigneeUserId' | 'dueDate'
> &
	Partial<
		Pick<
			OnboardingTaskCreate,
			'instructions' | 'linkUrl' | 'assignee' | 'assigneeUserId' | 'dueDate'
		>
	>

export async function addOnboardingTask(
	client: StaffClient,
	staffId: string,
	input: TaskCreateInput,
) {
	return taskResultSchema.parse(
		await client.request(tasksPath(staffId), { method: 'POST', json: input }),
	)
}

export async function updateOnboardingTask(
	client: StaffClient,
	staffId: string,
	taskId: string,
	patch: OnboardingTaskUpdate,
) {
	return taskResultSchema.parse(
		await client.request(`${tasksPath(staffId)}/${id(taskId)}`, {
			method: 'PATCH',
			json: patch,
		}),
	)
}

export async function removeOnboardingTask(
	client: StaffClient,
	staffId: string,
	taskId: string,
) {
	await client.request(`${tasksPath(staffId)}/${id(taskId)}`, {
		method: 'DELETE',
	})
}

export async function applyOnboardingTemplate(
	client: StaffClient,
	staffId: string,
	input: OnboardingApply,
) {
	return applyResultSchema.parse(
		await client.request(`/onboarding/staff/${id(staffId)}/apply`, {
			method: 'POST',
			json: input,
		}),
	)
}

export type TemplateSaveInput = Omit<OnboardingTemplateInput, 'tasks'> & {
	tasks: Array<
		Omit<
			OnboardingTemplateInput['tasks'][number],
			'instructions' | 'linkUrl' | 'assignee' | 'assigneeUserId'
		> &
			Partial<
				Pick<
					OnboardingTemplateInput['tasks'][number],
					'instructions' | 'linkUrl' | 'assignee' | 'assigneeUserId'
				>
			>
	>
}

export async function saveOnboardingTemplate(
	client: StaffClient,
	templateId: string | null,
	input: TemplateSaveInput,
) {
	return templateResultSchema.parse(
		await client.request(
			templateId
				? `/onboarding/templates/${id(templateId)}`
				: '/onboarding/templates',
			{ method: templateId ? 'PUT' : 'POST', json: input },
		),
	)
}

export async function archiveOnboardingTemplate(
	client: StaffClient,
	templateId: string,
) {
	await client.request(`/onboarding/templates/${id(templateId)}`, {
		method: 'DELETE',
	})
}

export type CertificateCreateInput = Omit<
	CertificateInput,
	'label' | 'issuedOn' | 'expiresOn' | 'note'
> &
	Partial<Pick<CertificateInput, 'label' | 'issuedOn' | 'expiresOn' | 'note'>>

export async function addCertificate(
	client: StaffClient,
	staffId: string,
	input: CertificateCreateInput,
) {
	return certificateResultSchema.parse(
		await client.request(`/certificates/staff/${id(staffId)}`, {
			method: 'POST',
			json: input,
		}),
	)
}

export async function updateCertificate(
	client: StaffClient,
	staffId: string,
	certificateId: string,
	patch: CertificateUpdate,
) {
	return certificateResultSchema.parse(
		await client.request(
			`/certificates/staff/${id(staffId)}/${id(certificateId)}`,
			{ method: 'PATCH', json: patch },
		),
	)
}

export async function removeCertificate(
	client: StaffClient,
	staffId: string,
	certificateId: string,
) {
	await client.request(
		`/certificates/staff/${id(staffId)}/${id(certificateId)}`,
		{ method: 'DELETE' },
	)
}
