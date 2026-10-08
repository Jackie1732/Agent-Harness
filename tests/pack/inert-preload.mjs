import { register } from 'node:module'

// The resolve hook fails if a supposedly inert import or CLI route attempts to load a renderer.
register(`data:text/javascript,${encodeURIComponent(`
  export async function resolve(specifier, context, nextResolve) {
    const result = await nextResolve(specifier, context);
    if (/^(?:ink|react|react-reconciler|yoga-layout)(?:\\/|$)/.test(specifier)
      || /\\/(?:ink|react|react-reconciler|yoga-layout)\\//.test(result.url)) {
      throw new Error('Inert entry loaded a terminal renderer: ' + specifier);
    }
    return result;
  }
`)}`, import.meta.url)
