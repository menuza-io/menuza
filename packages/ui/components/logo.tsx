import { brand } from '@repo/config/brand'
import { cn } from '../lib/utils'

export function Logo({
	className,
	size: _size = 34,
}: {
	className?: string
	size?: number
}) {
	return (
		<div className={cn('flex items-center gap-2', className)}>
			<div className="flex size-7 shrink-0 items-center justify-center">
				<svg
					aria-hidden="true"
					viewBox="0 0 34 21"
					fill="none"
					className="h-4.75 w-7.75 shrink-0 pr-2"
				>
					<path
						d="M28.4 20.638H33.5V2.83797C33.5 0.337973 30.4 -0.962027 28.5 0.837973L21.6 7.23797C19.2 9.63797 15.1 10.338 12 7.43797L5.5 0.937973C3.5 -0.862027 0.3 0.237973 0 2.53797V20.638H5.7V12.838C5.7 11.438 4.5 9.43797 4.5 9.43797C7.5 11.238 11 12.038 16.8 12.138C21.2 12.138 26.2 11.538 29.1 9.53797C29.1 9.53797 27.8 11.338 27.8 12.638V20.638H28.4Z"
						fill="currentColor"
					></path>
					<path
						d="M9.90002 14.938C10.4 17.238 12.6 20.638 16.8 20.738C20.6 20.738 23 18.138 23.8 15.038C19 15.938 14.9 16.038 9.90002 14.938Z"
						fill="currentColor"
					></path>
				</svg>
			</div>
			<div className="max-w-40 overflow-hidden whitespace-nowrap opacity-100 transition-[max-width,opacity] duration-150 ease-out group-data-[collapsible=icon]:max-w-0 group-data-[collapsible=icon]:opacity-0 motion-reduce:transition-none">
				{brand.name}
			</div>
		</div>
	)
}
