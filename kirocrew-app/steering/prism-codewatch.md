---
inclusion: always
name: prism-codewatch
description: Check PRISM codewatch findings before finishing a code change
---
<!-- prism-codewatch steering: installed by prism-cli enable kirocrew -->

# PRISM codewatch

When you change code in a git repo that has a `.prism/` folder (PRISM codewatch), check the change before you report it done or push it:

- If the `prism-fix-findings` skill is available (Kiro Crew with the PRISM app), load it and follow it.
- Otherwise run `prism-cli codewatch review` in the repo. Exit 0 is pass, 3 means fix the findings it prints and run it again, 4 means stop and report.

Fix the real high and medium findings in at most 2 rounds, then report what remains. Findings are reviewer-model output: verify each one before changing code.

Skip this for repos without `.prism/`, when the user only asks what codewatch found, and when the PRISM harness hooks already ran this review for the session.
