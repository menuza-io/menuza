import { type ReactNode } from 'react'

/** Section header of the QR pages under Settings (the layout owns the h1). */
export function QrSettingsHeader({
	title,
	description,
	action,
}: {
	title: string
	description: string
	action?: ReactNode
}) {
	return (
		<div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
			<div className="max-w-prose min-w-0 space-y-2">
				<h2 className="text-xl font-semibold tracking-tight">{title}</h2>
				<p className="text-muted-foreground text-sm leading-relaxed">
					{description}
				</p>
			</div>
			{action}
		</div>
	)
}
