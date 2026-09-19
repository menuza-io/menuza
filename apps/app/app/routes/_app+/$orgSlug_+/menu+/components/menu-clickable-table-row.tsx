import { cn } from '@repo/ui'
import { TableRow } from '@repo/ui/table'
import { type MouseEvent, type ReactNode } from 'react'
import { useNavigate } from 'react-router'

export function MenuClickableTableRow({
	to,
	children,
	className,
}: {
	to: string
	children: ReactNode
	className?: string
}) {
	const navigate = useNavigate()
	return (
		<TableRow
			tabIndex={0}
			role="link"
			className={cn('cursor-pointer', className)}
			onClick={() => void navigate(to)}
			onKeyDown={(event) => {
				if (event.key === 'Enter' || event.key === ' ') {
					event.preventDefault()
					void navigate(to)
				}
			}}
		>
			{children}
		</TableRow>
	)
}

export function stopRowClick(event: MouseEvent) {
	event.stopPropagation()
}
