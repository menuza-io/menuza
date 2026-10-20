import { runStoreContract } from '@repo/payments/mock/store-contract'
import { createSqlMockStore } from './store.server.ts'

runStoreContract('SQL (test database)', async () => createSqlMockStore())
