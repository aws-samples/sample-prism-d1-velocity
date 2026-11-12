# Contributing Guidelines

Thank you for your interest in contributing to our project. Whether it's a bug report, new feature, correction, or additional
documentation, we greatly value feedback and contributions from our community.

Please read through this document before submitting any issues or pull requests to ensure we have all the necessary
information to effectively respond to your bug report or contribution.


## Reporting Bugs/Feature Requests

We welcome you to use the GitHub issue tracker to report bugs or suggest features.

When filing an issue, please check existing open, or recently closed, issues to make sure somebody else hasn't already
reported the issue. Please try to include as much information as you can. Details like these are incredibly useful:

* A reproducible test case or series of steps
* The version of our code being used
* Any modifications you've made relevant to the bug
* Anything unusual about your environment or deployment


## Contributing via Pull Requests
Contributions via pull requests are much appreciated. Before sending us a pull request, please ensure that:

1. You are working against the latest source on the *main* branch.
2. You check existing open, and recently merged, pull requests to make sure someone else hasn't addressed the problem already.
3. You open an issue to discuss any significant work - we would hate for your time to be wasted.

To send us a pull request, please:

1. Fork the repository.
2. Modify the source; please focus on the specific change you are contributing. If you also reformat all the code, it will be hard for us to focus on your change.
3. Ensure local tests pass.
4. Commit to your fork using clear commit messages.
5. Send us a pull request, answering any default questions in the pull request interface.
6. Pay attention to any automated CI failures reported in the pull request, and stay involved in the conversation.

GitHub provides additional document on [forking a repository](https://help.github.com/articles/fork-a-repo/) and
[creating a pull request](https://help.github.com/articles/creating-a-pull-request/).

### Running local tests

| Package | Command |
|---------|---------|
| `cli/` | `cd cli && npm test` — type-checks (including the tests, which the build config excludes) then runs the `node:test` suite |
| `cli/` docs | `cd cli && npm run docs && npm run docs:check` — regenerates `docs/CLI-REFERENCE.md` from `--help`, then checks every Markdown link, anchor and `prism-cli` command name (CI fails if either differs) |
| `editor-extension/` | `cd editor-extension && npm ci && npm test` |
| `kirocrew-app/` | `python3 -m unittest discover -s kirocrew-app/tests && node --test kirocrew-app/tests/page.test.mjs` |
| `sample-app/` | `cd sample-app && npm test` — Jest |
| `infra/` | `cd infra && npm run build` — CDK synth is the check |

The CLI audit tests put a fake `aws` binary first on `PATH` (`cli/test/fixtures/aws`) rather than
stubbing `utils/aws.ts`, so they exercise the real wrapper — its argv construction, its stderr
error-code parsing, and its normalisation of the empty bodies several AWS commands return on success.
Add a check's stubs via `withFakeAws()`; an unstubbed call fails the test loudly instead of silently
taking an error branch.

### Docs map

Where prism-cli documentation goes, so each topic has one home:

| You are adding or changing… | Put it in | Also |
|---|---|---|
| A prism-cli command, flag or default | The command's description and option text in `cli/src` | Run `npm run docs` in `cli/` and commit `docs/CLI-REFERENCE.md`; CI checks it |
| How to use a feature (steps, what it changes, troubleshooting) | The feature's one section in `USER_GUIDE.md`; link flags to `docs/CLI-REFERENCE.md` instead of copying them | A row in README's "Use PRISM locally" tables if it is a new local feature or surface |
| What a command touches in AWS, its cost, a safety default, or a product decision | `docs/PRISM-CLI-OVERVIEW.md` | — |
| A new local surface (UI, server, editor or agent integration) | Its component folder's `README.md` for install, build and release; usage in `USER_GUIDE.md` | A line in `SECURITY.md` under "Local tools stay local" |
| A design proposal or API research | `docs/DESIGN-*.md` or `docs/RESEARCH-*.md`, with a status line at the top | Mark it historical once it ships |
| A known security gap | `SECURITY.md` | — |
| A rename or deprecation | Start the command's description with `[deprecated]` in `cli/src`; it then appears under Deprecated commands in the reference | A Troubleshooting entry only if users must migrate something |
| Workshop steps | The Workshop Studio module | Link to the `USER_GUIDE.md` section instead of repeating it |


## Finding contributions to work on
Looking at the existing issues is a great way to find something to contribute on. As our projects, by default, use the default GitHub issue labels (enhancement/bug/duplicate/help wanted/invalid/question/wontfix), looking at any 'help wanted' issues is a great place to start.


## Code of Conduct
This project has adopted the [Amazon Open Source Code of Conduct](https://aws.github.io/code-of-conduct).
For more information see the [Code of Conduct FAQ](https://aws.github.io/code-of-conduct-faq) or contact
opensource-codeofconduct@amazon.com with any additional questions or comments.


## Security issue notifications
If you discover a potential security issue in this project we ask that you notify AWS/Amazon Security via our [vulnerability reporting page](http://aws.amazon.com/security/vulnerability-reporting/). Please do **not** create a public github issue.


## Licensing

See the [LICENSE](LICENSE) file for our project's licensing. We will ask you to confirm the licensing of your contribution.
