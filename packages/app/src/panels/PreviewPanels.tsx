import { useState } from "react";
import { ExternalLink, FileText, Globe } from "lucide-react";

/**
 * URL-driven iframe preview. The PDF panel renders a PDF; the web-sandbox panel
 * renders an arbitrary page in a sandboxed iframe (the AGUI `codesandbox` /
 * `web-sandbox` equivalent). Both are mock stand-ins — point them at real URLs
 * or wire them to a sandbox runtime.
 */
function UrlPreview({ initialUrl, kind }: { initialUrl: string; kind: "pdf" | "web" }) {
  const [url, setUrl] = useState(initialUrl);
  const Icon = kind === "pdf" ? FileText : Globe;
  return (
    <div className="flex h-full flex-col">
      <div className="border-border-subtle flex items-center gap-1.5 border-b p-2">
        <Icon size={14} className="text-subtle shrink-0" />
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder={kind === "pdf" ? "PDF URL" : "Web URL"}
          className="ui-field flex-1 py-1 text-[12.5px]"
        />
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="ui-icon-button h-7 w-7 rounded-md"
        >
          <ExternalLink size={14} />
        </a>
      </div>
      <iframe
        src={url}
        className="min-h-0 flex-1 bg-white"
        title={kind === "pdf" ? "PDF preview" : "Web sandbox"}
        sandbox={kind === "web" ? "allow-scripts allow-same-origin allow-forms" : undefined}
      />
    </div>
  );
}

export function PdfPreviewPanel() {
  return <UrlPreview initialUrl="https://arxiv.org/pdf/1706.03762.pdf" kind="pdf" />;
}

export function SandboxPanel() {
  return <UrlPreview initialUrl="https://example.com" kind="web" />;
}
