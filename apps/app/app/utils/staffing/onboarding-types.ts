import {
	CERTIFICATE_KINDS,
	ONBOARDING_ASSIGNEES,
	ONBOARDING_SOURCES,
	ONBOARDING_STATUSES,
	ONBOARDING_TASK_TYPES,
} from '@repo/staffing'
import { z } from 'zod'

/**
 * Shapes returned by `/operator/hiring/onboarding` and `/operator/hiring/certificates`,
 * parsed in the browser. They mirror the response types in `@repo/staffing`
 * (`onboarding-api.ts`). Enumerations read as plain strings through `.catch`: a
 * value added on a newer node must never make an older screen refuse the page.
 */

const taskType = z.enum(ONBOARDING_TASK_TYPES).catch('custom')
const assignee = z.enum(ONBOARDING_ASSIGNEES).catch('manager')
const status = z.enum(ONBOARDING_STATUSES).catch('todo')
const source = z.enum(ONBOARDING_SOURCES).catch('manual')

export const onboardingTaskSchema = z.object({
	id: z.string(),
	staffId: z.string(),
	taskKey: z.string().nullable(),
	title: z.string().nullable(),
	type: taskType,
	instructions: z.string().nullable(),
	linkUrl: z.string().nullable(),
	assignee,
	assigneeUserId: z.string().nullable(),
	templateId: z.string().nullable(),
	status,
	dueDate: z.string().nullable(),
	sortOrder: z.number(),
	source,
	completedAt: z.number().nullable(),
	completedBy: z.string().nullable(),
	createdAt: z.number(),
})
export type OnboardingTask = z.infer<typeof onboardingTaskSchema>

export const checklistSchema = z.object({
	tasks: z.array(onboardingTaskSchema),
})
export const taskResultSchema = z.object({ task: onboardingTaskSchema })
export const applyResultSchema = z.object({
	tasks: z.array(onboardingTaskSchema),
	created: z.number(),
})

export const templateTaskSchema = z.object({
	id: z.string(),
	type: taskType,
	title: z.string(),
	instructions: z.string().nullable(),
	linkUrl: z.string().nullable(),
	dueInDays: z.number(),
	assignee,
	assigneeUserId: z.string().nullable(),
	sortOrder: z.number(),
})
export type OnboardingTemplateTask = z.infer<typeof templateTaskSchema>

export const templateSchema = z.object({
	id: z.string(),
	name: z.string(),
	isDefault: z.boolean(),
	archivedAt: z.number().nullable(),
	updatedAt: z.number(),
	tasks: z.array(templateTaskSchema),
})
export type OnboardingTemplate = z.infer<typeof templateSchema>

export const templatesSchema = z.object({ templates: z.array(templateSchema) })
export const templateResultSchema = z.object({ template: templateSchema })

export const summarySchema = z.object({
	entries: z.array(
		z.object({
			staffId: z.string(),
			total: z.number(),
			complete: z.number(),
			nextDueDate: z.string().nullable(),
		}),
	),
})
export type OnboardingSummaryRow = z.infer<
	typeof summarySchema
>['entries'][number]

export const certificateSchema = z.object({
	id: z.string(),
	staffId: z.string(),
	kind: z.enum(CERTIFICATE_KINDS).catch('other'),
	label: z.string().nullable(),
	issuedOn: z.string().nullable(),
	expiresOn: z.string().nullable(),
	note: z.string().nullable(),
	createdAt: z.number(),
	updatedAt: z.number(),
})
export type StaffCertificate = z.infer<typeof certificateSchema>

export const certificatesSchema = z.object({
	certificates: z.array(certificateSchema),
})
export const certificateResultSchema = z.object({
	certificate: certificateSchema,
})
