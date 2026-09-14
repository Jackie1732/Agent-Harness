import { ToolError } from './errors.js'

/** Portable, unambiguous relative path syntax; containment is additionally checked by native I/O. */
export function workspaceRelativePath(value: unknown, maxBytes: number): string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value) > maxBytes
    || /[\\\x00-\x1f\x7f<>:"|?*]/.test(value)) invalid()
  for (const segment of value.split('/')) {
    if (segment.length === 0 || segment === '.' || segment === '..' || /[. ]$/.test(segment)
      || Buffer.byteLength(segment) > 255
      || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)(?:\.|$)/i.test(segment)) invalid()
  }
  return value
}
function invalid(): never { throw new ToolError('TOOL_PATH_INVALID', 'workspace target is not a portable relative path') }
