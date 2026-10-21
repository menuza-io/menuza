import { cn } from '@repo/ui'

/**
 * Board grid. Below `md` the columns sit in one horizontal snap-scroll row,
 * `md` to `xl` is two columns, and from `xl` the Finished column is a slim
 * strip until it has something to show and is expanded.
 */
export function boardGridClass({
	waitlistEnabled,
	finishedOpen,
}: {
	waitlistEnabled: boolean
	finishedOpen: boolean
}): string {
	const base =
		'max-md:flex max-md:snap-x max-md:snap-mandatory max-md:gap-3 max-md:overflow-x-auto max-md:pb-2 md:grid md:grid-cols-2 md:gap-4'
	if (finishedOpen) {
		return cn(base, waitlistEnabled ? 'xl:grid-cols-4' : 'xl:grid-cols-3')
	}
	return cn(
		base,
		waitlistEnabled
			? 'xl:grid-cols-[minmax(0,1.25fr)_minmax(0,1.25fr)_minmax(0,1fr)_13rem]'
			: 'xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_13rem]',
	)
}
