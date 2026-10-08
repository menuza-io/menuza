import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/macro'
import { type FlowNodeType } from '@repo/phone-agent'
import { type IconName } from '@repo/ui/icon'

export type FlowStepCategory = 'start' | 'menu' | 'ai' | 'action' | 'end'

export type FlowStepMeta = {
	icon: IconName
	category: FlowStepCategory
	title: MessageDescriptor
	description: MessageDescriptor
	defaultLabel: MessageDescriptor
}

export const FLOW_STEP_META: Record<FlowNodeType, FlowStepMeta> = {
	start: {
		icon: 'phone',
		category: 'start',
		title: msg`Call comes in`,
		description: msg`Where every call begins.`,
		defaultLabel: msg`Call comes in`,
	},
	play_message: {
		icon: 'message-circle',
		category: 'menu',
		title: msg`Play message`,
		description: msg`Read a message aloud, then continue.`,
		defaultLabel: msg`Play a message`,
	},
	keypad_menu: {
		icon: 'layout-grid',
		category: 'menu',
		title: msg`Keypad menu`,
		description: msg`"Press 1 for…" options. Callers can also say their choice.`,
		defaultLabel: msg`Keypad menu`,
	},
	hours_check: {
		icon: 'clock',
		category: 'menu',
		title: msg`Open or closed`,
		description: msg`Branch on whether you're open right now.`,
		defaultLabel: msg`Open right now?`,
	},
	ai_agent: {
		icon: 'bot',
		category: 'ai',
		title: msg`AI assistant`,
		description: msg`Hand the call to your AI assistant to help the caller.`,
		defaultLabel: msg`AI assistant`,
	},
	text_link: {
		icon: 'send',
		category: 'action',
		title: msg`Text a link`,
		description: msg`Text the caller a link to your website.`,
		defaultLabel: msg`Text the website link`,
	},
	transfer: {
		icon: 'users',
		category: 'action',
		title: msg`Transfer to a number`,
		description: msg`Connect the caller to a person, such as a manager.`,
		defaultLabel: msg`Transfer to the team`,
	},
	voicemail: {
		icon: 'mic',
		category: 'action',
		title: msg`Take a voicemail`,
		description: msg`Record a message for your team to follow up.`,
		defaultLabel: msg`Take a message`,
	},
	hang_up: {
		icon: 'phone-off',
		category: 'end',
		title: msg`Hang up`,
		description: msg`Say goodbye and end the call.`,
		defaultLabel: msg`Goodbye`,
	},
}

export const MENU_STEP_TYPES = [
	'keypad_menu',
	'play_message',
	'hours_check',
] as const satisfies readonly FlowNodeType[]

export const ACTION_STEP_TYPES = [
	'ai_agent',
	'text_link',
	'transfer',
	'voicemail',
	'hang_up',
] as const satisfies readonly FlowNodeType[]

export const HANDLE_LABELS: Record<string, MessageDescriptor> = {
	open: msg`Open`,
	closed: msg`Closed`,
	no_answer: msg`No answer`,
	no_input: msg`No choice`,
}
