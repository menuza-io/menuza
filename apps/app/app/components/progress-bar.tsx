import { cn } from '@repo/ui'
import { Icon } from '@repo/ui/icon'
import { useEffect, useRef, useState } from 'react'
import { useNavigation } from 'react-router'
import { useSpinDelay } from 'spin-delay'

function EpicProgress() {
	const transition = useNavigation()
	const busy = transition.state !== 'idle'
	const delayedPending = useSpinDelay(busy, {
		delay: 600,
		minDuration: 400,
	})
	const ref = useRef<HTMLDivElement>(null)
	const [animationComplete, setAnimationComplete] = useState(true)

	useEffect(() => {
		if (!ref.current) return
		if (delayedPending) setAnimationComplete(false)

		const animationPromises = ref.current
			.getAnimations()
			.map(({ finished }) => finished)

		void Promise.allSettled(animationPromises).then(() => {
			if (!delayedPending) setAnimationComplete(true)
		})
	}, [delayedPending])

	return (
		<div
			role="progressbar"
			aria-hidden={delayedPending ? undefined : true}
			aria-valuetext={delayedPending ? 'Loading' : undefined}
			className="fixed inset-x-0 top-0 z-50 h-[0.40rem]"
		>
			<div
				ref={ref}
				className={cn(
					'h-full w-0 bg-blue-500 duration-500 ease-in-out',
					transition.state === 'idle' &&
						(animationComplete
							? 'transition-none'
							: 'w-full opacity-0 transition-[width,opacity]'),
					delayedPending && transition.state === 'submitting' && 'w-5/12',
					delayedPending && transition.state === 'loading' && 'w-8/12',
				)}
			/>
			{delayedPending && (
				<div className="absolute flex items-center justify-center">
					<Icon
						name="refresh-cw"
						size="md"
						className="m-1 text-blue-500 motion-safe:animate-spin"
						aria-hidden
					/>
				</div>
			)}
		</div>
	)
}

export { EpicProgress }
