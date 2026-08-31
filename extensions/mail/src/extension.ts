import net from "node:net";
import tls from "node:tls";
import { TextDecoder } from "node:util";

const NAMESPACE = "agui.mail";
const ACCOUNT_KEY = `${NAMESPACE}.account`;
const MESSAGES_PER_PAGE_KEY = `${NAMESPACE}.messagesPerPage`;
const PREVIEW_LINES_KEY = `${NAMESPACE}.previewLines`;
const PASSWORD_KEY = "AGUI_MAIL_PASSWORD";
const MAIL_RENDERER = `${NAMESPACE}.message`;
const DEFAULT_MESSAGES_PER_PAGE = 20;
const DEFAULT_PREVIEW_LINES = 20;
const MAX_MESSAGES_PER_PAGE = 50;
const MAX_PREVIEW_LINES = 80;
const MAX_PREVIEW_CHARS = 1200;
const CONNECTION_TIMEOUT_MS = 20_000;
const MAX_SMTP_RESPONSE_LINES = 80;
const MAX_SEND_BODY_BYTES = 256 * 1024;
const MAX_SEND_RECIPIENTS = 100;
const MAX_SEND_SUBJECT_BYTES = 998;

type MailSecurity = "plain" | "starttls" | "tls";

type MailAccount = {
  displayName: string;
  email: string;
  incomingHost: string;
  incomingPort: number;
  incomingSecurity: MailSecurity;
  outgoingHost: string;
  outgoingPort: number;
  outgoingSecurity: MailSecurity;
  rejectUnauthorized: boolean;
  username: string;
};

type MailMessage = {
  accountEmail: string;
  date: string;
  from: string;
  messageId: string;
  number: number;
  preview: string;
  size: number;
  subject: string;
  to: string;
  uid: string;
};

type SendMailMessage = {
  bcc: string[];
  body: string;
  bodyFormat: "html" | "text";
  cc: string[];
  from: string;
  replyTo: string;
  subject: string;
  to: string[];
};

type LineSocketConnectOptions = {
  host: string;
  port: number;
  rejectUnauthorized: boolean;
  secure: boolean;
  servername: string;
  timeoutMs: number;
};

type LineWaiter = {
  reject(error: Error): void;
  resolve(line: string): void;
};

type TlsUpgradeOptions = {
  rejectUnauthorized: boolean;
  servername: string;
};

export function activate(context) {
  context.commands.registerCommand(`${NAMESPACE}.authStatus`, async (input = {}) => {
    const account = configuredAccount(context);
    const passwordConfigured = Boolean(stringValue(context.secrets.get(PASSWORD_KEY)));
    return {
      account: redactedAccount(account),
      configured: isIncomingConfigured(account) && passwordConfigured,
      messagesPerPage: configuredMessagesPerPage(context),
      passwordConfigured,
      previewLines: configuredPreviewLines(context),
    };
  });

  context.commands.registerCommand(`${NAMESPACE}.panelData`, async () => {
    const account = configuredAccount(context);
    const passwordConfigured = Boolean(stringValue(context.secrets.get(PASSWORD_KEY)));
    return {
      account: redactedAccount(account),
      configured: isIncomingConfigured(account) && passwordConfigured,
      incoming: connectionLabel(
        account.incomingHost,
        account.incomingPort,
        account.incomingSecurity,
      ),
      messagesPerPage: configuredMessagesPerPage(context),
      outgoing: connectionLabel(
        account.outgoingHost,
        account.outgoingPort,
        account.outgoingSecurity,
      ),
      passwordConfigured,
      previewLines: configuredPreviewLines(context),
    };
  });

  context.commands.registerCommand(`${NAMESPACE}.testConnection`, async (input = {}) => {
    const payload = objectValue(input);
    const zh = inputLanguageZh(payload);
    const account = normalizeAccount(payload.account ?? context.configuration.get(ACCOUNT_KEY));
    const password =
      stringValue(payload.password) || stringValue(context.secrets.get(PASSWORD_KEY));
    if (!isIncomingConfigured(account) || !password) {
      throw new Error(mailText("missingIncomingConfig", zh));
    }

    const incoming = await testPopConnection(account, password, zh);
    const outgoing = isOutgoingConfigured(account)
      ? await testSmtpConnection(account, password, zh)
      : {
          ok: true,
          skipped: true,
          message: mailText("smtpSkipped", zh),
        };
    return {
      account: redactedAccount(account),
      incoming,
      ok: incoming.ok === true && outgoing.ok === true,
      outgoing,
    };
  });

  context.commands.registerCommand(`${NAMESPACE}.sendMessage`, async (input = {}) => {
    const payload = objectValue(input);
    const zh = inputLanguageZh(payload);
    const account = configuredAccount(context);
    const password = stringValue(context.secrets.get(PASSWORD_KEY));
    if (!isOutgoingConfigured(account) || !password) {
      throw new Error(mailText("missingOutgoingConfig", zh));
    }
    const message = mailSendMessageFromInput(payload, account, zh);
    return sendSmtpMessage(account, password, message, zh);
  });

  context.commands.registerCommand(`${NAMESPACE}.sessionTree`, async (input = {}) => {
    const zh = inputLanguageZh(input);
    return mailSessionTreeNodes(context, zh);
  });

  context.commands.registerCommand(`${NAMESPACE}.messages`, async (input = {}) => {
    const zh = inputLanguageZh(input);
    return mailMessageTreePage(context, input, zh);
  });
}

function configuredAccount(context) {
  return normalizeAccount(context.configuration.get(ACCOUNT_KEY));
}

function configuredMessagesPerPage(context) {
  return clampNumber(
    Number(context.configuration.get(MESSAGES_PER_PAGE_KEY) ?? DEFAULT_MESSAGES_PER_PAGE),
    1,
    MAX_MESSAGES_PER_PAGE,
    DEFAULT_MESSAGES_PER_PAGE,
  );
}

function configuredPreviewLines(context) {
  return clampNumber(
    Number(context.configuration.get(PREVIEW_LINES_KEY) ?? DEFAULT_PREVIEW_LINES),
    0,
    MAX_PREVIEW_LINES,
    DEFAULT_PREVIEW_LINES,
  );
}

export function normalizeAccount(value): MailAccount {
  const record = objectValue(value);
  const email = singleLineString(record.email).trim();
  const username = singleLineString(record.username).trim() || email;
  const incomingSecurity = mailSecurity(record.incomingSecurity, "tls");
  const outgoingSecurity = mailSecurity(record.outgoingSecurity, "tls");
  return {
    displayName: singleLineString(record.displayName).trim(),
    email,
    incomingHost: hostnameValue(record.incomingHost),
    incomingPort: clampPort(record.incomingPort, defaultPopPort(incomingSecurity)),
    incomingSecurity,
    outgoingHost: hostnameValue(record.outgoingHost),
    outgoingPort: clampPort(record.outgoingPort, defaultSmtpPort(outgoingSecurity)),
    outgoingSecurity,
    rejectUnauthorized: record.rejectUnauthorized !== false,
    username,
  };
}

function redactedAccount(account: MailAccount) {
  return {
    displayName: account.displayName,
    email: account.email,
    incomingHost: account.incomingHost,
    incomingPort: account.incomingPort,
    incomingSecurity: account.incomingSecurity,
    outgoingHost: account.outgoingHost,
    outgoingPort: account.outgoingPort,
    outgoingSecurity: account.outgoingSecurity,
    rejectUnauthorized: account.rejectUnauthorized,
    username: account.username,
  };
}

function isIncomingConfigured(account: MailAccount) {
  return Boolean(account.username && account.incomingHost && account.incomingPort);
}

export function isOutgoingConfigured(account: MailAccount) {
  return Boolean(account.username && account.outgoingHost && account.outgoingPort);
}

function mailSessionTreeNodes(context, zh) {
  const account = configuredAccount(context);
  const passwordConfigured = Boolean(stringValue(context.secrets.get(PASSWORD_KEY)));
  if (!isIncomingConfigured(account) || !passwordConfigured) {
    return {
      children: [
        infoSessionNode(
          `${NAMESPACE}.setup`,
          zh ? "配置邮箱账号" : "Configure mail account",
          zh
            ? "打开插件设置，填写 POP3/SMTP 服务器和应用密码。"
            : "Open extension settings and add POP3/SMTP servers plus an app password.",
          setupMarkdown(zh),
          zh,
        ),
      ],
    };
  }

  const label = accountLabel(account, zh);
  const accountNodeId = `${NAMESPACE}.account.${nodeSlug(`${account.email}:${account.username}`)}`;
  return {
    children: [
      {
        id: accountNodeId,
        title: label,
        icon: "mail",
        kind: "folder",
        badge: "POP3",
        description: connectionLabel(
          account.incomingHost,
          account.incomingPort,
          account.incomingSecurity,
        ),
        children: [
          {
            id: `${accountNodeId}.inbox`,
            title: zh ? "收件箱" : "Inbox",
            icon: "inbox",
            kind: "folder",
            badge: String(configuredMessagesPerPage(context)),
            description: zh ? "展开加载最近邮件" : "Expand to load recent messages",
            hasMore: true,
            loadChildrenCommand: `${NAMESPACE}.messages`,
            loadMoreCommand: `${NAMESPACE}.messages`,
            loadInput: {
              mailbox: "inbox",
            },
            children: [],
          },
        ],
      },
    ],
  };
}

async function mailMessageTreePage(context, input, zh) {
  const account = configuredAccount(context);
  const password = stringValue(context.secrets.get(PASSWORD_KEY));
  if (!isIncomingConfigured(account) || !password) {
    return {
      children: [
        emptyFolderNode(
          `${NAMESPACE}.messages.configure`,
          zh ? "先配置邮箱账号" : "Configure mail account first",
          zh,
        ),
      ],
      hasMore: false,
    };
  }

  const payload = objectValue(input);
  const pageSize = configuredMessagesPerPage(context);
  const previewLines = configuredPreviewLines(context);
  let client;
  try {
    client = await connectPop3(account, password, zh);
    const stat = await client.stat();
    if (stat.count <= 0) {
      return {
        children: [
          emptyFolderNode(`${NAMESPACE}.messages.empty`, zh ? "没有邮件" : "No messages", zh),
        ],
        hasMore: false,
      };
    }

    const list = await client.list().catch(() => new Map());
    const uidls = await client.uidl().catch(() => new Map());
    const cursor = Number(payload.cursor || 0);
    const startNumber =
      Number.isFinite(cursor) && cursor > 0 ? Math.min(cursor, stat.count) : stat.count;
    const numbers = messageNumbersForPage(startNumber, pageSize, list, stat.count);
    const children = [];
    for (const number of numbers) {
      try {
        const lines = await client.top(number, previewLines);
        const message = parsePopMessage({
          account,
          lines,
          number,
          size: Number(list.get(number) || 0),
          uid: stringValue(uidls.get(number)) || `${number}`,
          zh,
        });
        children.push(mailMessageNode(message, zh));
      } catch (error) {
        children.push(
          errorSessionNode(
            `${NAMESPACE}.message.error.${number}`,
            `${zh ? "无法读取邮件" : "Could not read message"} #${number}`,
            errorMessage(error),
            zh,
          ),
        );
      }
    }

    const nextNumber = nextMessageNumber(numbers[numbers.length - 1] - 1, list);
    return {
      children:
        children.length > 0
          ? children
          : [
              emptyFolderNode(
                `${NAMESPACE}.messages.emptyPage.${startNumber}`,
                zh ? "没有更多邮件" : "No more messages",
                zh,
              ),
            ],
      cursor: nextNumber > 0 ? String(nextNumber) : "",
      hasMore: nextNumber > 0,
    };
  } catch (error) {
    return {
      children: [
        errorSessionNode(
          `${NAMESPACE}.messages.connectionError`,
          zh ? "邮箱连接失败" : "Mail connection failed",
          errorMessage(error),
          zh,
        ),
      ],
      hasMore: false,
    };
  } finally {
    if (client) await client.quit().catch(() => undefined);
  }
}

function messageNumbersForPage(startNumber, pageSize, list, maxNumber) {
  const numbers = [];
  for (let number = startNumber; number >= 1 && numbers.length < pageSize; number -= 1) {
    if (!list.size || list.has(number)) numbers.push(number);
  }
  return numbers;
}

function nextMessageNumber(startNumber, list) {
  for (let number = startNumber; number >= 1; number -= 1) {
    if (!list.size || list.has(number)) return number;
  }
  return 0;
}

async function testPopConnection(account, password, zh) {
  let client;
  try {
    client = await connectPop3(account, password, zh);
    const stat = await client.stat();
    return {
      count: stat.count,
      message: mailText("popConnected", zh).replace("{count}", String(stat.count)),
      ok: true,
    };
  } finally {
    if (client) await client.quit().catch(() => undefined);
  }
}

async function testSmtpConnection(account, password, zh) {
  let client;
  try {
    client = await LineSocket.connect({
      host: account.outgoingHost,
      port: account.outgoingPort,
      rejectUnauthorized: account.rejectUnauthorized,
      secure: account.outgoingSecurity === "tls",
      servername: account.outgoingHost,
      timeoutMs: CONNECTION_TIMEOUT_MS,
    });
    await readSmtpResponse(client, [220], zh);
    await smtpCommand(client, "EHLO agui.local", [250], zh);
    if (account.outgoingSecurity === "starttls") {
      await smtpCommand(client, "STARTTLS", [220], zh);
      await client.upgradeTls({
        rejectUnauthorized: account.rejectUnauthorized,
        servername: account.outgoingHost,
      });
      await smtpCommand(client, "EHLO agui.local", [250], zh);
    }
    await smtpAuthenticate(client, account.username, password, zh);
    await smtpCommand(client, "QUIT", [221], zh).catch(() => undefined);
    return {
      message: mailText("smtpConnected", zh),
      ok: true,
    };
  } finally {
    if (client) client.destroy();
  }
}

export async function sendSmtpMessage(
  account: MailAccount,
  password: string,
  message: SendMailMessage,
  zh: boolean,
) {
  let client;
  const recipients = [...message.to, ...message.cc, ...message.bcc].map((item) =>
    extractEmailAddress(item),
  );
  const from = extractEmailAddress(message.from);
  const messageId = createMessageId(from, account.outgoingHost);
  try {
    client = await LineSocket.connect({
      host: account.outgoingHost,
      port: account.outgoingPort,
      rejectUnauthorized: account.rejectUnauthorized,
      secure: account.outgoingSecurity === "tls",
      servername: account.outgoingHost,
      timeoutMs: CONNECTION_TIMEOUT_MS,
    });
    await readSmtpResponse(client, [220], zh);
    await smtpCommand(client, "EHLO agui.local", [250], zh);
    if (account.outgoingSecurity === "starttls") {
      await smtpCommand(client, "STARTTLS", [220], zh);
      await client.upgradeTls({
        rejectUnauthorized: account.rejectUnauthorized,
        servername: account.outgoingHost,
      });
      await smtpCommand(client, "EHLO agui.local", [250], zh);
    }
    await smtpAuthenticate(client, account.username, password, zh);
    await smtpCommand(client, `MAIL FROM:<${from}>`, [250], zh);
    for (const recipient of recipients) {
      await smtpCommand(client, `RCPT TO:<${recipient}>`, [250, 251], zh);
    }
    await smtpCommand(client, "DATA", [354], zh);
    client.writeRaw(`${dotStuff(buildMimeMessage(message, messageId))}\r\n.\r\n`);
    await readSmtpResponse(client, [250], zh);
    await smtpCommand(client, "QUIT", [221], zh).catch(() => undefined);
    return {
      accepted: recipients,
      from,
      message: mailText("messageSent", zh),
      messageId,
      ok: true,
    };
  } finally {
    if (client) client.destroy();
  }
}

export function mailSendMessageFromInput(
  input,
  account: MailAccount,
  zh: boolean,
): SendMailMessage {
  const payload = objectValue(input);
  const to = recipientList(payload.to, "to");
  const cc = recipientList(payload.cc, "cc");
  const bcc = recipientList(payload.bcc, "bcc");
  if (!to.length && !cc.length && !bcc.length) throw new Error(mailText("missingRecipients", zh));
  if (to.length + cc.length + bcc.length > MAX_SEND_RECIPIENTS) {
    throw new Error(mailText("tooManyRecipients", zh));
  }
  const subject = boundedRequiredText(payload.subject, "subject", MAX_SEND_SUBJECT_BYTES);
  const body = boundedRequiredText(payload.body, "body", MAX_SEND_BODY_BYTES);
  const bodyFormat = payload.bodyFormat === "html" ? "html" : "text";
  const from = senderForMessage(payload.from, account, zh);
  const replyTo = optionalText(payload.replyTo);
  if (replyTo) extractEmailAddress(replyTo);
  return {
    bcc,
    body,
    bodyFormat,
    cc,
    from,
    replyTo,
    subject,
    to,
  };
}

function recipientList(value, name): string[] {
  if (value === undefined || value === null || value === "") return [];
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : (() => {
          throw new Error(`${name} must be a string or an array of strings.`);
        })();
  return raw
    .map((item) => optionalText(item))
    .filter(Boolean)
    .map((item) => {
      if (Buffer.byteLength(item, "utf8") > 512) {
        throw new Error(`${name} contains an address that is too long.`);
      }
      extractEmailAddress(item);
      return item;
    });
}

function senderForMessage(value, account: MailAccount, zh: boolean) {
  const fallback = senderAddress(account);
  const requested = optionalText(value);
  if (!requested) return fallback;
  const requestedEmail = extractEmailAddress(requested).toLowerCase();
  const allowed = new Set(
    [account.email, account.username].filter(Boolean).map((item) => item.toLowerCase()),
  );
  if (!allowed.has(requestedEmail)) throw new Error(mailText("fromNotAllowed", zh));
  return requested;
}

function buildMimeMessage(message: SendMailMessage, messageId: string) {
  const headers = [
    ["From", formatAddress(message.from)],
    ["To", message.to.map(formatAddress).join(", ")],
    ...(message.cc.length ? [["Cc", message.cc.map(formatAddress).join(", ")]] : []),
    ...(message.replyTo ? [["Reply-To", formatAddress(message.replyTo)]] : []),
    ["Subject", encodeHeader(message.subject)],
    ["Date", new Date().toUTCString()],
    ["Message-ID", messageId],
    ["MIME-Version", "1.0"],
    [
      "Content-Type",
      `${message.bodyFormat === "html" ? "text/html" : "text/plain"}; charset=UTF-8`,
    ],
    ["Content-Transfer-Encoding", "base64"],
  ];
  return normalizeCrlf(
    `${headers
      .filter(([, value]) => value)
      .map(([key, value]) => `${key}: ${value}`)
      .join("\r\n")}\r\n\r\n${wrapBase64(Buffer.from(message.body, "utf8").toString("base64"))}`,
  );
}

function dotStuff(value: string) {
  return normalizeCrlf(value)
    .split("\r\n")
    .map((line) => (line.startsWith(".") ? `.${line}` : line))
    .join("\r\n");
}

function normalizeCrlf(value: string) {
  return value.replace(/\r?\n/g, "\r\n");
}

function senderAddress(account: MailAccount) {
  return account.displayName && account.email
    ? `${account.displayName} <${account.email}>`
    : account.email || account.username;
}

function extractEmailAddress(value: string) {
  const text = singleLineString(value).trim();
  const bracket = /<([^<>]+)>/.exec(text);
  const email = (bracket ? bracket[1] : text).trim();
  if (!/^[^<>\s@]+@[^<>\s@]+$/.test(email)) {
    throw new Error(`Invalid email address: ${text}`);
  }
  return email;
}

function formatAddress(value: string) {
  const text = singleLineString(value).trim();
  const bracket = /^(.*?)<([^<>]+)>$/.exec(text);
  if (!bracket) return extractEmailAddress(text);
  const name = bracket[1].trim().replace(/^"|"$/g, "");
  const email = extractEmailAddress(bracket[2]);
  return name ? `${encodeAddressName(name)} <${email}>` : email;
}

function encodeHeader(value: string) {
  const text = singleLineString(value).trim();
  if (!/[^\x20-\x7e]/.test(text)) return text;
  return `=?UTF-8?B?${Buffer.from(text, "utf8").toString("base64")}?=`;
}

function encodeAddressName(value: string) {
  const text = singleLineString(value).trim();
  if (/[^\x20-\x7e]/.test(text)) return encodeHeader(text);
  if (!/[",;<>@()[\]:\\]/.test(text)) return text;
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function wrapBase64(value: string) {
  const lines = [];
  for (let index = 0; index < value.length; index += 76) lines.push(value.slice(index, index + 76));
  return lines.join("\r\n");
}

function createMessageId(from: string, host: string) {
  const domain = from.includes("@") ? from.split("@").pop() || host : host;
  return `<${Date.now()}.${Math.random().toString(36).slice(2)}@${domain || "agui.local"}>`;
}

async function connectPop3(
  account: MailAccount,
  password: string,
  zh: boolean,
): Promise<Pop3Session> {
  const client = await LineSocket.connect({
    host: account.incomingHost,
    port: account.incomingPort,
    rejectUnauthorized: account.rejectUnauthorized,
    secure: account.incomingSecurity === "tls",
    servername: account.incomingHost,
    timeoutMs: CONNECTION_TIMEOUT_MS,
  });
  try {
    const greeting = await client.readLine();
    if (!greeting.startsWith("+OK")) throw new Error(popError(greeting, zh));
    if (account.incomingSecurity === "starttls") {
      await popCommand(client, "STLS", false, zh);
      await client.upgradeTls({
        rejectUnauthorized: account.rejectUnauthorized,
        servername: account.incomingHost,
      });
    }
    await popCommand(client, `USER ${protocolValue(account.username)}`, false, zh);
    await popCommand(client, `PASS ${protocolValue(password)}`, false, zh);
    return new Pop3Session(client, zh);
  } catch (error) {
    client.destroy();
    throw error;
  }
}

class Pop3Session {
  client: LineSocket;
  zh: boolean;

  constructor(client: LineSocket, zh: boolean) {
    this.client = client;
    this.zh = zh;
  }

  async stat() {
    const response = await popCommand(this.client, "STAT", false, this.zh);
    const match = /^\+OK\s+(\d+)\s+(\d+)/i.exec(response.first);
    return {
      count: match ? Number(match[1]) : 0,
      size: match ? Number(match[2]) : 0,
    };
  }

  async list() {
    const response = await popCommand(this.client, "LIST", true, this.zh);
    const entries = new Map();
    for (const line of response.lines) {
      const match = /^(\d+)\s+(\d+)/.exec(line.trim());
      if (match) entries.set(Number(match[1]), Number(match[2]));
    }
    return entries;
  }

  async uidl() {
    const response = await popCommand(this.client, "UIDL", true, this.zh);
    const entries = new Map();
    for (const line of response.lines) {
      const match = /^(\d+)\s+(.+)$/.exec(line.trim());
      if (match) entries.set(Number(match[1]), match[2].trim());
    }
    return entries;
  }

  async top(number, lines) {
    const response = await popCommand(
      this.client,
      `TOP ${Math.max(1, Number(number || 1))} ${Math.max(0, Number(lines || 0))}`,
      true,
      this.zh,
    );
    return response.lines;
  }

  async quit() {
    try {
      await popCommand(this.client, "QUIT", false, this.zh);
    } finally {
      this.client.destroy();
    }
  }
}

class LineSocket {
  buffer: string;
  closedError: Error | null;
  lineQueue: string[];
  onClose: () => void;
  onData: (chunk: Buffer | string) => void;
  onError: (error: Error) => void;
  socket: net.Socket | tls.TLSSocket;
  timeoutMs: number;
  waiters: LineWaiter[];

  constructor(socket: net.Socket | tls.TLSSocket, timeoutMs: number) {
    this.buffer = "";
    this.closedError = null;
    this.lineQueue = [];
    this.timeoutMs = timeoutMs;
    this.waiters = [];
    this.onData = (chunk) => this.handleData(chunk);
    this.onError = (error) => this.fail(error);
    this.onClose = () => this.fail(new Error("Connection closed."));
    this.socket = socket;
    this.attach(socket);
  }

  static connect({
    host,
    port,
    rejectUnauthorized,
    secure,
    servername,
    timeoutMs,
  }: LineSocketConnectOptions): Promise<LineSocket> {
    return new Promise((resolve, reject) => {
      const options = {
        host,
        port,
        rejectUnauthorized,
        servername: servername || host,
      };
      const socket = secure
        ? tls.connect(options)
        : net.connect({
            host,
            port,
          });
      const client = new LineSocket(socket, timeoutMs);
      const readyEvent = secure ? "secureConnect" : "connect";
      let settled = false;
      const cleanup = () => {
        socket.off(readyEvent, ready);
        socket.off("error", fail);
        socket.off("timeout", timeout);
      };
      const ready = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(client);
      };
      const fail = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        client.destroy();
        reject(error);
      };
      const timeout = () => fail(new Error(`Connection to ${host}:${port} timed out.`));
      socket.once(readyEvent, ready);
      socket.once("error", fail);
      socket.once("timeout", timeout);
      socket.setTimeout(timeoutMs);
    });
  }

  attach(socket: net.Socket | tls.TLSSocket) {
    socket.setEncoding("utf8");
    socket.on("data", this.onData);
    socket.on("error", this.onError);
    socket.on("close", this.onClose);
    socket.setTimeout(this.timeoutMs, () => {
      this.fail(new Error("Connection timed out."));
      socket.destroy();
    });
  }

  detach(socket: net.Socket | tls.TLSSocket) {
    socket.off("data", this.onData);
    socket.off("error", this.onError);
    socket.off("close", this.onClose);
    socket.setTimeout(0);
  }

  upgradeTls({ rejectUnauthorized, servername }: TlsUpgradeOptions): Promise<void> {
    const previous = this.socket;
    this.detach(previous);
    this.buffer = "";
    this.lineQueue = [];
    return new Promise((resolve, reject) => {
      const socket = tls.connect({
        rejectUnauthorized,
        servername,
        socket: previous,
      });
      this.socket = socket;
      this.attach(socket);
      let settled = false;
      const cleanup = () => {
        socket.off("secureConnect", ready);
        socket.off("error", fail);
      };
      const ready = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const fail = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      socket.once("secureConnect", ready);
      socket.once("error", fail);
    });
  }

  writeLine(line: string) {
    this.socket.write(`${line}\r\n`);
  }

  writeRaw(value: string) {
    this.socket.write(value);
  }

  readLine(): Promise<string> {
    if (this.lineQueue.length > 0) return Promise.resolve(this.lineQueue.shift());
    if (this.closedError) return Promise.reject(this.closedError);
    return new Promise((resolve, reject) => {
      const waiter = {} as LineWaiter;
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((item) => item !== waiter);
        reject(new Error("Timed out waiting for server response."));
      }, this.timeoutMs);
      waiter.reject = (error) => {
        clearTimeout(timer);
        reject(error);
      };
      waiter.resolve = (line) => {
        clearTimeout(timer);
        resolve(line);
      };
      this.waiters.push(waiter);
      this.flushWaiters();
    });
  }

  handleData(chunk: Buffer | string) {
    this.buffer += chunk.toString("utf8");
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      let line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.lineQueue.push(line);
    }
    this.flushWaiters();
  }

  flushWaiters() {
    while (this.waiters.length > 0 && this.lineQueue.length > 0) {
      const waiter = this.waiters.shift();
      waiter.resolve(this.lineQueue.shift());
    }
  }

  fail(error: Error) {
    if (this.closedError) return;
    this.closedError = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  destroy() {
    try {
      this.detach(this.socket);
    } catch {
      // Ignore detach errors during cleanup.
    }
    this.socket.destroy();
  }
}

async function popCommand(client, line, multiline, zh) {
  client.writeLine(line);
  const first = await client.readLine();
  if (!first.startsWith("+OK")) throw new Error(popError(first, zh));
  if (!multiline) return { first, lines: [] };
  const lines = [];
  while (true) {
    const next = await client.readLine();
    if (next === ".") break;
    lines.push(next.startsWith("..") ? next.slice(1) : next);
  }
  return { first, lines };
}

function popError(line, zh) {
  const detail = line.replace(/^-ERR\s*/i, "").trim() || line.trim();
  return `${mailText("popError", zh)}${detail ? `: ${detail}` : ""}`;
}

async function smtpCommand(client, line, expectedCodes, zh) {
  client.writeLine(line);
  return readSmtpResponse(client, expectedCodes, zh);
}

async function readSmtpResponse(client, expectedCodes, zh) {
  const lines = [];
  let code = 0;
  for (let index = 0; index < MAX_SMTP_RESPONSE_LINES; index += 1) {
    const line = await client.readLine();
    lines.push(line);
    const match = /^(\d{3})([\s-])(.*)$/.exec(line);
    if (!match) break;
    code = Number(match[1]);
    if (match[2] === " ") break;
  }
  if (!expectedCodes.includes(code)) {
    throw new Error(`${mailText("smtpError", zh)}${code ? ` ${code}` : ""}: ${smtpMessage(lines)}`);
  }
  return {
    code,
    message: smtpMessage(lines),
  };
}

async function smtpAuthenticate(client, username, password, zh) {
  const plain = Buffer.from(`\u0000${username}\u0000${password}`, "utf8").toString("base64");
  try {
    await smtpCommand(client, `AUTH PLAIN ${plain}`, [235], zh);
    return;
  } catch {
    // Some providers advertise AUTH PLAIN but reject initial responses. Try AUTH LOGIN too.
  }
  await smtpCommand(client, "AUTH LOGIN", [334], zh);
  await smtpCommand(client, Buffer.from(username, "utf8").toString("base64"), [334], zh);
  await smtpCommand(client, Buffer.from(password, "utf8").toString("base64"), [235], zh);
}

function smtpMessage(lines) {
  return lines
    .map((line) => line.replace(/^\d{3}[\s-]?/, "").trim())
    .filter(Boolean)
    .join(" ");
}

function parsePopMessage({ account, lines, number, size, uid, zh }): MailMessage {
  const { bodyLines, headers } = splitMessage(lines);
  const subject = cleanHeader(headers.subject) || mailText("noSubject", zh);
  const from = cleanHeader(headers.from);
  const to = cleanHeader(headers.to);
  const date = cleanHeader(headers.date);
  const messageId = cleanHeader(headers["message-id"]);
  const preview = bodyPreview(bodyLines, headers);
  return {
    accountEmail: account.email,
    date,
    from,
    messageId,
    number,
    preview,
    size,
    subject,
    to,
    uid,
  };
}

function splitMessage(lines): { bodyLines: string[]; headers: Record<string, string> } {
  const rawHeaders = [];
  const bodyLines = [];
  let inBody = false;
  for (const line of lines) {
    if (!inBody && line === "") {
      inBody = true;
      continue;
    }
    if (inBody) bodyLines.push(line);
    else rawHeaders.push(line);
  }

  const unfolded = [];
  for (const line of rawHeaders) {
    if (/^\s/.test(line) && unfolded.length > 0) {
      unfolded[unfolded.length - 1] += ` ${line.trim()}`;
    } else {
      unfolded.push(line);
    }
  }

  const headers: Record<string, string> = {};
  for (const line of unfolded) {
    const index = line.indexOf(":");
    if (index <= 0) continue;
    const key = line.slice(0, index).trim().toLowerCase();
    const value = line.slice(index + 1).trim();
    if (key && headers[key] == null) headers[key] = value;
  }
  return { bodyLines, headers };
}

function bodyPreview(lines, headers) {
  const value = previewFromMimePart(lines, headers, 0);
  return value.length > MAX_PREVIEW_CHARS ? `${value.slice(0, MAX_PREVIEW_CHARS)}...` : value;
}

function previewFromMimePart(lines, headers, depth) {
  if (depth > 4) return "";
  const contentType = parseContentType(headers["content-type"]);
  if (contentType.mediaType.startsWith("multipart/") && contentType.params.boundary) {
    const parts = splitMultipartParts(lines, contentType.params.boundary);
    const parsed = parts.map((partLines) => {
      const part = splitMessage(partLines);
      return {
        headers: part.headers,
        preview: previewFromMimePart(part.bodyLines, part.headers, depth + 1),
        type: parseContentType(part.headers["content-type"]).mediaType,
      };
    });
    return (
      parsed.find((part) => part.type === "text/plain" && part.preview)?.preview ||
      parsed.find((part) => part.type === "text/html" && part.preview)?.preview ||
      parsed.find((part) => part.preview)?.preview ||
      ""
    );
  }
  const disposition = cleanHeader(headers["content-disposition"]).toLowerCase();
  if (disposition.startsWith("attachment")) return "";
  if (
    contentType.mediaType &&
    !contentType.mediaType.startsWith("text/") &&
    contentType.mediaType !== "message/rfc822"
  ) {
    return "";
  }
  let value = decodedBodyText(lines, headers, contentType.params.charset);
  if (contentType.mediaType.includes("html") || /<\/?[a-z][\s\S]*>/i.test(value)) {
    value = stripHtml(value);
  }
  return normalizePreviewText(value);
}

function decodedBodyText(lines, headers, charset) {
  const encoding = cleanHeader(headers["content-transfer-encoding"]).toLowerCase();
  const raw = lines.join("\n").trim();
  if (!raw) return "";
  if (encoding.includes("base64")) {
    const normalized = raw.replace(/\s+/g, "");
    if (normalized.length > 0 && normalized.length < 512 * 1024) {
      return decodeBufferWithCharset(Buffer.from(normalized, "base64"), charset);
    }
  }
  if (encoding.includes("quoted-printable")) {
    return decodeBufferWithCharset(decodeQuotedPrintableBuffer(raw), charset);
  }
  return raw;
}

function normalizePreviewText(value) {
  return value
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function parseContentType(value) {
  const [type = "", ...params] = stringValue(value).split(";");
  const result: { mediaType: string; params: Record<string, string> } = {
    mediaType: type.trim().toLowerCase() || "text/plain",
    params: {},
  };
  for (const param of params) {
    const index = param.indexOf("=");
    if (index <= 0) continue;
    const key = param.slice(0, index).trim().toLowerCase();
    const rawValue = param
      .slice(index + 1)
      .trim()
      .replace(/^"|"$/g, "");
    if (key) result.params[key] = rawValue;
  }
  return result;
}

function splitMultipartParts(lines, boundary) {
  const marker = `--${boundary}`;
  const closeMarker = `--${boundary}--`;
  const parts = [];
  let current = null;
  for (const line of lines) {
    if (line === marker || line === closeMarker) {
      if (current?.length) parts.push(current);
      current = line === closeMarker ? null : [];
      continue;
    }
    if (current) current.push(line);
  }
  if (current?.length) parts.push(current);
  return parts;
}

function mailMessageNode(message: MailMessage, zh: boolean) {
  const identity = message.uid || message.messageId || `${message.number}`;
  const id = `${NAMESPACE}.message.${message.number}.${hashString(identity)}`;
  const subtitle = message.from || message.date || bytesLabel(message.size) || "";
  return {
    id,
    title: message.subject,
    icon: "mail",
    kind: "session",
    badge: message.date ? shortDateLabel(message.date) : undefined,
    description: subtitle,
    session: {
      title: message.subject,
      renderer: MAIL_RENDERER,
      initialMarkdown: messageMarkdown(message, zh),
      developerInstructions: mailDeveloperInstructions(message, zh),
      metadata: {
        provider: "mail",
        kind: "message",
        accountEmail: message.accountEmail,
        date: message.date,
        from: message.from,
        number: message.number,
        preview: message.preview,
        size: message.size,
        subject: message.subject,
        to: message.to,
        uid: message.uid,
      },
    },
  };
}

function messageMarkdown(message, zh) {
  const lines = [
    `### ${message.subject}`,
    "",
    `**${zh ? "发件人" : "From"}:** ${message.from || "-"}`,
    `**${zh ? "收件人" : "To"}:** ${message.to || "-"}`,
    `**${zh ? "日期" : "Date"}:** ${message.date || "-"}`,
    `**${zh ? "大小" : "Size"}:** ${bytesLabel(message.size) || "-"}`,
  ];
  if (message.preview) {
    lines.push("", `#### ${zh ? "预览" : "Preview"}`, "", message.preview);
  }
  return lines.join("\n");
}

function mailDeveloperInstructions(message, zh) {
  if (zh) {
    return `当前虚拟会话绑定到邮箱 ${message.accountEmail || "当前账号"} 中的一封 POP3 邮件。邮件主题：${message.subject}。用户要求处理该邮件时，只能基于会话里展示的邮件元数据和预览内容回答；除非后续工具明确执行成功，不要声称已经发送、删除、归档或修改邮件。`;
  }
  return `This virtual session is scoped to a POP3 email message in ${message.accountEmail || "the configured account"}. Subject: ${message.subject}. Use only the displayed message metadata and preview unless another tool fetches more data, and do not claim that mail was sent, deleted, archived, or modified unless a later tool call succeeds.`;
}

function setupMarkdown(zh) {
  return zh
    ? "### 配置邮箱\n\n在插件设置中填写邮箱地址、POP3 收件服务器、SMTP 发件服务器和应用密码或授权码。许多邮箱服务商需要先在网页设置里启用 POP3，并生成专用应用密码。"
    : "### Configure Mail\n\nOpen the extension settings and enter your email address, POP3 incoming server, SMTP outgoing server, and an app password or authorization code. Many providers require POP3 to be enabled first.";
}

function infoSessionNode(id, title, description, markdown, zh) {
  return {
    id,
    title,
    description,
    icon: "mail",
    kind: "session",
    session: {
      title,
      initialMarkdown: markdown,
      developerInstructions: zh
        ? "当前会话用于配置邮箱插件，不代表已经连接或读取邮箱。"
        : "This session is for configuring the Mail extension and does not imply mailbox access.",
      metadata: {
        provider: "mail",
        kind: "setup",
      },
    },
  };
}

function emptyFolderNode(id, title, zh) {
  return {
    id,
    title,
    icon: "inbox",
    kind: "session",
    session: {
      title,
      initialMarkdown: `### ${title}`,
      developerInstructions: zh
        ? "当前邮箱列表没有可用邮件。"
        : "The current mailbox list has no available messages.",
      metadata: {
        provider: "mail",
        kind: "empty",
      },
    },
  };
}

function errorSessionNode(id, title, message, zh) {
  return {
    id,
    title,
    icon: "circle-alert",
    kind: "session",
    badge: zh ? "错误" : "error",
    description: message,
    session: {
      title,
      initialMarkdown: `### ${title}\n\n${message}`,
      developerInstructions: zh
        ? "当前会话描述邮箱插件遇到的连接或读取错误。"
        : "This session describes a connection or read error from the Mail extension.",
      metadata: {
        provider: "mail",
        kind: "error",
        message,
      },
    },
  };
}

function accountLabel(account, zh) {
  return (
    account.displayName || account.email || account.username || (zh ? "邮箱账号" : "Mail account")
  );
}

function connectionLabel(host, port, security) {
  if (!host) return "";
  return `${host}:${port} ${security.toUpperCase()}`;
}

function protocolValue(value) {
  return singleLineString(value).replace(/\0/g, "");
}

function singleLineString(value) {
  return stringValue(value).replace(/[\r\n]/g, "");
}

function requiredText(value, name) {
  const text = optionalText(value);
  if (!text) throw new Error(`${name} is required.`);
  return text;
}

function boundedRequiredText(value, name, maxBytes) {
  const text = requiredText(value, name);
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new Error(`${name} must be no larger than ${maxBytes} bytes.`);
  }
  return text;
}

function optionalText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function hostnameValue(value) {
  return singleLineString(value)
    .trim()
    .replace(/^\[|\]$/g, "");
}

function mailSecurity(value, fallback) {
  return value === "plain" || value === "starttls" || value === "tls" ? value : fallback;
}

function defaultPopPort(security) {
  return security === "tls" ? 995 : 110;
}

function defaultSmtpPort(security) {
  if (security === "tls") return 465;
  if (security === "starttls") return 587;
  return 25;
}

function clampPort(value, fallback) {
  return clampNumber(Number(value || fallback), 1, 65535, fallback);
}

function clampNumber(value, min, max, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stringValue(value) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function inputLanguageZh(input) {
  return stringValue(objectValue(input).language) === "zh";
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function cleanHeader(value) {
  return decodeMimeWords(stringValue(value)).replace(/\s+/g, " ").trim();
}

function decodeMimeWords(value) {
  return value.replace(/=\?([^?]+)\?([bqBQ])\?([^?]*)\?=/g, (_match, charset, encoding, text) => {
    try {
      const bytes =
        encoding.toLowerCase() === "b" ? Buffer.from(text, "base64") : qEncodedBytes(text);
      return decodeBufferWithCharset(bytes, charset);
    } catch {
      return text;
    }
  });
}

function qEncodedBytes(value) {
  const bytes = [];
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "_") {
      bytes.push(32);
      continue;
    }
    if (character === "=" && /^[0-9a-fA-F]{2}$/.test(value.slice(index + 1, index + 3))) {
      bytes.push(Number.parseInt(value.slice(index + 1, index + 3), 16));
      index += 2;
      continue;
    }
    bytes.push(character.charCodeAt(0));
  }
  return Buffer.from(bytes);
}

function decodeQuotedPrintableBuffer(value) {
  const joined = value.replace(/=\r?\n/g, "");
  const bytes = [];
  for (let index = 0; index < joined.length; index += 1) {
    const character = joined[index];
    if (character === "=" && /^[0-9a-fA-F]{2}$/.test(joined.slice(index + 1, index + 3))) {
      bytes.push(Number.parseInt(joined.slice(index + 1, index + 3), 16));
      index += 2;
      continue;
    }
    bytes.push(character.charCodeAt(0));
  }
  return Buffer.from(bytes);
}

function decodeBufferWithCharset(bytes, charset) {
  const normalized = stringValue(charset).trim().toLowerCase().replace(/^"|"$/g, "");
  const candidates =
    normalized === "gb2312" || normalized === "gbk" || normalized === "gb18030"
      ? ["gb18030", "gbk"]
      : normalized === "big5" || normalized === "big-5"
        ? ["big5"]
        : normalized === "iso-8859-1" || normalized === "latin1"
          ? ["iso-8859-1", "windows-1252"]
          : normalized
            ? [normalized]
            : ["utf-8"];
  for (const candidate of candidates) {
    try {
      return new TextDecoder(candidate, { fatal: false }).decode(bytes);
    } catch {
      // Try the next compatible label.
    }
  }
  return bytes.toString("utf8");
}

function stripHtml(value) {
  return value
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function bytesLabel(size) {
  const value = Number(size || 0);
  if (!Number.isFinite(value) || value <= 0) return "";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function shortDateLabel(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

function nodeSlug(value) {
  const slug = stringValue(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || hashString(value);
}

function hashString(value) {
  const text = stringValue(value);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function mailText(key, zh) {
  const text = {
    missingIncomingConfig: {
      en: "Configure the POP3 host, username, and password first.",
      zh: "请先配置 POP3 主机、用户名和密码。",
    },
    missingOutgoingConfig: {
      en: "Configure the SMTP host, username, and password first.",
      zh: "请先配置 SMTP 主机、用户名和密码。",
    },
    missingRecipients: {
      en: "At least one recipient is required.",
      zh: "至少需要一个收件人。",
    },
    messageSent: {
      en: "Message sent.",
      zh: "邮件已发送。",
    },
    fromNotAllowed: {
      en: "From must use the configured mail account address.",
      zh: "From 必须使用已配置的邮箱账号地址。",
    },
    tooManyRecipients: {
      en: "A message can include at most 100 recipients.",
      zh: "单封邮件最多支持 100 个收件人。",
    },
    noSubject: {
      en: "(no subject)",
      zh: "(无主题)",
    },
    popConnected: {
      en: "POP3 login succeeded. {count} message(s) are available.",
      zh: "POP3 登录成功，可读取 {count} 封邮件。",
    },
    popError: {
      en: "POP3 error",
      zh: "POP3 错误",
    },
    smtpConnected: {
      en: "SMTP authentication succeeded.",
      zh: "SMTP 鉴权成功。",
    },
    smtpError: {
      en: "SMTP error",
      zh: "SMTP 错误",
    },
    smtpSkipped: {
      en: "SMTP host is not configured.",
      zh: "未配置 SMTP 主机。",
    },
  };
  return text[key]?.[zh ? "zh" : "en"] || key;
}
