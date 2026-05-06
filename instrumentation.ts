import { validateEnv } from '@/lib/env'

export function register(): void {
  validateEnv()
}
