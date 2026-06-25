# Task: implement the quote CLI

Update `examples/daytona-cli-tdd/bin/quote.js`.

Requirements:

- Use Node.js built-ins only; do not add dependencies.
- Parse `--text <value>` and print the value wrapped in double quotes.
- If `--upper` is present, uppercase the text before quoting it.
- On success, write only to stdout and exit with code 0.
- If `--text` is missing or empty, write
  `Usage: quote --text <value> [--upper]` to stderr and exit with code 2.
- Preserve spaces inside the text argument.

Your working area:

- You may edit only `examples/daytona-cli-tdd/bin/quote.js`.
- The protected tests under `examples/daytona-cli-tdd/test` are read-only
  context and must not be changed.
- Do not read or edit protected Harness files under
  `examples/daytona-cli-tdd/contracts` or
  `examples/daytona-cli-tdd/harness.config.json`.
