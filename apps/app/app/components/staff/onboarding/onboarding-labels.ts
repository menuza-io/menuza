import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	type CertificateKind,
	type OnboardingAssignee,
	type OnboardingTaskType,
} from '@repo/staffing'
import { type OnboardingTask } from '#app/utils/staffing/onboarding-types.ts'

/**
 * Words for the onboarding screens, one place so the checklist, the template
 * builder and the certificate list say the same thing. The built-in checklist
 * stores no title (only a key), so its wording is translated here, in the
 * language of whoever is reading.
 */

const TASK_TYPES: Record<OnboardingTaskType, MessageDescriptor> = {
	review_profile: msg`Review profile`,
	acknowledge_policy: msg`Acknowledge a policy`,
	form_link: msg`Complete a form`,
	custom: msg`Custom task`,
}

const TASK_TYPE_HINTS: Record<OnboardingTaskType, MessageDescriptor> = {
	review_profile: msg`Check their contact details and emergency contact are right.`,
	acknowledge_policy: msg`Write a policy. You record when they have read and accepted it.`,
	form_link: msg`Link to a form you host elsewhere. Nothing is collected here.`,
	custom: msg`Anything else you need done, like handing over a uniform.`,
}

const ASSIGNEES: Record<OnboardingAssignee, MessageDescriptor> = {
	manager: msg`A manager`,
	staff: msg`The new hire`,
	member: msg`A specific team member`,
}

const BUILTIN_TITLES: Record<string, MessageDescriptor> = {
	confirm_contact: msg`Confirm contact details`,
	emergency_contact: msg`Add an emergency contact`,
	share_house_rules: msg`Share the house rules`,
	set_up_clock_pin: msg`Set up their clock-in PIN`,
	add_to_schedule: msg`Add them to the schedule`,
}

const CERTIFICATE_KINDS: Record<CertificateKind, MessageDescriptor> = {
	food_handler: msg`Food handler card`,
	health_card: msg`Health card`,
	alcohol_service: msg`Alcohol service permit`,
	first_aid: msg`First aid`,
	fire_safety: msg`Fire safety`,
	other: msg`Other`,
}

export function useOnboardingLabels() {
	const { _ } = useLingui()
	return {
		taskType: (type: OnboardingTaskType) => _(TASK_TYPES[type]),
		taskTypeHint: (type: OnboardingTaskType) => _(TASK_TYPE_HINTS[type]),
		assignee: (value: OnboardingAssignee) => _(ASSIGNEES[value]),
		builtinTitle: (key: string) => {
			const found = BUILTIN_TITLES[key]
			return found ? _(found) : null
		},
		/** The title to show: the task's own, else the built-in wording. */
		taskTitle: (task: Pick<OnboardingTask, 'title' | 'taskKey'>) =>
			task.title ??
			(task.taskKey
				? BUILTIN_TITLES[task.taskKey]
					? _(BUILTIN_TITLES[task.taskKey]!)
					: null
				: null) ??
			_(msg`Untitled task`),
		certificateKind: (kind: CertificateKind) => _(CERTIFICATE_KINDS[kind]),
		certificateTitle: (cert: {
			kind: CertificateKind
			label: string | null
		}) =>
			cert.kind === 'other' && cert.label
				? cert.label
				: _(CERTIFICATE_KINDS[cert.kind]),
		/** The built-in starter list, as drafts for a first template. */
		builtinStarter: () =>
			Object.keys(BUILTIN_TITLES).map((key) => ({
				key,
				title: _(BUILTIN_TITLES[key]!),
			})),
	}
}

export type OnboardingLabels = ReturnType<typeof useOnboardingLabels>

export const TASK_TYPE_ORDER: readonly OnboardingTaskType[] = [
	'custom',
	'review_profile',
	'acknowledge_policy',
	'form_link',
]

export const CERTIFICATE_KIND_ORDER: readonly CertificateKind[] = [
	'food_handler',
	'health_card',
	'alcohol_service',
	'first_aid',
	'fire_safety',
	'other',
]
