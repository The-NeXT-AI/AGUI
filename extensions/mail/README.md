# Mail

Connect to a mailbox over POP3/SMTP and show recent messages in the AGUI session tree.

## Development

```bash
pnpm --dir extensions/mail build
node scripts/package-extension.mjs extensions/mail
```

## Notes

- POP3 is used to read the Inbox and build virtual mail sessions.
- SMTP is used for connection/authentication checks and sending email.
- The extension contributes a `mail_send_message` MCP tool for Agent runs.
- Passwords are stored with AGUI extension Secret storage through `AGUI_MAIL_PASSWORD`.
- The MCP server receives SMTP settings from the extension configuration through `AGUI_MAIL_ACCOUNT_JSON`.
- Many providers require POP3 to be enabled and require an app password or authorization code.
