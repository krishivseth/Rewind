// Bundle Monaco locally so the Docker image has no CDN dependency.
// Core editor only, plus the languages the seed repositories use. The full package bundles every
// language and its worker, several times the size of this.
import * as monaco from 'monaco-editor/editor/editor.api.js'
import 'monaco-editor/languages/definitions/python/register.js'
import 'monaco-editor/languages/definitions/typescript/register.js'
import 'monaco-editor/languages/definitions/markdown/register.js'
import 'monaco-editor/languages/definitions/yaml/register.js'
import 'monaco-editor/languages/definitions/shell/register.js'
import 'monaco-editor/languages/definitions/ini/register.js'
import 'monaco-editor/languages/definitions/html/register.js'
import 'monaco-editor/languages/definitions/css/register.js'
import editorWorker from 'monaco-editor/editor/editor.worker.js?worker'
import { loader } from '@monaco-editor/react'

self.MonacoEnvironment = { getWorker: () => new editorWorker() }

monaco.editor.defineTheme('rewind', {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#0c0f14',
    'editor.lineHighlightBackground': '#121620',
    'editorLineNumber.foreground': '#3f4856',
    'editorGutter.background': '#0c0f14',
    'diffEditor.insertedTextBackground': '#22c5a82a',
    'diffEditor.removedTextBackground': '#e5646a2a',
    'diffEditor.insertedLineBackground': '#22c5a818',
    'diffEditor.removedLineBackground': '#e5646a18',
  },
})
loader.config({ monaco })

export const EDITOR_OPTIONS = {
  readOnly: true,
  automaticLayout: true,
  domReadOnly: true,
  minimap: { enabled: false },
  fontFamily: '"IBM Plex Mono", ui-monospace, Menlo, monospace',
  fontSize: 12,
  lineHeight: 18,
  scrollBeyondLastLine: false,
  renderLineHighlight: 'line' as const,
  wordWrap: 'off' as const,
  smoothScrolling: true,
  padding: { top: 8 },
  scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
}

const EXT: Record<string, string> = {
  py: 'python', ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', json: 'javascript',
  md: 'markdown', yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', cfg: 'ini', html: 'html', css: 'css',
  sh: 'shell', txt: 'plaintext', csv: 'plaintext', sql: 'sql', rs: 'rust', go: 'go', java: 'java', c: 'c', h: 'c', cpp: 'cpp',
}
export function languageFor(path: string): string {
  const name = path.split('/').pop() ?? ''
  if (name === 'Makefile') return 'makefile'
  if (name === '.gitignore' || name === '.rewind.json') return name.endsWith('json') ? 'javascript' : 'plaintext'
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
  return EXT[ext] ?? 'plaintext'
}
