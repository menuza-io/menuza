import { Skeleton } from '@repo/ui/skeleton'
import { lazy, Suspense } from 'react'
import { type NotesSeries } from '#app/utils/dashboards/block-data.server.ts'

// Recharts is kept out of the Worker bundle (see the SSR stub in vite.config).
const NotesChart = lazy(() =>
	import('#app/components/notes-chart.tsx').then((module) => ({
		default: module.NotesChart,
	})),
)

export function NotesChartBlock({ notes }: { notes: NotesSeries }) {
	return (
		<Suspense fallback={<Skeleton className="h-full rounded-xl" />}>
			<NotesChart
				className="h-full"
				data={notes.points}
				daysShown={notes.daysShown}
				totalNotes={notes.total}
				avgPerDay={notes.avgPerDay}
				trend={notes.trend}
			/>
		</Suspense>
	)
}
