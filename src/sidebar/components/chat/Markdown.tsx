import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Renders assistant chat responses as GitHub-flavored markdown.
 *
 * Security: react-markdown escapes raw HTML by default (it never uses
 * `dangerouslySetInnerHTML`), so prompt-injected HTML payloads are rendered
 * as inert text. Links are additionally restricted to http(s) and forced to
 * open in a new tab.
 */
const components: Components = {
  a({ href, children, ...props }) {
    // Only allow http(s) links; everything else (javascript:, file:, relative
    // URLs, …) is rendered as plain text so it can never navigate the browser.
    const safe = href !== undefined && /^https?:\/\//i.test(href);
    if (!safe) {
      return <span {...props}>{children}</span>;
    }
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
        {children}
      </a>
    );
  },
  code({ className, children, ...props }) {
    // Fenced code blocks arrive with a `language-xxx` class; expose the
    // language as a data attribute so CSS can render a small label.
    const language = /language-([\w-]+)/.exec(className ?? "")?.[1];
    return (
      <code {...props} data-language={language}>
        {children}
      </code>
    );
  },
  pre({ children }) {
    return <pre>{children}</pre>;
  },
};

interface Props {
  content: string;
}

export const Markdown = memo(function Markdown({ content }: Props): JSX.Element {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
});
