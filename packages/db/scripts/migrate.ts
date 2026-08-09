import { runMigrations } from '../src/index.ts'

const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL is required')
  process.exit(1)
}
await runMigrations(url)
console.log('migrations applied')
