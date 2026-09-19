import { Trans } from '@lingui/macro'
import { Button } from '@repo/ui/button'
import {
	Sheet,
	SheetContent,
	SheetFooter,
	SheetHeader,
	SheetTitle,
} from '@repo/ui/sheet'
import { type ReactNode } from 'react'

import { MenuScopeBadge } from './menu-scope-badge.tsx'

export function MenuEditorSheet({
	open,
	title,
	operatorContext,
	onClose,
	children,
	footer,
}: {
	open: boolean
	title: ReactNode
	operatorContext: 'brand' | 'branch'
	onClose: () => void
	children: ReactNode
	footer?: ReactNode
}) {
	return (
		<Sheet open={open} onOpenChange={(next) => !next && onClose()}>
			<SheetContent
				side="right"
				showCloseButton={false}
				className="flex w-full flex-col gap-0 p-0 sm:max-w-xl"
			>
				<SheetHeader className="border-b px-4 py-4">
					<SheetTitle className="flex flex-wrap items-center gap-2">
						{title}
						<MenuScopeBadge operatorContext={operatorContext} />
					</SheetTitle>
				</SheetHeader>
				<div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4">
					{children}
				</div>
				{footer ?? (
					<SheetFooter className="flex-row justify-end gap-2 border-t px-4 py-3">
						<Button variant="outline" onClick={onClose}>
							<Trans>Cancel</Trans>
						</Button>
					</SheetFooter>
				)}
			</SheetContent>
		</Sheet>
	)
}
