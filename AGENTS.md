# Repository Agent Instructions (`tomo8812/AGY-ChatUI`)

This file applies **only** to the `tomo8812/AGY-ChatUI` repository.

## Pull Request Review Workflow

Whenever you create a Pull Request in this repository, follow these steps automatically without waiting for additional user instructions:

1. **Request review immediately after creating the PR**:
   ```bash
   gh pr comment <PR_NUMBER> --body "@cubic-dev-ai review this pull request"
   ```
2. **Wait for the review and iterate until 0 findings**:
   - Monitor the PR's CI checks and `@cubic-dev-ai` review comments.
   - If any findings or review comments are reported, fix them, push the updated commits to the PR branch, and re-run:
     ```bash
     gh pr comment <PR_NUMBER> --body "@cubic-dev-ai review this pull request"
     ```
   - Repeat this cycle until the review completes with **0** findings.
