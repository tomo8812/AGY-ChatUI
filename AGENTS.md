# Repository Agent Instructions (`tomo8812/AGY-ChatUI`)

This file applies **only** to the `tomo8812/AGY-ChatUI` repository.

## Core Design Principle

**AGY-ChatUI is a transparent ChatUI that never overrides or independently controls Antigravity's native behavior**（「Antigravity本来の挙動を一切独自制御しない透過的ChatUI」）.

- **Pass through native `agy` / ACP behavior faithfully**: Let the unmodified official `agy` binary and ACP protocol drive agent turns, Reactive Wakeup, background notifications, tool states, subagent lifecycles, authentication, and worker lifecycles without ChatUI-side state overrides, synthetic timers, or custom control logic.
- **Keep ChatUI strictly as a thin, transparent presentation and isolation layer**: Only handle multi-user workspace/process isolation, UI rendering, persistence/replay, and transport — never alter, intercept, or re-interpret how Antigravity itself thinks, schedules, or executes.

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
