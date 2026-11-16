import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Button } from '@repo/ui/button'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from '@repo/ui/dropdown-menu'
import { Icon } from '@repo/ui/icon'
import { useState } from 'react'
import { useAiDraftConfig } from './ai-draft-config.tsx'
import {
	requestAiRewrite,
	type AiDraftErrorCode,
	type RewriteInstruction,
} from './ai-draft-client.ts'

/**
 * "Rewrite with AI" on a selected block's text (#155): shorter, warmer, or
 * translated. It only returns replacement text for the field, which the host
 * puts in the editor; nothing is saved or sent. Renders nothing where drafts
 * are not available.
 */
export function RewriteWithAi({
	text,
	onRewrite,
	sms,
}: {
	text: string
	onRewrite: (text: string) => void
	/** The text is a text message: the rewrite must still fit with its footer. */
	sms?: boolean
}) {
	const { _ } = useLingui()
	const config = useAiDraftConfig()
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<AiDraftErrorCode | null>(null)
	if (!config) return null

	const run = async (instruction: RewriteInstruction) => {
		setBusy(true)
		setError(null)
		const result = await requestAiRewrite(config, { text, instruction, sms })
		setBusy(false)
		if (!result.ok) {
			setError(result.error)
			return
		}
		onRewrite(result.value)
	}

	const options: Array<{ value: RewriteInstruction; label: string }> = [
		{ value: 'shorter', label: _(msg`Make it shorter`) },
		{ value: 'warmer', label: _(msg`Make it warmer`) },
		{ value: 'arabic', label: _(msg`Translate to Arabic`) },
		{ value: 'english', label: _(msg`Translate to English`) },
	]

	return (
		<div className="space-y-1">
			<DropdownMenu>
				<DropdownMenuTrigger
					render={
						<Button
							type="button"
							variant="ghost"
							size="sm"
							className="gap-1.5"
							disabled={busy || text.trim().length === 0}
						/>
					}
				>
					<Icon name="sparkles" className="size-3.5" />
					{busy ? <Trans>Rewriting…</Trans> : <Trans>Rewrite with AI</Trans>}
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start">
					{options.map((option) => (
						<DropdownMenuItem
							key={option.value}
							onClick={() => void run(option.value)}
						>
							{option.label}
						</DropdownMenuItem>
					))}
				</DropdownMenuContent>
			</DropdownMenu>
			{error ? (
				<p role="alert" className="text-destructive text-xs">
					{error === 'ai_draft_limit'
						? _(msg`You have reached the limit for AI drafts. Please try again later.`)
						: _(msg`That rewrite could not be used. Please try again.`)}
				</p>
			) : null}
		</div>
	)
}
