import { type VariantProps } from 'class-variance-authority'
import * as React from 'react'
import { useEffect, useState } from 'react'
import { useSpinDelay } from 'spin-delay'
import { cn } from '../lib/utils'
import { Icon } from './icon'
import { Button, type buttonVariants } from './ui/button'
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from './ui/tooltip'

type ButtonVariant = VariantProps<typeof buttonVariants>

interface StatusButtonProps
	extends React.ComponentProps<'button'>, ButtonVariant {
	status: 'pending' | 'success' | 'error' | 'idle'
	message?: string | null
	spinDelay?: Parameters<typeof useSpinDelay>[1]
	pendingText?: string
	successText?: string
	errorText?: string
	successDuration?: number
	onStatusChange?: (status: 'idle') => void
}

export const StatusButton = ({
	message,
	status,
	className,
	children,
	spinDelay,
	pendingText,
	successText,
	errorText,
	successDuration = 1000,
	onStatusChange,
	...props
}: StatusButtonProps) => {
	const [internalStatus, setInternalStatus] = useState<typeof status>(status)

	// Sync internal status with prop status
	useEffect(() => {
		setInternalStatus(status)
	}, [status])

	// Auto-reset success state after specified duration
	useEffect(() => {
		if (internalStatus === 'success') {
			const timer = setTimeout(() => {
				setInternalStatus('idle')
				onStatusChange?.('idle')
			}, successDuration)

			return () => clearTimeout(timer)
		}
	}, [internalStatus, successDuration, onStatusChange])

	const delayedPending = useSpinDelay(internalStatus === 'pending', {
		delay: 400,
		minDuration: 300,
		...spinDelay,
	})

	const getButtonContent = () => {
		switch (internalStatus) {
			case 'pending':
				return delayedPending ? (
					<>
						<Icon name="loader" className="h-4 w-4 animate-spin" />
						{pendingText || children}
					</>
				) : (
					children
				)
			case 'success':
				return (
					<>
						<Icon name="check" className="h-4 w-4" />
						{successText || children}
					</>
				)
			case 'error':
				return (
					<>
						<Icon name="x" className="h-4 w-4" />
						{errorText || children}
					</>
				)
			default:
				return children
		}
	}

	const getButtonClassName = () => {
		const baseClasses =
			'transition-all duration-200 flex justify-center items-center'

		switch (internalStatus) {
			case 'success':
				return cn(
					baseClasses,
					'border-green-600 bg-green-600 text-white hover:bg-green-700 hover:text-white',
					className,
				)
			case 'error':
				return cn(
					baseClasses,
					'bg-destructive hover:bg-destructive/90 border-destructive text-white hover:text-white',
					className,
				)
			default:
				return cn(baseClasses, className)
		}
	}

	const buttonContent = getButtonContent()

	return message ? (
		<TooltipProvider>
			<Tooltip>
				<TooltipTrigger
					render={
						<Button
							className={getButtonClassName()}
							disabled={internalStatus === 'pending'}
							data-status={internalStatus}
							{...props}
						>
							{buttonContent}
						</Button>
					}
				></TooltipTrigger>
				<TooltipContent>{message}</TooltipContent>
			</Tooltip>
		</TooltipProvider>
	) : (
		<Button
			className={getButtonClassName()}
			disabled={internalStatus === 'pending'}
			data-status={internalStatus}
			{...props}
		>
			{buttonContent}
		</Button>
	)
}

StatusButton.displayName = 'StatusButton'
