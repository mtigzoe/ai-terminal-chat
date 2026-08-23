# Security Policy

## Supported Versions

Security fixes are generally applied to the current `main` branch and the most recent stable release, when applicable.

Older releases may not receive security fixes. Users should upgrade to the latest version when possible.

## Reporting a Vulnerability

Please do not disclose security vulnerabilities in a public GitHub issue.

Report security vulnerabilities privately through GitHub's available private security reporting mechanism for this repository. Include as much of the following information as possible:

- A clear description of the vulnerability.
- Steps to reproduce the issue.
- The affected component, file, feature, or version.
- The potential security impact.
- Any proof-of-concept or relevant logs, with secrets and personal information removed.
- A suggested mitigation, if known.

Please allow maintainers reasonable time to investigate and address a reported vulnerability before publicly disclosing it.

## Security-Sensitive Areas

Because ai-terminal-chat can interact with local AI providers, terminal commands, project files, and Git repositories, security reports involving the following areas are especially important:

- Unauthorized command execution.
- Unauthorized filesystem or project access.
- Git operations performed without appropriate user authorization.
- Exposure or mishandling of API keys, credentials, or other secrets.
- Prompt injection that causes unauthorized tool or terminal actions.
- Authentication or authorization weaknesses.
- Electron or browser security issues.
- Provider integrations that expose sensitive information.
- Security issues that could affect users of local or offline AI configurations.

## Credential Safety

Never include API keys, passwords, access tokens, private keys, or other sensitive credentials in public issues, pull requests, logs, screenshots, or commits.

If a credential has been accidentally committed or exposed, revoke or rotate it immediately and then report the incident privately.

## Security Contributions

Security improvements and security-focused tests are welcome. Please avoid publishing an exploit before maintainers have had an opportunity to investigate and address the underlying vulnerability.
