import { useCallback, useEffect, useState } from 'react'
import { startPhotoQueue } from '../lib/photo-queue/runtime'
import { type QueueItem, type UploadedEvent } from '../lib/photo-queue/types'

/**
 * The dish photo queue as React state. The first caller starts the queue
 * (loads what was saved, listens for connectivity and foreground).
 */
export function usePhotoQueue(options?: {
	onUploaded?: (event: UploadedEvent) => void
}) {
	const [items, setItems] = useState<QueueItem[]>([])
	const onUploaded = options?.onUploaded

	useEffect(() => {
		const queue = startPhotoQueue()
		setItems(queue.getSnapshot().items)
		const unsubscribe = queue.subscribe((snapshot) => setItems(snapshot.items))
		return unsubscribe
	}, [])

	useEffect(() => {
		if (!onUploaded) return
		return startPhotoQueue().onUploaded(onUploaded)
	}, [onUploaded])

	const enqueue = useCallback(
		(input: Parameters<ReturnType<typeof startPhotoQueue>['enqueue']>[0]) =>
			startPhotoQueue().enqueue(input),
		[],
	)
	const retry = useCallback((id: string) => startPhotoQueue().retry(id), [])
	const remove = useCallback((id: string) => startPhotoQueue().remove(id), [])

	return { items, enqueue, retry, remove }
}
