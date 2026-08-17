export * from './types.ts'
export * from './adapters/mock/mock-adapter.ts'
export * from './adapters/cj/errors.ts'
export * from './adapters/cj/http.ts'
export * from './adapters/cj/mapping.ts'
export * from './adapters/cj/adapter.ts'

// NOTE: `contract/adapter-contract.ts` (runAdapterContractTests) is deliberately NOT re-exported
// from this barrel — it imports `vitest`, which throws on import outside a vitest worker. Any
// real (non-test) process that imports `@doge-buddy/supplier` — including apps/ops's own service
// entrypoint — would crash on startup if it were included here. Import it from the
// `@doge-buddy/supplier/contract` subpath instead, from test files only.
