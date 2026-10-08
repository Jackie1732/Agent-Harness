/** Service command cards are data; rendering or selecting them never starts a process. */
export interface CommandCard { readonly label: string; readonly argv: readonly string[]; readonly location: string }

/**
 * Quote every argument using PowerShell literal single-quoted strings.
 * @param argv Exact executable and arguments, without secrets.
 * @returns A copyable invocation that preserves spaces, quotes and metacharacters.
 */
export function powershellCommand(argv: readonly string[]): string {
  return '& ' + argv.map(part => "'" + part.replace(/'/g, "''") + "'").join(' ')
}

/**
 * Construct existing service operations from explicit configuration references.
 * @param input Configured paths and optional exact administration references.
 * @returns Commands for another terminal; no operation executes here.
 */
export function serviceCommandCards(input: {
  readonly automation?: string | null; readonly definition?: string | null; readonly plan?: string | null
  readonly root?: string | null; readonly triggerKey?: string; readonly expectedToken?: string
  readonly reportKey?: string
  readonly mode?: 'fixture' | 'live'; readonly unitKey?: string; readonly evaluatorKey?: string; readonly comparisonKey?: string
  readonly otherRoot?: string; readonly variantA?: string; readonly variantB?: string; readonly sessionId?: string; readonly fixtureOutput?: string
  readonly evidenceKey?: string; readonly evidenceFile?: string; readonly sourceFile?: string; readonly finalize?: boolean
}): readonly CommandCard[] {
  const cards: CommandCard[] = []
  if (input.automation != null) {
    const argv = ['atomic-harness', 'automate', '--config', input.automation]
    cards.push({ label: 'Automation 启动', argv, location: input.automation })
    if (input.triggerKey !== undefined) cards.push({ label: '确认未知 run', argv: [...argv, '--acknowledge-run-unknown', input.triggerKey], location: input.automation })
    if (input.expectedToken !== undefined) cards.push({ label: '释放前任残锁', argv: [...argv, '--unlock', '--predecessor-stopped', '--expected-token', input.expectedToken], location: input.automation })
  }
  if (input.definition != null) cards.push({ label: '冻结实验 Plan', argv: ['atomic-harness', 'experiment', 'plan', '--definition', input.definition,
    ...(input.plan != null ? ['--output', input.plan] : [])], location: input.plan ?? input.definition })
  if (input.plan != null) cards.push({ label: `运行 ${input.mode ?? 'fixture'} 实验`, argv: ['atomic-harness', 'experiment', 'run', '--plan', input.plan, '--mode', input.mode ?? 'fixture'], location: input.root ?? input.plan })
  if (input.root != null) {
    for (const command of ['inspect', 'verify'] as const) cards.push({ label: `实验 ${command}`, argv: ['atomic-harness', 'experiment', command, '--root', input.root], location: input.root })
    if (input.reportKey !== undefined) cards.push({ label: '实验报告', argv: ['atomic-harness', 'experiment', 'report', '--root', input.root,
      '--report-key', input.reportKey, '--kind', 'primary', ...(input.finalize ? ['--finalize'] : [])], location: input.root })
    if (input.unitKey !== undefined) cards.push({ label: '实验评测', argv: ['atomic-harness', 'experiment', 'evaluate', '--root', input.root, '--unit', input.unitKey,
      ...(input.evaluatorKey === undefined ? [] : ['--evaluator', input.evaluatorKey])], location: input.root })
    if (input.comparisonKey !== undefined && (input.otherRoot === undefined || input.variantA !== undefined && input.variantB !== undefined)) cards.push({ label: '实验比较',
      argv: ['atomic-harness', 'experiment', 'compare', '--root', input.root, '--comparison', input.comparisonKey,
        ...(input.otherRoot === undefined ? [] : ['--other-root', input.otherRoot, '--variant-a', input.variantA!, '--variant-b', input.variantB!])], location: input.root })
    if (input.unitKey !== undefined && input.sessionId !== undefined && input.fixtureOutput !== undefined) cards.push({ label: '导出实验 fixture',
      argv: ['atomic-harness', 'experiment', 'export-fixture', '--root', input.root, '--unit', input.unitKey, '--session', input.sessionId, '--output', input.fixtureOutput], location: input.fixtureOutput })
    if (input.expectedToken !== undefined) cards.push({ label: '关闭中断实验（确认前任已停止）', argv: ['atomic-harness', 'experiment', 'close', '--root', input.root,
      '--predecessor-stopped', '--expected-token', input.expectedToken, ...(input.reportKey === undefined ? [] : ['--report-key', input.reportKey])], location: input.root })
    if (input.unitKey !== undefined && input.evidenceKey !== undefined && input.evidenceFile !== undefined && input.sourceFile !== undefined) cards.push({ label: '登记派生证据',
      argv: ['atomic-harness', 'experiment', 'register-evidence', '--root', input.root, '--unit', input.unitKey, '--evidence-key', input.evidenceKey,
        '--evidence', input.evidenceFile, '--source', input.sourceFile], location: input.root })
  }
  return cards
}
