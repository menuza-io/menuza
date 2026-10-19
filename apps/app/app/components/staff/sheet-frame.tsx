import {
	SheetDescription,
	SheetFooter,
	SheetHeader,
	SheetTitle,
} from '@repo/ui/sheet'
import { type FormEvent, type ReactNode } from 'react'

/**
 * Shared chrome for every Team sheet: a title row, a scrolling body and, for
 * forms, a footer that stays in reach. The sheet's own close button and the
 * Escape key are the exits; nothing is saved until a footer action is pressed.
 */
export function SheetPanel({
	title,
	description,
	children,
	headerExtra,
}: {
	title: ReactNode
	description?: ReactNode
	children: ReactNode
	headerExtra?: ReactNode
}) {
	return (
		<>
			<SheetHeader className="border-b pe-12 rtl:ps-12 rtl:pe-4">
				<div className="flex items-start justify-between gap-3">
					<div className="flex min-w-0 flex-col gap-1">
						<SheetTitle className="text-base">{title}</SheetTitle>
						{description ? (
							<SheetDescription>{description}</SheetDescription>
						) : null}
					</div>
					{headerExtra}
				</div>
			</SheetHeader>
			<div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-4">
				{children}
			</div>
		</>
	)
}

export function SheetForm({
	title,
	description,
	onSubmit,
	children,
	footer,
	headerExtra,
}: {
	title: ReactNode
	description?: ReactNode
	onSubmit: (event: FormEvent<HTMLFormElement>) => void
	children: ReactNode
	footer: ReactNode
	/** Sits beside the title, e.g. the content-language switcher. */
	headerExtra?: ReactNode
}) {
	return (
		<>
			<SheetHeader className="border-b pe-12 rtl:ps-12 rtl:pe-4">
				{headerExtra ? (
					<div className="flex items-start justify-between gap-3">
						<div className="flex min-w-0 flex-col gap-1">
							<SheetTitle className="text-base">{title}</SheetTitle>
							{description ? (
								<SheetDescription>{description}</SheetDescription>
							) : null}
						</div>
						{headerExtra}
					</div>
				) : (
					<>
						<SheetTitle className="text-base">{title}</SheetTitle>
						{description ? (
							<SheetDescription>{description}</SheetDescription>
						) : null}
					</>
				)}
			</SheetHeader>
			<form
				onSubmit={onSubmit}
				noValidate
				className="flex min-h-0 flex-1 flex-col"
			>
				<div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4 *:shrink-0">
					{children}
				</div>
				<SheetFooter className="border-t sm:flex-row sm:justify-end">
					{footer}
				</SheetFooter>
			</form>
		</>
	)
}
