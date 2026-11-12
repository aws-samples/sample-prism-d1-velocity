# prism-cli

The command line for [PRISM D1 Velocity](https://github.com/aws-samples/sample-prism-d1-velocity): measure, secure and review AI-assisted development from your own machine. Codewatch git hooks, a local dashboard, an MCP server for AI agents, AWS Security Agent scans, read-only AWS account checks, and the setup helpers for a team's PRISM deployment.

> Sample project, not production-ready. See [SECURITY.md](https://github.com/aws-samples/sample-prism-d1-velocity/blob/main/SECURITY.md).

## Install

Node.js 22 or later:

```bash
npm install -g @prism-d1/cli
prism-cli version     # installed version, newer release on npm, other copies on PATH
```

## Quick start

```bash
prism-cli enable codewatch    # in a repo: secret scan on commit, AI review on push (report only)
prism-cli dashboard           # local page on 127.0.0.1: results, AI usage, setup checklist
prism-cli aws check           # read-only AWS account checks; then prism-cli aws recommend
```

Send AI usage to your team's PRISM with `prism-cli enable codeburn --url <OtelCollectorUrl>` (the URL comes from your platform team). Every command takes `--help`.

## Documentation

- [Using PRISM locally](https://github.com/aws-samples/sample-prism-d1-velocity/blob/main/USER_GUIDE.md#using-prism-locally): what each feature does and where it shows up (VS Code family editors, Kiro Crew, Claude Code)
- [Command reference](https://github.com/aws-samples/sample-prism-d1-velocity/blob/main/docs/CLI-REFERENCE.md): every command and flag
- [prism-cli Overview](https://github.com/aws-samples/sample-prism-d1-velocity/blob/main/docs/PRISM-CLI-OVERVIEW.md): what each command touches in AWS, its cost and its safety defaults
- [User Guide](https://github.com/aws-samples/sample-prism-d1-velocity/blob/main/USER_GUIDE.md): deploying PRISM, CI workflows and eval gates

## Develop

From `cli/` in a clone:

```bash
npm ci
npm run build       # tsc -> dist/, plus the bundled assets
npm test            # type-checks the tests, then the node:test suite
npm run docs        # regenerate docs/CLI-REFERENCE.md after changing a command or flag
```

Releases are published to npm by `.github/workflows/publish.yml` when a `v*` tag is pushed.

## License

MIT
