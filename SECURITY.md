# Security policy

Caddy Log Interface can reconfigure your reverse proxy and shows your visitors'
traffic, so security reports are taken seriously and handled privately.

## Reporting a vulnerability

Please **do not open a public issue** for a security problem. Instead, email
**nick@141networks.com** with:

- what the problem is and what an attacker could do with it,
- the version affected (shown in the image tag, or `app/package.json`),
- steps to reproduce, or a proof of concept,
- whether you would like to be credited, and how.

You can also use GitHub's private vulnerability reporting on this repository
(the "Report a vulnerability" button on the Security tab), if it is enabled.

You should get a reply acknowledging the report within a few days. Once the
problem is confirmed, a fix is prepared and released, and the issue is then
described in the release notes — with credit, if you want it. Please allow a
reasonable time for a fix before disclosing publicly.

## Supported versions

Security fixes are made for the latest release in the current major version
(1.x). Please upgrade to the newest image (`victimofareload/caddylogs:1`) before
reporting, in case the problem is already fixed.

## What is in scope

Anything that lets someone act without permission, for example:

- getting past sign-in, taking over a session, or bypassing CSRF protection;
- a signed-in user without `CADDY_EDITORS` rights changing Caddy's
  configuration;
- injecting script or markup through log content (URLs, user agents, headers);
- reading files or reaching services the interface should not expose;
- the image running with more privilege than documented.

Out of scope: problems that need an attacker to already control the host,
Docker, or the `.env` file; and weaknesses in Caddy itself (report those to the
[Caddy project](https://github.com/caddyserver/caddy/security)).
