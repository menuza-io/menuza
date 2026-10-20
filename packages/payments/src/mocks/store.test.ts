import { createMemoryStore } from './store'
import { runStoreContract } from './store-contract'

runStoreContract('memory', async () => createMemoryStore())
