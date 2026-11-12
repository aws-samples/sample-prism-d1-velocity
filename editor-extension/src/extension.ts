/**
 * VS Code glue: status bar, Problems markers, code actions, the PRISM panel
 * and commands. The logic it calls lives in vscode-free modules with unit
 * tests. No listening sockets, no AWS calls, no telemetry.
 */
import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CliError, cliEnv, configuredCliPath, currentBranch, dashboardArgs, DASHBOARD_TIMEOUT_MS, gitToplevel, isResultId, machineDashboardRun, REPORT_TIMEOUT_MS, reportArgs, resolveCli, runCli,
} from './cli';
import { DIAGNOSTIC_SOURCE, findingsToDiagnostics, fixPrompt, type DiagnosticRecord } from './diagnostics';
import { codewatchOff, parsePayload, repoView } from './payload';
import { machinePanelModel, panelHtml, panelModel, parsePanelMessage, withReportCsp, type AnyPanelModel } from './panel-model';
import { INTERVAL_MS, Refresher } from './refresh';
import { cliMissingText, INSTALL_CMD, statusView, type State } from './status';

const SEVERITY: Record<DiagnosticRecord['severity'], vscode.DiagnosticSeverity> = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  information: vscode.DiagnosticSeverity.Information,
};

const isFile = (p: string) => { try { return statSync(p).isFile(); } catch { return false; } };
const fmtTime = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(); };

class Prism implements vscode.Disposable {
  private readonly subs: vscode.Disposable[] = [];
  private readonly status = vscode.window.createStatusBarItem('prism.status', vscode.StatusBarAlignment.Left, 0);
  private readonly diags = vscode.languages.createDiagnosticCollection('prism');
  private readonly refresher = new Refresher((fresh) => this.run(fresh));
  private state: State = { kind: 'loading' };
  private repoRoot: string | null = null;
  private records: DiagnosticRecord[] = [];
  private model: AnyPanelModel | null = null;
  private panel: vscode.WebviewPanel | null = null;
  private report: vscode.WebviewPanel | null = null;
  private watcher: vscode.FileSystemWatcher | null = null;
  private interval: NodeJS.Timeout | null = null;

  constructor(private readonly ctx: vscode.ExtensionContext) {
    this.status.name = 'PRISM';
    const cmd = (id: string, fn: (...a: any[]) => unknown) => this.subs.push(vscode.commands.registerCommand(id, fn));
    cmd('prism.openPanel', () => this.openPanel());
    cmd('prism.refresh', () => this.refresher.request({ fresh: true, immediate: true }));
    cmd('prism.openBrowserDashboard', () => this.inTerminal('PRISM dashboard', ['dashboard']));
    cmd('prism.enableCodewatch', () => this.enableCodewatch());
    // Code action argument: { relPath, finding } from a DiagnosticRecord.
    cmd('prism.copyFixPrompt', async (d: Pick<DiagnosticRecord, 'relPath' | 'finding'>) => {
      if (!d || typeof d.relPath !== 'string' || !d.finding) return;
      await vscode.env.clipboard.writeText(fixPrompt(d));
      vscode.window.showInformationMessage('PRISM: fix prompt copied. Paste it into your AI chat.');
    });
    cmd('prism.openReport', () => this.openReport());
    cmd('prism.showInstallHint', () => this.showInstallHint());
    this.subs.push(
      vscode.languages.registerCodeActionsProvider({ scheme: 'file' }, { provideCodeActions: (doc, _r, c) => this.codeActions(doc, c) }, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
      vscode.window.onDidChangeWindowState((w) => { if (w.focused) this.refresher.focus(); }),
      vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('prism.cliPath')) this.refresher.request({ immediate: true }); }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.init()),
    );
    this.interval = setInterval(() => this.refresher.request(), INTERVAL_MS);
  }

  /**
   * Repo mode: the first workspace folder inside a git repo. Machine mode
   * (no folder, or none inside a repo): a home-directory scan, refreshed on
   * focus and every 5 min like repo mode; the home directory is not watched.
   * shortcut: one repo per window; multi-root picks per folder later if asked.
   */
  async init(): Promise<void> {
    let root: string | null = null;
    for (const f of vscode.workspace.workspaceFolders ?? []) {
      if (f.uri.scheme !== 'file') continue;
      root = await gitToplevel(f.uri.fsPath);
      if (root) break;
    }
    this.watcher?.dispose();
    this.watcher = null;
    if (root !== this.repoRoot) this.state = { kind: 'loading' };
    this.repoRoot = root;
    if (!root) {
      this.publish([]); // no files to mark
      this.render();
      this.status.show();
      this.refresher.request({ immediate: true });
      return;
    }
    this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(root), '.prism/results/**'));
    const poke = () => this.refresher.request();
    this.watcher.onDidCreate(poke); this.watcher.onDidChange(poke); this.watcher.onDidDelete(poke);
    this.render();
    this.status.show();
    this.refresher.request({ immediate: true });
  }

  private cli() {
    return resolveCli(configuredCliPath(vscode.workspace.getConfiguration('prism').inspect('cliPath')), process.env);
  }

  private async run(fresh: boolean): Promise<void> {
    const root = this.repoRoot;
    const cli = this.cli();
    if (!cli.ok) { this.setState({ kind: 'cli-missing', reason: cli.reason, searched: cli.searched }); this.publish([]); return; }
    try {
      if (!root) {
        const m = machineDashboardRun(fresh, homedir());
        const payload = parsePayload(await runCli(cli.path, m.args, m.cwd, DASHBOARD_TIMEOUT_MS));
        if (this.repoRoot !== root) return; // the window opened a repo meanwhile
        this.setState({ kind: 'machine', payload });
        return;
      }
      const [branch, out] = await Promise.all([currentBranch(root), runCli(cli.path, dashboardArgs(root, fresh), root, DASHBOARD_TIMEOUT_MS)]);
      const payload = parsePayload(out);
      if (this.repoRoot !== root) return; // the window's folders changed meanwhile
      const view = repoView(payload, root, branch);
      // Line numbers of another branch's review do not apply to these files.
      this.publish(view.review?.onBranch ? findingsToDiagnostics(view.findings, root, isFile) : []);
      this.setState({ kind: 'ready', payload, view });
    } catch (e) {
      if (this.repoRoot !== root) return;
      if (e instanceof CliError && e.notFound) { this.setState({ kind: 'cli-missing', reason: e.message }); this.publish([]); return; }
      // Keep the last markers: they are still the newest known results.
      this.setState({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }

  private setState(s: State): void {
    this.state = s;
    this.render();
  }

  private render(): void {
    const v = statusView(this.state, fmtTime);
    this.status.text = v.text;
    this.status.tooltip = v.tooltip; // a plain string: never rendered as markdown
    this.status.command = v.command;
    this.status.backgroundColor = v.tint ? new vscode.ThemeColor(v.tint === 'error' ? 'statusBarItem.errorBackground' : 'statusBarItem.warningBackground') : undefined;
    const s = this.state;
    this.model = s.kind === 'ready' ? panelModel(s.payload, s.view, this.records, codewatchOff(s.view.repo), fmtTime)
      : s.kind === 'machine' ? machinePanelModel(s.payload, fmtTime) : null;
    this.postModel();
  }

  private publish(records: DiagnosticRecord[]): void {
    this.records = records;
    const byFile = new Map<string, vscode.Diagnostic[]>();
    for (const r of records) {
      // Diagnostic messages are plain text in the Problems panel and hovers.
      const d = new vscode.Diagnostic(new vscode.Range(r.line, 0, r.line, Number.MAX_SAFE_INTEGER), r.message, SEVERITY[r.severity]);
      d.source = DIAGNOSTIC_SOURCE;
      d.code = r.code;
      byFile.set(r.path, [...(byFile.get(r.path) ?? []), d]);
    }
    this.diags.clear();
    for (const [p, list] of byFile) this.diags.set(vscode.Uri.file(p), list);
  }

  private codeActions(doc: vscode.TextDocument, ctx: vscode.CodeActionContext): vscode.CodeAction[] {
    const out: vscode.CodeAction[] = [];
    for (const d of ctx.diagnostics) {
      if (d.source !== DIAGNOSTIC_SOURCE) continue;
      const r = this.records.find((x) => x.path === doc.uri.fsPath && x.line === d.range.start.line && x.message === d.message);
      if (!r) continue;
      const copy = new vscode.CodeAction('PRISM: Copy finding as a fix prompt', vscode.CodeActionKind.QuickFix);
      copy.diagnostics = [d];
      copy.command = { command: 'prism.copyFixPrompt', title: copy.title, arguments: [{ relPath: r.relPath, finding: r.finding }] };
      const report = new vscode.CodeAction('PRISM: Open review report', vscode.CodeActionKind.QuickFix);
      report.diagnostics = [d];
      report.command = { command: 'prism.openReport', title: report.title };
      out.push(copy, report);
    }
    return out;
  }

  private openPanel(): void {
    if (this.panel) { this.panel.reveal(); return; }
    const media = vscode.Uri.joinPath(this.ctx.extensionUri, 'media');
    const panel = vscode.window.createWebviewPanel('prism.panel', 'PRISM', vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [media] });
    this.panel = panel;
    const w = panel.webview;
    w.html = panelHtml({
      nonce: randomBytes(16).toString('base64'),
      cspSource: w.cspSource,
      scriptUri: w.asWebviewUri(vscode.Uri.joinPath(media, 'panel.js')).toString(),
      styleUri: w.asWebviewUri(vscode.Uri.joinPath(media, 'panel.css')).toString(),
    });
    w.onDidReceiveMessage((m) => this.onPanelMessage(m));
    panel.onDidDispose(() => { this.panel = null; });
  }

  private postModel(): void {
    if (!this.panel) return;
    if (this.model) { void this.panel.webview.postMessage({ type: 'model', model: this.model }); return; }
    const s = this.state;
    const text = s.kind === 'cli-missing' ? cliMissingText(s.reason, s.searched) : s.kind === 'error' ? `prism-cli failed: ${s.message}` : 'Loading PRISM results…';
    void this.panel.webview.postMessage({ type: 'status', text });
  }

  private async onPanelMessage(m: unknown): Promise<void> {
    const a = parsePanelMessage(m, this.model);
    if (!a) return;
    switch (a.type) {
      case 'ready': this.postModel(); return;
      case 'refresh': this.refresher.request({ fresh: true, immediate: true }); return;
      case 'report': await this.openReport(); return;
      case 'enable': await this.enableCodewatch(); return;
      case 'open': {
        const it = this.model?.mode === 'repo' ? this.model.findings.find((f) => f.openable && f.index === a.index) : undefined;
        const r = it ? this.records[it.index] : undefined;
        if (!r) return;
        const pos = new vscode.Position(r.line, 0);
        await vscode.window.showTextDocument(vscode.Uri.file(r.path), { selection: new vscode.Range(pos, pos), viewColumn: vscode.ViewColumn.One });
        return;
      }
      case 'copy': {
        const c = this.model?.checklist.find((x) => x.key === a.key);
        if (!c?.fix) return;
        await vscode.env.clipboard.writeText(c.fix);
        vscode.window.showInformationMessage('PRISM: command copied. Paste it into a terminal to run it.');
        return;
      }
      case 'openFolder':
        // a.path is one of the repo paths in the last prism-cli JSON (parsePanelMessage checked it).
        await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(a.path), { forceNewWindow: true });
        return;
    }
  }

  private async openReport(): Promise<void> {
    const s = this.state;
    const id = s.kind === 'ready' ? s.view.review?.id : undefined;
    const cli = this.cli();
    if (!this.repoRoot || !cli.ok || !isResultId(id)) { vscode.window.showWarningMessage('PRISM: no review report to open.'); return; }
    const dir = await mkdtemp(join(tmpdir(), 'prism-report-'));
    try {
      const file = join(dir, 'report.html');
      await runCli(cli.path, reportArgs(this.repoRoot, id, file), this.repoRoot, REPORT_TIMEOUT_MS);
      const html = await readFile(file, 'utf8');
      // The report is CLI-escaped HTML; scripts stay off and the CSP allows only its inline styles.
      if (!this.report) {
        this.report = vscode.window.createWebviewPanel('prism.report', 'PRISM review report', vscode.ViewColumn.Active, { enableScripts: false, localResourceRoots: [] });
        this.report.onDidDispose(() => { this.report = null; });
      } else {
        this.report.reveal();
      }
      this.report.webview.html = withReportCsp(html);
    } catch (e) {
      vscode.window.showErrorMessage(`PRISM: could not build the report: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** Runs prism-cli itself as the terminal's process (argv, no shell), so the user sees its output and can stop it. In machine mode it runs from the home folder. */
  private inTerminal(name: string, args: string[]): vscode.Terminal | null {
    const cli = this.cli();
    if (!cli.ok) { void this.showInstallHint(); return null; }
    // Merged into the terminal's environment: only PATH changes, with the CLI's folder first.
    const t = vscode.window.createTerminal({ name, cwd: this.repoRoot ?? homedir(), shellPath: cli.path, shellArgs: args, env: { PATH: cliEnv(cli.path).PATH ?? null } });
    t.show();
    return t;
  }

  private async enableCodewatch(): Promise<void> {
    if (!this.repoRoot) { vscode.window.showWarningMessage('PRISM: open a folder inside a git repository first.'); return; }
    const go = await vscode.window.showInformationMessage(
      'Run "prism-cli enable codewatch" in a terminal? It installs PRISM\'s pre-commit secret scan and pre-push review git hooks in this repository.',
      { modal: true }, 'Run in terminal');
    if (go !== 'Run in terminal') return;
    const t = this.inTerminal('PRISM enable codewatch', ['enable', 'codewatch']);
    if (!t) return;
    const sub = vscode.window.onDidCloseTerminal((closed) => {
      if (closed !== t) return;
      sub.dispose();
      this.refresher.request({ immediate: true });
    });
    this.subs.push(sub);
  }

  private async showInstallHint(): Promise<void> {
    const cli = this.cli();
    const detail = cli.ok ? `prism-cli could not be started from ${cli.path}.` : cliMissingText(cli.reason, cli.searched);
    const pick = await vscode.window.showInformationMessage('PRISM: prism-cli was not found.', { modal: true, detail }, 'Copy command', 'Set prism.cliPath');
    if (pick === 'Copy command') await vscode.env.clipboard.writeText(INSTALL_CMD);
    if (pick === 'Set prism.cliPath') await vscode.commands.executeCommand('workbench.action.openSettings', 'prism.cliPath');
  }

  dispose(): void {
    if (this.interval) clearInterval(this.interval);
    this.refresher.dispose();
    this.watcher?.dispose();
    this.panel?.dispose();
    this.report?.dispose();
    this.status.dispose();
    this.diags.dispose();
    for (const s of this.subs) s.dispose();
  }
}

export function activate(ctx: vscode.ExtensionContext): void {
  const p = new Prism(ctx);
  ctx.subscriptions.push(p);
  void p.init();
}

export function deactivate(): void { /* disposed through ctx.subscriptions */ }
