import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	hasBlockingProblems,
	type BroadcastProblem,
	type BroadcastProblemCode,
} from '@repo/common/broadcast-checks'
import { type EmailBlock } from '@repo/common/email-blocks'
import { Button } from '@repo/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { Icon } from '@repo/ui/icon'

import { useEmailBlockTypes } from './email/block-meta.ts'

const PROBLEM_TEXT: Record<BroadcastProblemCode, ReturnType<typeof msg>> = {
	starter_text: msg`This block still has the text a new block starts with.`,
	boilerplate_phrase: msg`The message still holds placeholder text such as "lorem ipsum".`,
	empty_message: msg`The message is empty.`,
	empty_image: msg`This image block has no picture.`,
	empty_button_link: msg`This button has no link.`,
	empty_menu_item: msg`This dish block has no dish.`,
	empty_coupon: msg`This coupon block needs a coupon. Choose one under the message, or remove the block.`,
	coupon_missing: msg`The message uses the coupon code tag but has no coupon. Choose a coupon, or remove the tag.`,
	coupon_paused: msg`The coupon's discount is paused, archived or gone. Resume it or choose another coupon.`,
	coupon_ended_before_send: msg`The coupon's discount ends before this would go out. Change its end date or choose another coupon.`,
	audience_zero: msg`Nobody would receive this: no one in the audience is subscribed.`,
	push_merge_tags: msg`A notification can't use merge tags such as a name or a code: it is the same for everyone.`,
}

export function useBroadcastProblemText() {
	const { _ } = useLingui()
	return (code: BroadcastProblemCode) => _(PROBLEM_TEXT[code])
}

/**
 * What is wrong with a broadcast before it goes out (#232). A blocking problem
 * cannot be overridden: the only way forward is Edit. A warning (starter text)
 * can be: Edit, or Send anyway. Each problem inside a block links to it.
 */
export function BroadcastCheckDialog({
	open,
	onOpenChange,
	problems,
	blocks = [],
	scheduling = false,
	onEditBlock,
	onSendAnyway,
	busy = false,
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
	problems: readonly BroadcastProblem[]
	/** The email's blocks, to name the one a problem is in. */
	blocks?: readonly EmailBlock[]
	/** The primary action is Schedule, not Send. */
	scheduling?: boolean
	/** Opens the designer on a block. */
	onEditBlock?: (blockId: string) => void
	onSendAnyway?: () => void
	busy?: boolean
}) {
	const { _ } = useLingui()
	const { getBlockType } = useEmailBlockTypes({
		couponAvailable: true,
		menuItemsAvailable: true,
	})
	const text = useBroadcastProblemText()
	const blocking = hasBlockingProblems(problems)

	const blockName = (blockId: string) => {
		const index = blocks.findIndex((block) => block.id === blockId)
		const block = blocks[index]
		if (!block) return null
		const position = index + 1
		const name = getBlockType(block.type).label
		return _(msg`Block ${position}: ${name}`)
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="gap-4 sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>
						{blocking ? (
							<Trans>Fix this before it goes out</Trans>
						) : (
							<Trans>Check before it goes out</Trans>
						)}
					</DialogTitle>
					<DialogDescription>
						{blocking ? (
							<Trans>
								These problems stop this broadcast. Fix them, then try again.
							</Trans>
						) : (
							<Trans>
								Nothing is broken, but you may want to look at this first.
							</Trans>
						)}
					</DialogDescription>
				</DialogHeader>
				<ul className="max-h-72 space-y-2 overflow-y-auto">
					{problems.map((problem, index) => {
						const where = problem.blockId ? blockName(problem.blockId) : null
						return (
							<li
								key={`${problem.code}-${problem.blockId ?? index}`}
								className="border-border flex items-start gap-3 rounded-lg border p-3 text-sm"
							>
								<Icon
									name={
										problem.severity === 'blocking'
											? 'circle-x'
											: 'alert-triangle'
									}
									className={
										problem.severity === 'blocking'
											? 'text-destructive mt-0.5 size-4 shrink-0'
											: 'mt-0.5 size-4 shrink-0 text-amber-600'
									}
								/>
								<div className="min-w-0 flex-1 space-y-1">
									{where ? (
										<p className="text-muted-foreground text-xs font-medium">
											{where}
										</p>
									) : null}
									<p>{text(problem.code)}</p>
								</div>
								{problem.blockId && onEditBlock ? (
									<Button
										type="button"
										size="sm"
										variant="outline"
										onClick={() => {
											onOpenChange(false)
											onEditBlock(problem.blockId!)
										}}
									>
										<Trans>Edit</Trans>
									</Button>
								) : null}
							</li>
						)
					})}
				</ul>
				<DialogFooter>
					<Button
						type="button"
						variant="outline"
						onClick={() => onOpenChange(false)}
					>
						<Trans>Edit</Trans>
					</Button>
					{!blocking && onSendAnyway ? (
						<Button type="button" onClick={onSendAnyway} disabled={busy}>
							{scheduling ? (
								<Trans>Schedule anyway</Trans>
							) : (
								<Trans>Send anyway</Trans>
							)}
						</Button>
					) : null}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
