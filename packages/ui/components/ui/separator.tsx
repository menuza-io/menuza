import { Separator as SeparatorPrimitive } from '@base-ui/react/separator'

import { cn } from '../../lib/utils'

function Separator({
	className,
	orientation = 'horizontal',
	variant = 'solid',
	...props
}: SeparatorPrimitive.Props & { variant?: 'solid' | 'dashed' }) {
	return (
		<SeparatorPrimitive
			data-slot="separator"
			orientation={orientation}
			className={cn(
				'bg-border shrink-0 data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:w-px data-[orientation=vertical]:self-stretch',
				variant === 'dashed' &&
					'border-input data-[orientation=horizontal]:h-0 data-[orientation=horizontal]:border-t data-[orientation=horizontal]:border-dashed data-[orientation=horizontal]:bg-transparent',
				className,
			)}
			{...props}
		/>
	)
}

export { Separator }
