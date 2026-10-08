import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { CONTROL_METHODS, CONTROL_PATH, CONTROL_PROTOCOL, CONTROL_VERSION, METHOD_CATEGORIES } from '../dist/protocol/constants.js'
import { API_HTTP_STATUS } from '../dist/protocol/errors.js'
import { PARAMS_SCHEMAS } from '../dist/protocol/params-schemas.js'
import { RESULT_SCHEMAS, STORED_EVENT_SCHEMA } from '../dist/protocol/result-schemas.js'
import { REQUEST_ENVELOPE_SCHEMA, RESULT_ENVELOPE_SCHEMA, ERROR_ENVELOPE_SCHEMA } from '../dist/protocol/envelope-schemas.js'

// Artifact-plane generator: run the declared TypeScript build before generation or drift checks.
const directory = fileURLToPath(new URL('../python/src/atomic_harness/', import.meta.url))
const checking = process.argv.includes('--check')
const vocabulary = { protocol: CONTROL_PROTOCOL, version: CONTROL_VERSION, path: CONTROL_PATH,
  methods: CONTROL_METHODS, categories: METHOD_CATEGORIES, httpStatus: API_HTTP_STATUS,
  requestEnvelope: REQUEST_ENVELOPE_SCHEMA, resultEnvelope: RESULT_ENVELOPE_SCHEMA, errorEnvelope: ERROR_ENVELOPE_SCHEMA,
  params: PARAMS_SCHEMAS, results: RESULT_SCHEMAS, definitions: { storedEvent: STORED_EVENT_SCHEMA } }
const schemaJson = JSON.stringify(vocabulary, null, 2) + '\n'
const digest = createHash('sha256').update(schemaJson).digest('hex')
const camel = value => value.split(/[^A-Za-z0-9]+/).map(word => word.charAt(0).toUpperCase() + word.slice(1)).join('')
const canonical = value => JSON.stringify(value, (_key, child) => child !== null && typeof child === 'object' && !Array.isArray(child)
  ? Object.fromEntries(Object.entries(child).sort(([a], [b]) => a.localeCompare(b))) : child)
const names = new Map(), declarations = [], reserved = new Set(), aliases = []
const literal = value => value === null ? 'None' : value === true ? 'True' : value === false ? 'False' : JSON.stringify(value)
function type(schema, preferred) {
  if ('$ref' in schema) return type(vocabulary.definitions[schema.$ref.split('/').at(-1)], 'StoredEvent')
  if ('const' in schema) return schema.const === null ? 'None' : `Literal[${literal(schema.const)}]`
  if ('enum' in schema) return `Literal[${schema.enum.map(literal).join(', ')}]`
  const options = schema.oneOf ?? schema.anyOf
  if (options !== undefined) return options.map((branch, index) => type(branch, preferred + (index + 1))).join(' | ')
  if (schema.type === 'null') return 'None'
  if (schema.type === 'boolean') return 'bool'
  if (schema.type === 'integer') return 'int'
  if (schema.type === 'number') return 'int | float'
  if (schema.type === 'string') {
    return { 'canonical-uuid': 'CanonicalUuid', 'session-event-id': 'SessionEventId', 'session-address': 'SessionAddress' }[schema.format] ?? 'str'
  }
  if (schema.type === 'array') return `list[${type(schema.items, preferred + 'Item')}]`
  if (schema.type !== 'object') {
    if (Object.keys(schema).length === 0) return 'JsonValue'
    throw new Error(`Unsupported Python type schema: ${preferred}`)
  }
  const key = canonical(schema), old = names.get(key)
  if (old !== undefined) return old
  let name = preferred
  while (reserved.has(name)) name += 'Data'
  reserved.add(name); names.set(key, name)
  const required = new Set(schema.required ?? [])
  const fields = Object.entries(schema.properties).map(([field, child]) => {
    const annotation = type(child, name + camel(field))
    return `    ${field}: ${required.has(field) ? annotation : `NotRequired[${annotation}]`}`
  })
  declarations.push(`class ${name}(TypedDict):\n${fields.length === 0 ? '    pass' : fields.join('\n')}\n`)
  return name
}
const methods = CONTROL_METHODS.map(method => {
  const name = camel(method), params = name + 'Params', result = name + 'Result'
  for (const [alias, schema] of [[params, PARAMS_SCHEMAS[method]], [result, RESULT_SCHEMAS[method]]]) {
    const annotation = type(schema, alias)
    if (annotation !== alias) aliases.push(`${alias}: TypeAlias = ${annotation}`)
  }
  return { method, params, result }
})
const types = `"""Generated from the Control v1 schemas; regenerate with scripts/generate-python-protocol.mjs."""\n\n` +
  `from __future__ import annotations\n\nfrom typing import Literal, NewType, NotRequired, TypeAlias, TypedDict, Union\n\n` +
  `SCHEMA_SHA256 = ${literal(digest)}\nCanonicalUuid = NewType("CanonicalUuid", str)\nSessionEventId = NewType("SessionEventId", str)\nSessionAddress = NewType("SessionAddress", str)\n` +
  `JsonValue: TypeAlias = Union[None, bool, int, float, str, list["JsonValue"], dict[str, "JsonValue"]]  # noqa: UP007 - recursive forward references on Python 3.11.\n` +
  `ControlMethod: TypeAlias = Literal[${CONTROL_METHODS.map(literal).join(', ')}]\n\n` + declarations.join('\n\n') + '\n\n' + aliases.join('\n') + '\n'
const stub = `"""Generated method/result associations; runtime implementation lives in client.py."""\n\n` +
  `from collections.abc import Iterator\nfrom types import TracebackType\nfrom typing import Literal, overload\n\nfrom . import types as t\nfrom .cancellation import CancellationToken\nfrom .config import ClientLimits, TlsCredentials\n\n` +
  `class HarnessClient:\n    def __init__(self, origin: str, *, tls: TlsCredentials, limits: ClientLimits) -> None: ...\n` +
  methods.map(({ method, params, result }) => `    @overload\n    def request(self, method: Literal[${literal(method)}], params: t.${params}, *, cancel: CancellationToken | None = None) -> t.${result}: ...\n`).join('') +
  `    def events(self, params: t.SessionEventsParams, *, cancel: CancellationToken | None = None) -> Iterator[t.SessionEventsResult]: ...\n` +
  `    def close(self) -> None: ...\n    def dispose(self) -> None: ...\n    def __enter__(self) -> HarnessClient: ...\n` +
  `    def __exit__(self, exc_type: type[BaseException] | None, exc_value: BaseException | None, traceback: TracebackType | None) -> None: ...\n`
await mkdir(directory, { recursive: true })
for (const [name, contents] of [['control-schema.json', schemaJson], ['types.py', types], ['client.pyi', stub]]) {
  const path = directory + name
  if (checking) {
    if (await readFile(path, 'utf8') !== contents) throw new Error(`Python protocol generation drift: ${name}`)
  } else await writeFile(path, contents, 'utf8')
}
console.log(JSON.stringify({ kind: checking ? 'python-protocol-checked' : 'python-protocol-generated', methods: methods.length,
  objectTypes: declarations.length, schemaSha256: digest }))
