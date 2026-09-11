import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { type EmailBlockType } from '@repo/common/email-blocks'
import { cn } from '@repo/ui'
import { Button } from '@repo/ui/button'
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { Icon } from '@repo/ui/icon'
import { useState } from 'react'

import { useEmailBlockTypes } from './block-meta.ts'

export function AddEmailBlockDialog({
	position,
	onAdd,
	trigger = 'button',
}: {
	position: number
	onAdd: (type: EmailBlockType, position: number) => void
	trigger?: 'button' | 'insert'
}) {
	const { _ } = useLingui()
	const { blockTypes } = useEmailBlockTypes()
	const [open, setOpen] = useState(false)
	const [selected, setSelected] = useState<EmailBlockType>(
		blockTypes[0]?.type ?? 'body',
	)

	const confirmAdd = (type: EmailBlockType = selected) => {
		onAdd(type, position)
		setOpen(false)
	}

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				setOpen(next)
				if (next) setSelected(blockTypes[0]?.type ?? 'body')
			}}
		>
			{trigger === 'insert' ? (
				<button
					type="button"
					className="group/insert relative -my-0.5 flex h-3.5 w-full items-center justify-center"
					onClick={() => setOpen(true)}
					aria-label={_(msg`Insert block here`)}
				>
					<span className="bg-border absolute inset-x-3 h-px origin-center scale-x-0 opacity-0 transition duration-150 ease-out group-hover/insert:scale-x-100 group-hover/insert:opacity-100 group-focus-visible/insert:scale-x-100 group-focus-visible/insert:opacity-100" />
					<span className="border-border bg-background text-muted-foreground relative z-10 flex size-5 items-center justify-center rounded-full border opacity-0 shadow-sm transition duration-150 ease-out group-hover/insert:opacity-100 group-focus-visible/insert:opacity-100">
						<Icon name="plus" className="size-3" />
					</span>
				</button>
			) : (
				<Button
					variant="outline"
					size="sm"
					className="border-dashed"
					onClick={() => setOpen(true)}
				>
					<Icon name="plus" className="size-3.5" />
					<Trans>Add block</Trans>
				</Button>
			)}
			<DialogContent className="gap-5 sm:max-w-xl">
				<DialogHeader>
					<DialogTitle>
						<Trans>Add block</Trans>
					</DialogTitle>
					<DialogDescription>
						<Trans>Pick a block to add to your email.</Trans>
					</DialogDescription>
				</DialogHeader>
				<div
					role="listbox"
					aria-label={_(msg`Block types`)}
					className="grid grid-cols-2 gap-2 sm:grid-cols-3"
				>
					{blockTypes.map((option) => {
						const isSelected = selected === option.type
						return (
							<button
								key={option.type}
								type="button"
								role="option"
								aria-selected={isSelected}
								onClick={() => setSelected(option.type)}
								onFocus={() => setSelected(option.type)}
								onDoubleClick={() => confirmAdd(option.type)}
								className={cn(
									'group/tile border-border hover:bg-muted/50 focus-visible:ring-ring flex flex-col items-start gap-3 rounded-xl border p-3 text-left transition-[background-color,border-color] duration-150 outline-none focus-visible:ring-2',
									isSelected
										? 'border-foreground/30 bg-muted'
										: 'bg-background',
								)}
							>
								<span
									className={cn(
										'flex size-9 items-center justify-center rounded-lg transition-colors',
										isSelected
											? 'bg-foreground text-background'
											: 'bg-muted text-muted-foreground group-hover/tile:text-foreground',
									)}
								>
									<Icon name={option.icon} className="size-4" />
								</span>
								<span className="min-w-0 space-y-1">
									<span className="block text-sm font-medium tracking-tight">
										{option.label}
									</span>
									<span className="text-muted-foreground line-clamp-2 text-xs leading-snug">
										{option.description}
									</span>
								</span>
							</button>
						)
					})}
				</div>
				<DialogFooter className="gap-2 sm:items-center sm:justify-between">
					<p className="text-muted-foreground hidden text-xs sm:block">
						<Trans>Double-click a block to add it instantly</Trans>
					</p>
					<div className="flex gap-2">
						<DialogClose render={<Button variant="outline" />}>
							<Trans>Cancel</Trans>
						</DialogClose>
						<Button onClick={() => confirmAdd()}>
							<Icon name="plus" className="size-4" />
							<Trans>Add block</Trans>
						</Button>
					</div>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
