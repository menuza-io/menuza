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
			<div className="bg-foreground text-background flex size-6 shrink-0 items-center justify-center rounded-[28%]">
				<svg
					xmlns="http://www.w3.org/2000/svg"
					width="15"
					height="15"
					viewBox="0 0 24 24"
					aria-hidden="true"
				>
					<path
						fill="none"
						stroke="currentColor"
						strokeLinecap="round"
						strokeLinejoin="round"
						strokeWidth="2"
						d="m11.801 6.49l1.486-1.486c1.673-1.673 3.862-2.367 6.18-2.48c.902-.044 1.352-.066 1.714.295c.361.362.34.812.295 1.714c-.113 2.318-.807 4.507-2.48 6.18L17.511 12.2c-1.224 1.223-1.572 1.571-1.315 2.898c.254 1.014.499 1.995-.238 2.732c-.894.895-1.71.895-2.604 0l-7.183-7.183c-.895-.894-.895-1.71 0-2.604c.737-.737 1.718-.492 2.732-.238c1.327.257 1.675-.091 2.898-1.315m5.195.51h.009M2.5 21.5l5-5m1 5l2-2m-8-4l2-2"
					></path>
				</svg>
			</div>
			<div className="max-w-40 overflow-hidden font-semibold tracking-[-0.01em] whitespace-nowrap opacity-100 transition-[max-width,opacity] duration-150 ease-out group-data-[collapsible=icon]:max-w-0 group-data-[collapsible=icon]:opacity-0 motion-reduce:transition-none">
				{brand.name}
			</div>
		</div>
	)
}
