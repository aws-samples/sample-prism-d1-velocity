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
import { parsePayload, repoView } from './payload';
import { INTERVAL_MS, Refresher } from './refresh';
import { cliMissingText, statusView, updateText, type State } from './status';
import { cliIsCurrent, handlePanelMessage, StdioClient, uiHtml, UPDATE_CMD, UPDATE_TEXT, updateHtml, withReportCsp } from './ui-host';

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
  /** The PRISM panel: prism-cli's own dashboard UI, and the --serve-stdio child that answers it. */
  private panel: { view: vscode.WebviewPanel; client: StdioClient | null } | null = null;
  private report: vscode.WebviewPanel | null = null;
  private watcher: vscode.FileSystemWatcher | null = null;
  private interval: NodeJS.Timeout | null = null;

  constructor() {
    this.status.name = 'PRISM';
    const cmd = (id: string, fn: (...a: any[]) => unknown) => this.subs.push(vscode.commands.registerCommand(id, fn));
    cmd('prism.openPanel', () => { void this.openPanel(); });
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
        if (!cliIsCurrent(payload.version?.installed)) { this.setState({ kind: 'cli-old', installed: payload.version?.installed ?? null }); return; }
        this.setState({ kind: 'machine', payload });
        return;
      }
      const [branch, out] = await Promise.all([currentBranch(root), runCli(cli.path, dashboardArgs(root, fresh), root, DASHBOARD_TIMEOUT_MS)]);
      const payload = parsePayload(out);
      if (this.repoRoot !== root) return; // the window's folders changed meanwhile
      // An older prism-cli: no markers, no data, only how to update it.
      if (!cliIsCurrent(payload.version?.installed)) { this.publish([]); this.setState({ kind: 'cli-old', installed: payload.version?.installed ?? null }); return; }
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

  /**
   * The PRISM panel: the browser dashboard's own UI, loaded from the installed prism-cli (dist/ui),
   * talking to `prism-cli dashboard --serve-stdio` (no port, no token). prism-cli missing or older
   * than 1.21.0: the panel shows only how to update it.
   */
  private async openPanel(): Promise<void> {
    if (this.panel) { this.panel.view.reveal(); return; }
    const view = vscode.window.createWebviewPanel('prism.panel', 'PRISM', vscode.ViewColumn.Active, { enableScripts: false, localResourceRoots: [] });
    const entry: { view: vscode.WebviewPanel; client: StdioClient | null } = { view, client: null };
    this.panel = entry;
    view.onDidDispose(() => { entry.client?.dispose(); if (this.panel === entry) this.panel = null; });
    const notCurrent = (reason: string) => { view.webview.html = updateHtml({ reason, command: UPDATE_CMD }); };
    const cli = this.cli();
    if (!cli.ok) { notCurrent(`prism-cli was not found (${cli.reason}). Or set prism.cliPath to the output of \`command -v prism-cli\`.`); return; }
    const client = new StdioClient(cli.path, this.repoRoot ?? homedir(), cliEnv(cli.path));
    entry.client = client;
    let hello;
    try { hello = await client.start(); } catch (e) {
      notCurrent((e as Error).message === UPDATE_TEXT || (e as Error).message.startsWith(UPDATE_TEXT) ? `The prism-cli at ${cli.path} is older than this panel needs.` : `prism-cli could not start the panel: ${(e as Error).message}`);
      return;
    }
    if (this.panel !== entry) { client.dispose(); return; }
    const ui = vscode.Uri.file(hello.uiDir);
    const w = view.webview;
    w.options = { enableScripts: true, localResourceRoots: [ui] };
    const uri = (f: string) => w.asWebviewUri(vscode.Uri.joinPath(ui, f)).toString();
    const kind = vscode.window.activeColorTheme.kind;
    w.html = uiHtml({
      nonce: randomBytes(16).toString('base64'), cspSource: w.cspSource,
      cssUri: uri('prism-ui.css'), bridgeUri: uri('bridge.js'), jsUri: uri('prism-ui.js'),
      body: await readFile(join(hello.uiDir, 'body.html'), 'utf8'),
      theme: kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight ? 'light' : 'dark',
    });
    w.onDidReceiveMessage((m) => this.onPanelMessage(entry, client, m));
  }

  /** One webview message (ui-host.ts handlePanelMessage); answers go back only while this panel is open. */
  private async onPanelMessage(entry: { view: vscode.WebviewPanel }, client: StdioClient, m: unknown): Promise<void> {
    await handlePanelMessage(m, client, {
      // AWS-writing actions: a native modal on top of the panel's dialog, decided from the CLI's own catalog.
      confirm: async (c) => (await vscode.window.showWarningMessage(c.title, { modal: true, detail: c.detail }, c.button)) === c.button,
      showReport: (html) => this.showReportHtml(html),
      noReport: (status) => { vscode.window.showWarningMessage(`PRISM: no report for that review (${status}).`); },
      post: (msg) => { if (this.panel === entry) void entry.view.webview.postMessage(msg); },
    });
  }

  private showReportHtml(html: string): void {
    // The report is CLI-escaped HTML; scripts stay off and the CSP allows only its inline styles.
    if (!this.report) {
      this.report = vscode.window.createWebviewPanel('prism.report', 'PRISM review report', vscode.ViewColumn.Active, { enableScripts: false, localResourceRoots: [] });
      this.report.onDidDispose(() => { this.report = null; });
    } else {
      this.report.reveal();
    }
    this.report.webview.html = withReportCsp(html);
  }

  private async openReport(): Promise<void> {
    const s = this.state;
    const id = s.kind === 'ready' ? s.view.review?.id : undefined;
    const root = this.repoRoot;
    if (!root || !isResultId(id)) { vscode.window.showWarningMessage('PRISM: no review report to open.'); return; }
    await this.showReport(root, (out) => reportArgs(root, id, out));
  }

  /** Runs prism-cli codewatch report into a temp file and shows it (the Problems quick fix). */
  private async showReport(repo: string, args: (output: string) => string[]): Promise<void> {
    const cli = this.cli();
    if (!cli.ok) { void this.showInstallHint(); return; }
    let dir: string | null = null;
    try {
      dir = await mkdtemp(join(tmpdir(), 'prism-report-'));
      const file = join(dir, 'report.html');
      await runCli(cli.path, args(file), repo, REPORT_TIMEOUT_MS);
      this.showReportHtml(await readFile(file, 'utf8'));
    } catch (e) {
      vscode.window.showErrorMessage(`PRISM: could not build the report: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true });
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
    const s = this.state;
    const old = s.kind === 'cli-old';
    const detail = old ? updateText(s.installed) : cli.ok ? `prism-cli could not be started from ${cli.path}.` : cliMissingText(cli.reason, cli.searched);
    const pick = await vscode.window.showInformationMessage(old ? `PRISM: update prism-cli to 1.21.0 or later.` : 'PRISM: prism-cli was not found.', { modal: true, detail }, 'Copy command', 'Set prism.cliPath');
    if (pick === 'Copy command') await vscode.env.clipboard.writeText(UPDATE_CMD);
    if (pick === 'Set prism.cliPath') await vscode.commands.executeCommand('workbench.action.openSettings', 'prism.cliPath');
  }

  dispose(): void {
    if (this.interval) clearInterval(this.interval);
    this.refresher.dispose();
    this.watcher?.dispose();
    this.panel?.view.dispose();
    this.report?.dispose();
    this.status.dispose();
    this.diags.dispose();
    for (const s of this.subs) s.dispose();
  }
}

export function activate(ctx: vscode.ExtensionContext): void {
  const p = new Prism();
  ctx.subscriptions.push(p);
  void p.init();
}

export function deactivate(): void { /* disposed through ctx.subscriptions */ }
