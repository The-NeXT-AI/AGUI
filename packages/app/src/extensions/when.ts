export type ExtensionContextValues = Record<string, string | number | boolean | null | undefined>;

export function evaluateWhen(
  expression: string | undefined,
  context: ExtensionContextValues,
): boolean {
  if (!expression?.trim()) return true;
  try {
    const tokens = tokenize(expression);
    let cursor = 0;

    const parsePrimary = (): boolean => {
      const token = tokens[cursor++];
      if (!token) return false;
      if (token === "!") return !parsePrimary();
      if (token === "(") {
        const value = parseOr();
        if (tokens[cursor++] !== ")") throw new Error("Missing closing parenthesis.");
        return value;
      }
      const left = context[token];
      const operator = tokens[cursor];
      if (operator === "==" || operator === "!=") {
        cursor += 1;
        const rawRight = tokens[cursor++];
        if (rawRight === undefined) throw new Error("Missing comparison value.");
        const right = parseLiteral(rawRight, context);
        return operator === "==" ? left === right : left !== right;
      }
      return Boolean(left);
    };

    const parseAnd = (): boolean => {
      let result = parsePrimary();
      while (tokens[cursor] === "&&") {
        cursor += 1;
        const next = parsePrimary();
        result = result && next;
      }
      return result;
    };

    const parseOr = (): boolean => {
      let result = parseAnd();
      while (tokens[cursor] === "||") {
        cursor += 1;
        const next = parseAnd();
        result = result || next;
      }
      return result;
    };

    const result = parseOr();
    return result && cursor === tokens.length;
  } catch {
    return false;
  }
}

function tokenize(expression: string): string[] {
  const tokens: string[] = [];
  const matcher = /\s*(&&|\|\||==|!=|!|\(|\)|"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s()=!&|]+)\s*/gy;
  let consumed = 0;
  while (consumed < expression.length) {
    matcher.lastIndex = consumed;
    const match = matcher.exec(expression);
    if (!match) throw new Error("Invalid when clause.");
    tokens.push(match[1]!);
    consumed = matcher.lastIndex;
  }
  return tokens;
}

function parseLiteral(
  token: string,
  context: ExtensionContextValues,
): string | number | boolean | null | undefined {
  if (
    (token.startsWith('"') && token.endsWith('"')) ||
    (token.startsWith("'") && token.endsWith("'"))
  ) {
    return token.slice(1, -1);
  }
  if (token === "true") return true;
  if (token === "false") return false;
  if (token === "null") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(token)) return Number(token);
  return token in context ? context[token] : token;
}
