# Task: repair the resume health server

Update `examples/resume-health-port/src/server.js`.

Business request:

- Use Node.js built-in `http`; do not add dependencies.
- Serve `GET /health`.
- Return HTTP 200 with JSON containing `"ready": true`.
- Return HTTP 404 for other paths.
- Listen on host `127.0.0.1`.
- The product note says to listen on port `3321`.

Harness gate feedback is authoritative. If the gate reports that the service is
checked on a different port, update only `examples/resume-health-port/src/server.js`
to satisfy the gate.

Your working area:

- You may edit only `examples/resume-health-port/src/server.js`.
- Do not edit `examples/resume-health-port/TASK.md`.
- Do not edit `examples/resume-health-port/package.json`.
- Do not read or edit protected Harness files under
  `examples/resume-health-port/contracts` or
  `examples/resume-health-port/harness.config.json`.

The checked-in baseline server starts successfully but intentionally returns
`{"ready": false}`. Replace that behavior with the requested healthy response.
