# Contributing

Bug reports and focused pull requests are welcome. Before changing code, please open an issue when the behavior or scope is not obvious.

Development needs Node.js 22.13 or newer, pnpm 11, `zip`, `unzip`, and GNU `tar`.

```bash
pnpm install
pnpm verify
pnpm package
```

Keep changes small enough to review. Add tests for behavior changes, avoid real credentials and private T3 data in fixtures, and do not commit generated `dist/` or `release/` output.

If an AI tool materially helped write a contribution, disclose that in the pull request. You remain responsible for understanding the code, checking its behavior, and writing the issue or pull-request discussion yourself.
