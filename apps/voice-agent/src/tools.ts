import { llm } from '@livekit/agents'
import {
	type AgentLanguage,
	callPurposeIds,
	type CallRequestType,
	callRequestTypeIds,
	callRequestTypesFor,
	LANGUAGE_NAMES,
	type VerticalTool,
} from '@repo/phone-agent'
import { z } from 'zod'
import { type CallController } from './controller.ts'
import { normalizeE164 } from './job-metadata.ts'

type AgentTool = ReturnType<typeof llm.tool>

/**
 * What call-changing tools answer while a transfer rings. The model is muted
 * then, so this only guards a tool call already in flight.
 */
export const TRANSFER_IN_PROGRESS = {
	error:
		'A transfer to the team is in progress. Do not say anything or take any action until it finishes.',
}

function asEnum(values: readonly string[]) {
	return values as [string, ...string[]]
}

function requestTool(controller: CallController) {
	const definitions = callRequestTypesFor(controller.vertical)
	const kinds = definitions.map((definition) => definition.label.toLowerCase())
	const list =
		kinds.length > 1
			? `${kinds.slice(0, -1).join(', ')}, or ${kinds.at(-1)}`
			: (kinds[0] ?? '')
	return llm.tool({
		description: `Save a request for the team${list ? ` (${list})` : ''}. Call once all details are collected.`,
		parameters: z.object({
			type: z
				.enum(asEnum(callRequestTypeIds(controller.vertical)))
				.optional()
				.describe('Kind of request'),
			callerName: z.string().optional(),
			callbackPhone: z
				.string()
				.optional()
				.describe('Only if different from the number they are calling from'),
			details: z
				.array(
					z.object({
						field: z
							.string()
							.describe('Short key, for example preferred_time or message'),
						value: z.string(),
					}),
				)
				.max(20),
		}),
		onDuplicate: 'reject',
		execute: async ({ type, callerName, callbackPhone, details }) => {
			if (controller.transferInProgress) return TRANSFER_IN_PROGRESS
			const requestType: CallRequestType = type ?? 'callback'
			const callerPhone = normalizeE164(callbackPhone) ?? controller.callerPhone
			await controller.services.createRequest({
				orgId: controller.config.organization.id,
				callId: controller.callId,
				type: requestType,
				callerName: callerName?.trim() || null,
				callerPhone,
				details: Object.fromEntries(
					details
						.filter((entry) => entry.field.trim() && entry.value.trim())
						.map((entry) => [
							entry.field.trim().slice(0, 60),
							entry.value.trim().slice(0, 1000),
						]),
				),
			})
			controller.state.requests.push(requestType)
			return { saved: true, note: 'Tell the caller the team will follow up.' }
		},
	})
}

function coreTools(controller: CallController) {
	const tools: Record<string, AgentTool> = {
		get_business_info: llm.tool({
			description:
				'Get hours, address, and other details about the business, and whether it is open now.',
			execute: async () => {
				controller.state.toolsUsed.add('get_business_info')
				return {
					openNow: controller.isOpen,
					nextOpen: controller.config.availability.nextOpen,
					details: controller.businessSummary(),
				}
			},
		}),
		set_call_purpose: llm.tool({
			description:
				'Record the main reason for this call, for the call log. Call once, near the end.',
			parameters: z.object({
				purpose: z.enum(asEnum(callPurposeIds(controller.vertical))),
			}),
			execute: async ({ purpose }) => {
				controller.state.declaredPurpose = purpose
				return { saved: true }
			},
		}),
		end_call: llm.tool({
			description:
				'Hang up after the caller says goodbye or confirms they have everything they need.',
			execute: async () => {
				if (controller.transferInProgress) return TRANSFER_IN_PROGRESS
				controller.endCall(undefined, { survey: true })
				return undefined
			},
		}),
	}
	const transfers = controller.transfers
	const unavailable = {
		error:
			"Transfers aren't available right now. Tell the caller, and offer to take a message for the team.",
	}
	if (transfers.transfersAvailable) {
		tools.transfer_to_staff = llm.tool({
			description:
				'Transfer the caller to a person on the team. Use when they are upset, ask for a person twice, or you cannot help them.',
			parameters: z.object({
				reason: z.string().describe('Why, in a few words'),
			}),
			onDuplicate: 'reject',
			execute: async () => {
				if (controller.transferInProgress) return TRANSFER_IN_PROGRESS
				return controller.transferFromAssistant() ? undefined : unavailable
			},
		})
	}
	if (transfers.availableTransferCaseIds.length) {
		tools.transfer_to_contact = llm.tool({
			description:
				'Transfer the caller to the contact for one of the transfer cases in your instructions.',
			parameters: z.object({
				caseId: z
					.enum(asEnum(transfers.availableTransferCaseIds))
					.describe('The transfer case id'),
			}),
			onDuplicate: 'reject',
			execute: async ({ caseId }) => {
				if (controller.transferInProgress) return TRANSFER_IN_PROGRESS
				return controller.transferFromAssistant(caseId)
					? undefined
					: unavailable
			},
		})
	}
	const { languages } = controller.settings
	if (languages.length > 1) {
		tools.switch_language = llm.tool({
			description:
				'Switch speech recognition and your voice to another language for the rest of the call. Call it as soon as the caller speaks or asks for that language, before replying in it.',
			parameters: z.object({
				language: z
					.enum(languages as [AgentLanguage, ...AgentLanguage[]])
					.describe(
						`Language code: ${languages.map((code) => `${code} (${LANGUAGE_NAMES[code]})`).join(', ')}`,
					),
			}),
			execute: async ({ language }) => {
				if (!controller.switchLanguage(language)) {
					return {
						error: `Could not switch to ${LANGUAGE_NAMES[language]}. Keep speaking ${LANGUAGE_NAMES[controller.language]}.`,
					}
				}
				return {
					switched: true,
					note: `Reply in ${LANGUAGE_NAMES[language]} from now on.`,
				}
			},
		})
	}
	const tagIds = controller.settings.tags.map((tag) => tag.id)
	if (tagIds.length) {
		tools.tag_call = llm.tool({
			description:
				'Tag this call for the team when one of the tags in your instructions applies.',
			parameters: z.object({
				tagId: z.string().describe('The tag id'),
			}),
			execute: async ({ tagId }) => {
				const id = tagId.trim()
				if (!tagIds.includes(id)) {
					return { error: `"${tagId}" is not one of this business's tags.` }
				}
				return controller.state.addTag(id)
					? { tagged: true }
					: { error: 'This call already has the maximum number of tags.' }
			},
		})
	}
	tools.record_request = requestTool(controller)
	return tools
}

/** The model gets JSON back, never live references to the call's state. */
function toJson(value: unknown): unknown {
	return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

/**
 * A framework-free vertical tool as a LiveKit tool: it records the tool as
 * used and applies the same duplicate and transfer guards as the core tools.
 */
export function adaptVerticalTool(
	controller: CallController,
	tool: VerticalTool,
): AgentTool {
	return llm.tool({
		description: tool.description,
		...(tool.parameters ? { parameters: tool.parameters } : {}),
		...(tool.rejectDuplicates ? { onDuplicate: 'reject' as const } : {}),
		execute: async (args: Record<string, unknown>) => {
			controller.state.toolsUsed.add(tool.name)
			if (tool.blockedDuringTransfer && controller.transferInProgress) {
				return TRANSFER_IN_PROGRESS
			}
			return toJson(await tool.execute(args ?? {}, controller.toolContext()))
		},
	})
}

/** The core tools, then the vertical's (which can't replace a core tool). */
export function buildAgentTools(controller: CallController) {
	const tools = coreTools(controller)
	for (const tool of controller.verticalTools()) {
		if (tools[tool.name]) {
			console.warn('Skipping a vertical tool that reuses a core tool name', {
				tool: tool.name,
			})
			continue
		}
		tools[tool.name] = adaptVerticalTool(controller, tool)
	}
	return tools
}
