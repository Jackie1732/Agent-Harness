import { snapshotJson } from '../foundation/json.js'
import type { JsonValue } from '../foundation/json.js'
import type { ModelContinuation, ModelIntentReference, ModelRequest } from './contract.js'
import { ModelError } from './errors.js'
import { parseModelInvocationId } from './ids.js'
import { validateToolSchema } from './tool-schema.js'
import { bool, boundedIdentifier, integer, keys, list, object, text } from './validation.js'

/** Request boundary: validation and copying finish before the caller can mutate input. */
export function snapshotModelRequest(value: unknown): ModelRequest {
  let copy: JsonValue
  try { copy = snapshotJson(value, 'model request') }
  catch { throw new ModelError('MODEL_REQUEST_INVALID', 'model request is not plain finite JSON') }
  const request = object(copy, 'model request')
  keys(request, ['model', 'instructions', 'messages', 'tools', 'maxOutputTokens'], ['temperature', 'topP', 'profile'])
  boundedIdentifier(request.model, 'model')
  integer(request.maxOutputTokens, 'maxOutputTokens', 1)
  for (const instruction of list(request.instructions, 'instructions')) text(instruction, 'instruction')
  for (const field of ['temperature', 'topP'] as const) {
    if (request[field] !== undefined && (typeof request[field] !== 'number' || !Number.isFinite(request[field]))) {
      throw new ModelError('MODEL_REQUEST_INVALID', 'sampling control must be a finite number')
    }
  }
  if (request.profile !== undefined) {
    const profile = object(request.profile, 'request profile')
    keys(profile, ['namespace', 'version', 'options'])
    boundedIdentifier(profile.namespace, 'profile namespace')
    integer(profile.version, 'profile version', 1)
    object(profile.options, 'profile options')
  }
  const tools = list(request.tools, 'tools')
  const names = new Set<string>()
  for (const input of tools) {
    const tool = object(input, 'tool definition')
    keys(tool, ['name', 'description', 'inputSchema'])
    const name = text(tool.name, 'tool name', 64, false)
    if (!/^[A-Za-z0-9_-]+$/.test(name) || names.has(name)) {
      throw new ModelError('MODEL_REQUEST_INVALID', 'tool names must have valid syntax and be unique')
    }
    names.add(name)
    text(tool.description, 'tool description')
    const schema = object(tool.inputSchema, 'tool input schema')
    validateToolSchema(schema)
    if (schema.type !== 'object') throw new ModelError('MODEL_REQUEST_INVALID', 'tool input schema root must be object')
  }
  validateMessages(list(request.messages, 'messages'))
  return copy as ModelRequest
}

export function decodeIntentReference(value: JsonValue | undefined): ModelIntentReference {
  const reference = object(value, 'tool intent reference')
  keys(reference, ['invocationId', 'outputBlockIndex'])
  parseModelInvocationId(text(reference.invocationId, 'invocation identity', 36, false))
  integer(reference.outputBlockIndex, 'output block index')
  return reference as ModelIntentReference
}

export function decodeContinuation(value: JsonValue | undefined): ModelContinuation {
  const capsule = object(value, 'continuation capsule')
  keys(capsule, ['namespace', 'version', 'providerId', 'model', 'text'])
  boundedIdentifier(capsule.namespace, 'continuation namespace')
  integer(capsule.version, 'continuation version', 1)
  boundedIdentifier(capsule.providerId, 'continuation provider')
  boundedIdentifier(capsule.model, 'continuation model')
  text(capsule.text, 'continuation text')
  return capsule as ModelContinuation
}

function validateMessages(messages: readonly JsonValue[]): void {
  if (messages.length === 0) throw new ModelError('MODEL_REQUEST_INVALID', 'model history must contain a message')
  const pending = new Map<string, ModelIntentReference>()
  const sourceKeys = new Set<string>()
  for (const input of messages) {
    const message = object(input, 'message')
    keys(message, ['role', 'content'], ['continuation'])
    const role = message.role
    if (role !== 'user' && role !== 'assistant') throw new ModelError('MODEL_FEATURE_UNSUPPORTED', 'only user and assistant history is supported')
    if (message.continuation !== undefined) {
      if (role !== 'assistant') throw new ModelError('MODEL_REQUEST_INVALID', 'continuation must belong to an assistant message')
      decodeContinuation(message.continuation)
    }
    const blocks = list(message.content, 'message content')
    if (blocks.length === 0) throw new ModelError('MODEL_REQUEST_INVALID', 'message content must not be empty')
    if (role === 'assistant' && pending.size > 0) throw new ModelError('MODEL_REQUEST_INVALID', 'assistant history follows unresolved tool calls')
    for (const inputBlock of blocks) {
      const block = object(inputBlock, 'input block')
      if (block.kind === 'text') {
        keys(block, ['kind', 'text'])
        text(block.text, 'message text')
        if (role === 'user' && pending.size > 0) throw new ModelError('MODEL_REQUEST_INVALID', 'tool results must precede unrelated user text')
      } else if (block.kind === 'tool-call' && role === 'assistant') {
        keys(block, ['kind', 'callId', 'name', 'argumentsText', 'source'])
        const id = text(block.callId, 'tool call identity', 256, false)
        text(block.name, 'historical tool name', 64, false)
        text(block.argumentsText, 'historical tool arguments')
        const source = decodeIntentReference(block.source)
        const sourceKey = `${source.invocationId}:${source.outputBlockIndex}`
        if (pending.has(id) || sourceKeys.has(sourceKey)) throw new ModelError('MODEL_REQUEST_INVALID', 'historical tool identities must not repeat')
        sourceKeys.add(sourceKey)
        pending.set(id, source)
      } else if (block.kind === 'tool-result' && role === 'user') {
        keys(block, ['kind', 'callId', 'source', 'result', 'isError'])
        const id = text(block.callId, 'tool result identity', 256, false)
        bool(block.isError, 'tool result error marker')
        const source = decodeIntentReference(block.source)
        const expected = pending.get(id)
        if (expected === undefined || expected.invocationId !== source.invocationId || expected.outputBlockIndex !== source.outputBlockIndex) {
          throw new ModelError('MODEL_REQUEST_INVALID', 'tool result does not match an unresolved historical intent')
        }
        pending.delete(id)
      } else {
        throw new ModelError('MODEL_FEATURE_UNSUPPORTED', 'input block cannot be represented at this role')
      }
    }
  }
  if (pending.size > 0) throw new ModelError('MODEL_REQUEST_INVALID', 'model history is missing tool results')
}
