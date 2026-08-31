import Parser, { type SyntaxNode } from "tree-sitter";
import TypeScript from "tree-sitter-typescript";

export type ToolReferenceSource =
  | "callTool"
  | "context.callTool"
  | "mcp.member"
  | "namespace.member"
  | "namespace.subscript"
  | "tools.call"
  | "tools.member"
  | "tools.subscript";

export type ToolReference = {
  column: number;
  line: number;
  rawName: string;
  source: ToolReferenceSource;
};

export class TreeSitterToolAnalyzer {
  private readonly parser: Parser;

  constructor() {
    this.parser = new Parser();
    this.parser.setLanguage(TypeScript.typescript);
  }

  collectReferences(code: string): ToolReference[] {
    if (!code.trim()) return [];
    const tree = this.parser.parse(code);
    const references: ToolReference[] = [];
    this.walkNode(tree.rootNode, code, references);
    return references;
  }

  collectToolTokens(code: string): string[] {
    const seen = new Set<string>();
    const tokens: string[] = [];
    for (const reference of this.collectReferences(code)) {
      if (seen.has(reference.rawName)) continue;
      seen.add(reference.rawName);
      tokens.push(reference.rawName);
    }
    return tokens;
  }

  private walkNode(node: SyntaxNode, code: string, output: ToolReference[]): void {
    if (node.type === "call_expression") {
      this.extractFromCallExpression(node, code, output);
    }
    for (let index = 0; index < node.namedChildCount; index += 1) {
      const child = node.namedChild(index);
      if (child) this.walkNode(child, code, output);
    }
  }

  private extractFromCallExpression(node: SyntaxNode, code: string, output: ToolReference[]): void {
    const functionNode = node.childForFieldName("function");
    const argsNode = node.childForFieldName("arguments");
    if (!functionNode || !argsNode) return;

    if (functionNode.type === "identifier") {
      if (this.nodeText(functionNode, code) === "callTool") {
        const toolName = this.extractStringFromArgs(argsNode, code, 0);
        if (toolName) output.push(this.buildReference(toolName, "callTool", node));
      }
      return;
    }

    const path = this.extractCallablePath(functionNode, code);
    if (!path?.length) return;

    const lastPart = path[path.length - 1];
    if (lastPart === "callTool") {
      const toolName = this.extractStringFromArgs(argsNode, code, 0);
      if (toolName) output.push(this.buildReference(toolName, "context.callTool", node));
      return;
    }

    if (path[0] === "tools") {
      if (path.length === 2 && path[1] === "call") {
        const toolName = this.extractStringFromArgs(argsNode, code, 0);
        if (toolName) output.push(this.buildReference(toolName, "tools.call", node));
        return;
      }
      const toolName = path.slice(1).join(".");
      if (toolName) {
        output.push(
          this.buildReference(
            toolName,
            functionNode.type === "subscript_expression" ? "tools.subscript" : "tools.member",
            node,
          ),
        );
      }
      return;
    }

    if (path[0] === "mcp" && path.length >= 3) {
      output.push(this.buildReference(path.join("."), "mcp.member", node));
      return;
    }

    if (path.length >= 2) {
      output.push(
        this.buildReference(
          path.join("."),
          functionNode.type === "subscript_expression" ? "namespace.subscript" : "namespace.member",
          node,
        ),
      );
    }
  }

  private extractStringFromArgs(
    argsNode: SyntaxNode,
    code: string,
    argumentIndex: number,
  ): string | undefined {
    const valueNode = argsNode.namedChild(argumentIndex);
    return valueNode ? this.extractStringNode(valueNode, code) : undefined;
  }

  private extractStringNode(node: SyntaxNode, code: string): string | undefined {
    if (node.type === "string") return unquoteString(this.nodeText(node, code));
    if (node.type === "template_string" && node.namedChildCount === 1) {
      const onlyChild = node.namedChild(0);
      if (onlyChild?.type === "string_fragment") return this.nodeText(onlyChild, code);
    }
    return undefined;
  }

  private extractCallablePath(node: SyntaxNode, code: string): string[] | undefined {
    if (node.type === "identifier" || node.type === "property_identifier") {
      const text = this.nodeText(node, code).trim();
      return text ? [text] : undefined;
    }
    if (node.type === "member_expression") {
      const objectNode = node.childForFieldName("object");
      const propertyNode = node.childForFieldName("property");
      if (!objectNode || !propertyNode) return undefined;
      const objectPath = this.extractCallablePath(objectNode, code);
      const propertyPath = this.extractCallablePath(propertyNode, code);
      return objectPath && propertyPath?.length === 1
        ? [...objectPath, propertyPath[0]!]
        : undefined;
    }
    if (node.type === "subscript_expression") {
      const objectNode = node.childForFieldName("object");
      const indexNode = node.childForFieldName("index");
      if (!objectNode || !indexNode) return undefined;
      const objectPath = this.extractCallablePath(objectNode, code);
      const indexValue = this.extractStringNode(indexNode, code);
      return objectPath && indexValue ? [...objectPath, indexValue] : undefined;
    }
    return undefined;
  }

  private buildReference(
    rawName: string,
    source: ToolReferenceSource,
    node: SyntaxNode,
  ): ToolReference {
    return {
      column: node.startPosition.column + 1,
      line: node.startPosition.row + 1,
      rawName,
      source,
    };
  }

  private nodeText(node: SyntaxNode, code: string): string {
    return code.slice(node.startIndex, node.endIndex);
  }
}

function unquoteString(raw: string): string | undefined {
  if (raw.length < 2) return undefined;
  const quote = raw[0];
  const closing = raw[raw.length - 1];
  if ((quote !== '"' && quote !== "'") || quote !== closing) return undefined;
  if (quote === '"') {
    try {
      return JSON.parse(raw) as string;
    } catch {
      return raw.slice(1, -1);
    }
  }
  return raw.slice(1, -1).replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}
