import { describe, expect, it } from 'vitest'
import { renderToString, Box, Text } from 'ink'

describe('terminal build and test input', () => {
  it('loads React, Ink and Yoga and renders Chinese and combined graphemes through TSX', async () => {
    const text = await renderToString(<Box flexDirection="column"><Text>学习 Harness</Text><Text>👩‍💻 é</Text></Box>)
    expect(text).toContain('学习 Harness')
    expect(text).toContain('👩‍💻 é')
  })
})
