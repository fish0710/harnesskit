# Task: implement the resume health server

Create `examples/resume-health-port/src/server.js`.

Requirements for the initial implementation:

- Use Node.js built-in `http`; do not add dependencies.
- Serve `GET /health`.
- Return HTTP 200 with JSON containing `"ready": true`.
- Return HTTP 404 for other paths.
- Listen on host `127.0.0.1`.
- Listen on port `3321`.

Protected files are not part of your working area:

- Do not read or edit `examples/resume-health-port/contracts`.
- Do not read or edit `examples/resume-health-port/harness.config.json`.

If the Harness gate later returns failure feedback saying the service must be
reachable on a different port, update only `examples/resume-health-port/src/server.js`
to satisfy that feedback.
