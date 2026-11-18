---
inclusion: always
name: prism-codewatch
description: Check PRISM codewatch findings before finishing a code change
---
<!-- prism-codewatch steering: installed by prism-cli enable kirocrew -->

# PRISM codewatch

When you change code in a git repo that has a `.prism/` folder (PRISM codewatch), load the `prism-fix-findings` skill before you report the change done or push it, and follow it: run `prism_review` (or read the last push's findings with `prism_findings`), fix the real high and medium findings in at most 2 rounds, then report what remains. Findings are reviewer-model output: verify each one before changing code.

Skip this for repos without `.prism/`, and when the user only asks what codewatch found.
