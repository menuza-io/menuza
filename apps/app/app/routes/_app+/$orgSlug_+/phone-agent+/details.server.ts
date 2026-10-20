import {
	buildAgentInstructions,
	createVerticalContext,
	promptContextFor,
	transferAvailability,
} from '@repo/phone-agent'
import { type LoaderFunctionArgs } from 'react-router'
import { buildRuntimeConfig } from '#app/utils/phone-agent/runtime-config.server.ts'
import { listPhoneAgentHistory } from '#app/utils/phone-agent/settings-history.server.ts'
import {
	loadSettingsPage,
	settingsPageData,
} from '#app/utils/phone-agent/settings-page.server.ts'
import { phoneAgentServerVertical } from '#app/utils/phone-agent/vertical.server.ts'
import { phoneAgentVertical } from '#app/utils/phone-agent/vertical.ts'

/**
 * What the assistant is told at the start of a call, and who changed the
 * agent recently. Loaded when someone opens "Behind the scenes".
 */
export async function loader({ request, params }: LoaderFunctionArgs) {
	const page = await loadSettingsPage(request, params.orgSlug)
	const url = new URL(request.url)
	const scopes = await phoneAgentServerVertical.listScopes(page.orgId)
	const scopeId =
		scopes.find((scope) => scope.id === url.searchParams.get('scope'))?.id ??
		scopes[0]?.id ??
		null
	const stateParam = url.searchParams.get('state')

	const [config, history] = await Promise.all([
		buildRuntimeConfig({
			kind: 'test',
			orgId: page.orgId,
			scopeId,
			flow: 'published',
		}),
		listPhoneAgentHistory(page.orgId),
	])

	let preview: {
		text: string
		isOpen: boolean
		scopeId: string | null
	} | null = null
	if (config.ok) {
		const runtime = { ...config.config, settings: page.settings }
		const now = new Date()
		const isOpen =
			stateParam === 'open'
				? true
				: stateParam === 'closed'
					? false
					: runtime.availability.isOpen
		const transfers = transferAvailability(page.settings, isOpen)
		const context = createVerticalContext(phoneAgentVertical, runtime, {
			isOpen,
			now,
		})
		preview = {
			scopeId: runtime.scopeId,
			isOpen,
			text: buildAgentInstructions(
				promptContextFor(phoneAgentVertical, context, {
					transfersAvailable: transfers.transfersAvailable,
					availableTransferCaseIds: transfers.availableTransferCaseIds,
					menuChoice: null,
				}),
			),
		}
	}

	return settingsPageData({
		scopes: scopes.map(({ id, name }) => ({ id, name })),
		preview,
		history,
	})
}
