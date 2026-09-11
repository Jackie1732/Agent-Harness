import { brand, unbrand } from '../../src/index.js'
import type { Brand } from '../../src/index.js'

type UserId = Brand<string, 'UserId'>
type SessionId = Brand<string, 'SessionId'>

const userId: UserId = brand<string, 'UserId'>('user-1')
const raw: string = unbrand(userId)

// @ts-expect-error Distinct domain identities must not be interchangeable.
const sessionId: SessionId = userId

void raw
void sessionId
